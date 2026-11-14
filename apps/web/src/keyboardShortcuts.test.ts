import { afterEach, describe, expect, it } from 'vitest';
import { getExtensionField, type AnyExtension } from '@tiptap/core';
import { createLocalScreenplayEditorInit } from '@finaler-draft/screenplay-editor';
import { KEYBOARD_SHORTCUTS, platformModLabel, renderBinding } from './keyboardShortcuts.js';
import { SmartTypeGhostExtension } from './smartTypeGhost.js';
import { FindReplaceExtension } from './findReplace.js';

/**
 * The brief's own instruction: "write a test asserting every shortcut the dialog claims actually
 * has a binding somewhere." This resolves each `KEYBOARD_SHORTCUTS` entry's claimed bindings
 * against the *real* `addKeyboardShortcuts()` a named extension registers -- not a second,
 * hand-copied list of what those extensions do, which could drift from the first exactly the way
 * the dialog itself could drift from the code. `getExtensionField` is `@tiptap/core`'s own export,
 * the identical helper `ExtensionManager.plugins` uses internally to turn an extension's
 * `addKeyboardShortcuts()` into the real ProseMirror keymap a keypress actually reaches -- so
 * resolving bindings this way is reading the same mechanism production reads, not reinventing one.
 *
 * `createLocalScreenplayEditorInit` (the same builder `editing.test.ts`, in
 * `packages/screenplay-editor`, uses for every one of its own keymap tests) returns the real
 * extension instances the live editor is built from, with no DOM mount required: nothing here
 * needs a rendered view, only the `addKeyboardShortcuts()` each extension's own config exposes.
 */
function screenplayExtensions(): readonly AnyExtension[] {
  return createLocalScreenplayEditorInit({ type: 'screenplayDocument', content: [] }).extensions;
}

function bindingsOf(extension: AnyExtension): readonly string[] {
  const addKeyboardShortcuts = getExtensionField(extension, 'addKeyboardShortcuts', {});
  if (typeof addKeyboardShortcuts !== 'function') {
    return [];
  }
  return Object.keys(addKeyboardShortcuts() as Record<string, unknown>);
}

function registeredBindings(
  source: 'screenplayYjs' | 'screenplayBlock' | 'smartTypeGhost' | 'findReplace',
) {
  if (source === 'smartTypeGhost') {
    return bindingsOf(SmartTypeGhostExtension);
  }
  if (source === 'findReplace') {
    return bindingsOf(FindReplaceExtension);
  }
  const extension = screenplayExtensions().find((candidate) => candidate.name === source);
  if (!extension) {
    throw new Error(`No "${source}" extension in the real editor's own extension set.`);
  }
  return bindingsOf(extension);
}

describe('KEYBOARD_SHORTCUTS: every claimed binding is real', () => {
  /**
   * Non-vacuous on purpose, the same concern `feedbackNoReadPath.test.ts` names for its own route
   * enumeration: without this, a `source` that resolved to an extension exposing no
   * `addKeyboardShortcuts()` at all (a typo in the extension name, say) would make every
   * `toContain` below pass by finding nothing to disagree with.
   */
  it('resolves a non-empty binding set for every source this dialog cites', () => {
    expect(registeredBindings('screenplayYjs').length).toBeGreaterThan(0);
    expect(registeredBindings('screenplayBlock').length).toBeGreaterThan(0);
    expect(registeredBindings('smartTypeGhost').length).toBeGreaterThan(0);
    expect(registeredBindings('findReplace').length).toBeGreaterThan(0);
  });

  it.each(
    KEYBOARD_SHORTCUTS.flatMap((entry) =>
      entry.bindings.map((binding) => ({
        binding,
        description: entry.description,
        source: entry.source,
      })),
    ),
  )(
    '"$description" claims $binding, which the real "$source" extension actually registers',
    ({ binding, source }) => {
      expect(registeredBindings(source)).toContain(binding);
    },
  );
});

describe('renderBinding', () => {
  const originalPlatform = navigator.platform;

  afterEach(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform });
  });

  function setPlatform(value: string): void {
    Object.defineProperty(navigator, 'platform', { configurable: true, value });
  }

  it('renders Mod as Cmd on a Mac platform', () => {
    setPlatform('MacIntel');
    expect(platformModLabel()).toBe('Cmd');
    expect(renderBinding('Mod-z')).toBe('Cmd+Z');
    expect(renderBinding('Shift-Mod-z')).toBe('Shift+Cmd+Z');
  });

  it('renders Mod as Ctrl on a non-Mac platform', () => {
    setPlatform('Win32');
    expect(platformModLabel()).toBe('Ctrl');
    expect(renderBinding('Mod-y')).toBe('Ctrl+Y');
  });

  it('leaves a named key (not a single character) exactly as the binding spells it', () => {
    expect(renderBinding('Tab')).toBe('Tab');
    expect(renderBinding('Escape')).toBe('Escape');
  });
});
