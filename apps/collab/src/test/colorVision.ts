/**
 * Colour-difference arithmetic for `participantPalette.test.ts`, and nothing else. Test-only
 * measurement apparatus -- it is deliberately outside `vitest.config.ts`'s coverage `include`
 * allowlist, which names this app's own source modules.
 *
 * Two things live here:
 *
 *  - **Dichromat simulation** (Viénot, Brettel & Mollon 1999), the standard linear-RGB
 *    approximation for protanopia, deuteranopia and tritanopia. It is an approximation, and a
 *    different published matrix set (Brettel 1997, Machado 2009) shifts the absolute numbers by a
 *    few units -- which is exactly why the thresholds in the test are floors with real headroom
 *    rather than equalities, and why the test's job is to catch a *collapse* (two palette entries
 *    simulating to the same colour, which every model agrees on) rather than to certify a precise
 *    distance.
 *  - **CIEDE2000**, the perceptual colour-difference metric the floors are expressed in. A plain
 *    Euclidean CIELAB distance (CIE76) would have done for a regression floor, but CIEDE2000 is
 *    what the palette was chosen against, so the test and the choice are measured the same way.
 *
 * Why this is here at all, rather than a hex assertion: the palette this replaced had two pairs
 * that simulate to indistinguishable colours (blue/violet under deuteranopia at dE2000 0.59 --
 * literally the same colour -- and green/teal under tritanopia at 3.74). A test pinning the eight
 * hex values would have passed on that palette forever, and will pass on any future palette the
 * moment someone updates the expected strings. This computes the property instead.
 */

const LINEAR_RGB_THRESHOLD = 0.04045;

/** D65 white point, the illuminant CIELAB is defined against here. */
const D65 = [0.95047, 1, 1.08883] as const;

/** Viénot 1999's dichromat projections, applied to *linear* sRGB (not gamma-encoded). */
const DICHROMAT_MATRICES = {
  protanopia: [
    [0.11238, 0.88762, 0],
    [0.11238, 0.88762, 0],
    [0.00401, -0.00401, 1],
  ],
  deuteranopia: [
    [0.29275, 0.70725, 0],
    [0.29275, 0.70725, 0],
    [-0.02234, 0.02234, 1],
  ],
  tritanopia: [
    [1, 0.14461, -0.14461],
    [0, 0.85924, 0.14076],
    [0, 0.85924, 0.14076],
  ],
} as const;

export type VisionType = 'normal' | keyof typeof DICHROMAT_MATRICES;

export const VISION_TYPES: readonly VisionType[] = [
  'normal',
  'protanopia',
  'deuteranopia',
  'tritanopia',
];

function channels(color: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) throw new RangeError(`Not a six-digit hex colour: ${color}`);
  const digits = match[1]!;
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

function toLinear(channel: number): number {
  const scaled = channel / 255;
  return scaled <= LINEAR_RGB_THRESHOLD ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
}

function toEncoded(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  const encoded =
    clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** The colour `color` is seen as under `vision`. `'normal'` is the identity, so callers can loop
 * over `VISION_TYPES` without special-casing it. */
export function simulate(color: string, vision: VisionType): string {
  if (vision === 'normal') return color;
  const [red, green, blue] = channels(color).map(toLinear) as [number, number, number];
  const matrix = DICHROMAT_MATRICES[vision];
  return toHex([
    toEncoded(matrix[0][0] * red + matrix[0][1] * green + matrix[0][2] * blue),
    toEncoded(matrix[1][0] * red + matrix[1][1] * green + matrix[1][2] * blue),
    toEncoded(matrix[2][0] * red + matrix[2][1] * green + matrix[2][2] * blue),
  ]);
}

function toLab(color: string): [number, number, number] {
  const [red, green, blue] = channels(color).map(toLinear) as [number, number, number];
  const xyz = [
    red * 0.4124564 + green * 0.3575761 + blue * 0.1804375,
    red * 0.2126729 + green * 0.7151522 + blue * 0.072175,
    red * 0.0193339 + green * 0.119192 + blue * 0.9503041,
  ];
  const epsilon = Math.pow(6 / 29, 3);
  const [x, y, z] = xyz.map((value, index) => {
    const ratio = value / D65[index]!;
    return ratio > epsilon ? Math.cbrt(ratio) : ratio / (3 * Math.pow(6 / 29, 2)) + 4 / 29;
  }) as [number, number, number];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const degrees = (radians: number) => (radians * 180) / Math.PI;
const radians = (deg: number) => (deg * Math.PI) / 180;

/** CIEDE2000 (CIE 142-2001), with all weighting factors at 1. */
export function colorDifference(first: string, second: string): number {
  const [l1, a1, b1] = toLab(first);
  const [l2, a2, b2] = toLab(second);
  const chroma1 = Math.hypot(a1, b1);
  const chroma2 = Math.hypot(a2, b2);
  const meanChroma = (chroma1 + chroma2) / 2;
  const meanChroma7 = Math.pow(meanChroma, 7);
  const g = 0.5 * (1 - Math.sqrt(meanChroma7 / (meanChroma7 + Math.pow(25, 7))));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = c1p === 0 ? 0 : (degrees(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = c2p === 0 ? 0 : (degrees(Math.atan2(b2, a2p)) + 360) % 360;
  const deltaL = l2 - l1;
  const deltaC = c2p - c1p;
  let deltaSmallH = 0;
  if (c1p * c2p !== 0) {
    deltaSmallH = h2p - h1p;
    if (deltaSmallH > 180) deltaSmallH -= 360;
    else if (deltaSmallH < -180) deltaSmallH += 360;
  }
  const deltaH = 2 * Math.sqrt(c1p * c2p) * Math.sin(radians(deltaSmallH / 2));
  const meanL = (l1 + l2) / 2;
  const meanCp = (c1p + c2p) / 2;
  let meanHp: number;
  if (c1p * c2p === 0) {
    meanHp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    meanHp = (h1p + h2p) / 2;
  } else {
    meanHp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(radians(meanHp - 30)) +
    0.24 * Math.cos(radians(2 * meanHp)) +
    0.32 * Math.cos(radians(3 * meanHp + 6)) -
    0.2 * Math.cos(radians(4 * meanHp - 63));
  const deltaTheta = 30 * Math.exp(-Math.pow((meanHp - 275) / 25, 2));
  const meanCp7 = Math.pow(meanCp, 7);
  const rc = 2 * Math.sqrt(meanCp7 / (meanCp7 + Math.pow(25, 7)));
  const sl = 1 + (0.015 * Math.pow(meanL - 50, 2)) / Math.sqrt(20 + Math.pow(meanL - 50, 2));
  const sc = 1 + 0.045 * meanCp;
  const sh = 1 + 0.015 * meanCp * t;
  const rt = -Math.sin(radians(2 * deltaTheta)) * rc;
  return Math.sqrt(
    Math.pow(deltaL / sl, 2) +
      Math.pow(deltaC / sc, 2) +
      Math.pow(deltaH / sh, 2) +
      rt * (deltaC / sc) * (deltaH / sh),
  );
}
