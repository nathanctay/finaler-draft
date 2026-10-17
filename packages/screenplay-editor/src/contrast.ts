/**
 * Contrast arithmetic, and the one decision in this product that has to be made from it at runtime
 * rather than written down in CSS: what colour a collaborator's name reads in, given that the
 * swatch behind it is that collaborator's own participant colour.
 *
 * Both places that paint a participant's name -- `presence.ts`'s `buildRemoteCursorWidget` (the
 * remote cursor's hover label, reused by `apps/web/src/titlePageCursors.ts` for the title page's
 * cursors) and `apps/web/src/components/ParticipantIndicator.tsx` (the status bar's coloured
 * initial) -- set that swatch from an inline style, because the colour is per-participant data
 * arriving over `Awareness`, not something a stylesheet can know. Both used to pair it with a
 * hardcoded `color: #fff` in `styles.css`, which is a contrast assertion made blind: correct only
 * for the participant colours that happen to be dark enough, and nothing checked.
 *
 * `participantLabelTextColor` makes that choice from the colour instead, so the text and its
 * background can no longer drift apart.
 *
 * ## Why that choice is ranked by APCA and not by WCAG 2.x
 *
 * It was ranked by `contrastRatio` first, and that put dark ink on three of the eight colours in
 * `apps/collab/src/presence.ts`'s palette -- orange `#be865b`, teal `#10a2a0` and violet `#af79e2`.
 * Looked at side by side, white is plainly the more legible of the two on all three. That is not a
 * misperception: WCAG 2.x contrast is a ratio of relative luminances and nothing else, and it is
 * known to mis-rank light-on-colour against dark-on-colour for mid-toned, saturated backgrounds.
 * The asymmetry is easy to see on a neutral grey ramp -- WCAG flips from preferring white to
 * preferring ink at `#808080`, APCA not until `#a6a6a6`.
 *
 * `apcaContrast` models the polarity that WCAG's ratio throws away (it has separate exponents for
 * dark-on-light and light-on-dark, and a soft black clamp), and it prefers paper-white on all eight
 * palette colours -- agreeing with `contrastRatio` on five and overruling it on exactly the three
 * that looked wrong. So the ranking is made with APCA.
 *
 * ## What this does not claim
 *
 * Not conformance, under either metric. On those three colours paper-white measures 3.11-3.16:1,
 * which is below WCAG 1.4.3's 4.5:1 for normal-size text, and that is a deliberate decision
 * (Nathan's, made with both sets of numbers in front of him) to rank by the metric that predicts
 * legibility over the one that is the formal standard. Nor does APCA certify these labels: its
 * conformance is a font-size-and-weight lookup, and at the 10px/600 of `.remote-cursor-label` and
 * the 9px/700 of `.participant-avatar` the required Lc is far above the 63 those three achieve.
 * Neither standard passes a 10px label at any colour.
 *
 * This function therefore guarantees one thing only: of the two colours available, the one actually
 * used is the one that reads better. The size is the larger lever on legibility here and has not
 * been pulled; `apps/collab/src/participantPalette.test.ts` holds the palette to the floor that
 * keeps the ranking meaningful.
 *
 * `contrastRatio` stays, and stays WCAG: the caret's 1.4.11 floor and every fixed colour in
 * `apps/web/e2e/text-contrast.spec.ts` are conformance checks against a standard that is stated in
 * those terms, and APCA has no standing there.
 *
 * Deliberately in this package rather than in `apps/web`: `apps/collab` (which owns the palette)
 * and `apps/web` (which owns the status-bar indicator) have no dependency on each other, and both
 * already depend on this one -- `apps/collab/src/database.ts` and `apps/web`'s editor both import
 * from it -- so this is the only existing place the rule can live once instead of twice.
 */

/** Paper: the manuscript sheet's own background, which `styles.css` keeps white under both themes
 * (`.page`/`.title-page` set `background-color: white`, and `.dark` redefines neither). */
export const PARTICIPANT_LABEL_PAPER = '#ffffff';

/** Ink: `--text-19`, the body text colour `:root` sets and `.dark .page` restates for the sheet.
 * A literal rather than a `var()` read, for the same reason the palette itself is a literal in
 * `apps/collab/src/presence.ts`: this runs where there may be no element to resolve a custom
 * property against, and `getComputedStyle` on a detached widget would not give one. The pairing is
 * held to the stylesheet by `apps/web/e2e/text-contrast.spec.ts`, which measures the real computed
 * values in a real browser. */
export const PARTICIPANT_LABEL_INK = '#20252b';

/** `#rgb` and `#rrggbb`, the two forms this product's colours are ever written in. Returns
 * `undefined` rather than throwing for anything else, so callers can decide: the two runtime
 * callers below fall back to a legible default, while `contrastRatio` treats it as a programming
 * error. */
export function parseHexColor(value: string): readonly [number, number, number] | undefined {
  const match = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(value.trim());
  if (!match) return undefined;
  const expanded =
    match[1] === undefined
      ? match[2]!
      : match[1]
          .split('')
          .map((digit) => digit + digit)
          .join('');
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ] as const;
}

/** WCAG 2.2's own definition (Understanding SC 1.4.3), including its 0.03928 channel threshold --
 * which differs by a rounding from the sRGB specification's 0.04045 and is kept here because the
 * conformance target is the WCAG formula, not the colour-space one. */
export function relativeLuminance(color: string): number {
  const channels = parseHexColor(color);
  if (!channels) throw new RangeError(`Not a hex colour: ${color}`);
  const [red, green, blue] = channels.map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The ratio WCAG 1.4.3 (text) and 1.4.11 (non-text) are both expressed in: 1 for two identical
 * colours, 21 for black against white. Symmetric in its arguments by construction. */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * APCA's screen luminance: a plain 2.4-power curve per channel, deliberately *not* WCAG's piecewise
 * sRGB transfer function, plus a soft clamp that keeps near-blacks from reading as more contrasty
 * than they appear. This is why `relativeLuminance` above cannot be reused -- the two metrics
 * disagree about what luminance is, not merely about what to do with it.
 */
function apcaScreenLuminance(color: string): number {
  const channels = parseHexColor(color);
  if (!channels) throw new RangeError(`Not a hex colour: ${color}`);
  const [red, green, blue] = channels.map((channel) => Math.pow(channel / 255, 2.4)) as [
    number,
    number,
    number,
  ];
  const luminance = 0.2126729 * red + 0.7151522 * green + 0.072175 * blue;
  return luminance < 0.022 ? luminance + Math.pow(0.022 - luminance, 1.414) : luminance;
}

/**
 * APCA (Accessible Perceptual Contrast Algorithm) lightness contrast, as the W3C's draft states it:
 * **signed** Lc, positive for dark text on a lighter background and negative for light text on a
 * darker one, 0 where the pair is too close to rank. Magnitudes run to about +/-108 rather than
 * WCAG's 1-21, and the two scales do not convert.
 *
 * The polarity-specific exponents are the whole point: unlike a luminance ratio, this answers "is
 * white or dark better *here*" differently depending on which way round the pair is, which is what
 * makes it the right tool for `participantLabelTextColor`'s single decision. Callers that only want
 * to rank two candidates compare `Math.abs`.
 */
export function apcaContrast(text: string, background: string): number {
  const textLuminance = apcaScreenLuminance(text);
  const backgroundLuminance = apcaScreenLuminance(background);
  if (Math.abs(backgroundLuminance - textLuminance) < 0.0005) return 0;
  if (backgroundLuminance > textLuminance) {
    const contrast = (Math.pow(backgroundLuminance, 0.56) - Math.pow(textLuminance, 0.57)) * 1.14;
    return contrast < 0.1 ? 0 : (contrast - 0.027) * 100;
  }
  const contrast = (Math.pow(backgroundLuminance, 0.65) - Math.pow(textLuminance, 0.62)) * 1.14;
  return contrast > -0.1 ? 0 : (contrast + 0.027) * 100;
}

/**
 * The floor every participant colour has to clear with the text colour chosen for it, measured as
 * `|apcaContrast|`. APCA's own tables call Lc 60 the minimum for fluent body text; it is used here
 * as a palette constraint rather than a conformance claim (see this file's top comment on why these
 * labels conform to nothing at 10px), because its real job is to fail loudly if someone adds a
 * colour so pale that *neither* paper nor ink reads on it -- the one case a "pick the better of two"
 * rule cannot rescue. The palette's worst entry measures 63.3.
 */
export const PARTICIPANT_LABEL_MINIMUM_LC = 60;

/**
 * Paper-white or manuscript ink, whichever reads better on `color` by APCA -- the colour a
 * participant's name should be painted in when the participant's own colour is behind it.
 *
 * Falls back to paper-white for a colour this module cannot parse. That is not a contrast claim:
 * it is the "the label must still render" default for a value that should be impossible (the
 * collaboration server overwrites `color` on every inbound awareness update with one of its own
 * palette entries -- `apps/collab/src/presence.ts` -- and the client's own `FALLBACK_COLOR` is a
 * literal hex), preferred over throwing inside a decoration builder that runs on every cursor
 * move.
 */
export function participantLabelTextColor(color: string): string {
  if (!parseHexColor(color)) return PARTICIPANT_LABEL_PAPER;
  return Math.abs(apcaContrast(PARTICIPANT_LABEL_PAPER, color)) >=
    Math.abs(apcaContrast(PARTICIPANT_LABEL_INK, color))
    ? PARTICIPANT_LABEL_PAPER
    : PARTICIPANT_LABEL_INK;
}
