import { isMacOS } from '@tiptap/core';

/**
 * The content behind Help > Keyboard shortcuts, and -- deliberately -- the *only* content behind
 * it. The brief's own framing is blunt about why this list is short: the real key handling in this
 * app is sparse and scattered across three places (`packages/screenplay-editor/src/index.ts`'s
 * three `Mod-` bindings and its `Tab`/`Enter` element handling; `apps/web/src/smartTypeGhost.ts`'s
 * own `Tab`/`Escape`), and a hand-authored list like this one can drift from that the moment either
 * side changes without the other. `keyboardShortcuts.test.ts` is what keeps it honest: for every
 * entry here, it resolves the *actual* registered binding strings from the extension named by
 * `source` (via `@tiptap/core`'s own `getExtensionField`, the identical mechanism
 * `ExtensionManager.plugins` uses internally to turn `addKeyboardShortcuts()` into a real ProseMirror
 * keymap) and asserts every one of `bindings` is really there. A binding renamed or removed from an
 * extension, or added here without actually existing, fails that test by name -- this dialog can
 * claim nothing the code does not actually do.
 *
 * What is deliberately *not* here: `seamCaret.ts`'s own key handling (`ArrowLeft`/`ArrowRight`/
 * `Home`/`End` at a mid-block page seam) is not a shortcut in the sense this dialog means -- it is
 * a caret-affinity correctness fix for where the *native* arrow keys land at a page boundary, not a
 * chord a writer discovers and invokes on purpose, and listing "Left/Right move the caret" here
 * would be noise, not help. Likewise `elementMenu.tsx`'s own `ArrowUp`/`ArrowDown`/`Enter`/`Tab`/
 * letter bindings are real, but exist only while that specific menu is already open over an empty
 * block -- the menu's own UI already shows each option's own letter shortcut inline
 * (`ELEMENT_SHORTCUTS` in `elementMenu.tsx`, announced to screen readers too), so restating them in
 * a second, static list a writer has to remember out of context would teach the same thing worse.
 */
export interface KeyboardShortcutEntry {
  /** What the shortcut does, in one sentence. */
  readonly description: string;
  /**
   * Every raw ProseMirror-keymap binding string that performs this action -- `Mod-y` and
   * `Shift-Mod-z` both redo, so redo's entry carries both rather than silently picking one and
   * leaving the other undocumented. Rendered via `renderBinding` below.
   */
  readonly bindings: readonly string[];
  /** Which extension's `addKeyboardShortcuts()` the test resolves `bindings` against -- not shown
   * to the writer, read only by `keyboardShortcuts.test.ts`. */
  readonly source: 'screenplayYjs' | 'screenplayBlock' | 'smartTypeGhost';
}

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutEntry[] = [
  {
    description: 'Undo',
    bindings: ['Mod-z'],
    source: 'screenplayYjs',
  },
  {
    description: 'Redo',
    bindings: ['Shift-Mod-z', 'Mod-y'],
    source: 'screenplayYjs',
  },
  {
    description: 'Convert the current line — Action to Character, or Dialogue to Parenthetical',
    bindings: ['Tab'],
    source: 'screenplayBlock',
  },
  {
    description: 'Start the next line, in the element that usually follows the one you’re on',
    bindings: ['Enter'],
    source: 'screenplayBlock',
  },
  {
    description: 'Accept the inline suggestion',
    bindings: ['Tab'],
    source: 'smartTypeGhost',
  },
  {
    description: 'Dismiss the inline suggestion',
    bindings: ['Escape'],
    source: 'smartTypeGhost',
  },
];

/** `Mod` is `@tiptap/core`'s own portable modifier name, resolved to `Cmd` on Mac and `Ctrl`
 * everywhere else by the identical `isMacOS()` check `prosemirror-keymap`'s own `normalizeKeyName`
 * uses under the hood -- reusing it here, rather than a second platform sniff, is what keeps this
 * label from ever naming a key the real binding does not answer to. */
export function platformModLabel(): string {
  return isMacOS() ? 'Cmd' : 'Ctrl';
}

/**
 * Turns one raw binding (`'Shift-Mod-z'`) into the label a writer reads (`'Shift+Cmd+Z'` on Mac,
 * `'Shift+Ctrl+Z'` elsewhere). A single-character key is upper-cased (`z` to `Z`) to match how
 * every keyboard shortcut list in this product's ecosystem already renders a letter; a named key
 * (`Tab`, `Escape`) is left exactly as ProseMirror-keymap spells it, since there is no "case" to
 * fix on a word.
 */
export function renderBinding(binding: string): string {
  const parts = binding.split('-');
  const key = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1).map((part) => (part === 'Mod' ? platformModLabel() : part));
  const keyLabel = key.length === 1 ? key.toUpperCase() : key;
  return [...modifiers, keyLabel].join('+');
}
