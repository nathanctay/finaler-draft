import { describe, expect, it } from 'vitest';
import { applyPageGeometryCssVariables, pageGeometryCssVariables } from './pageGeometryCss.js';

describe('pageGeometryCssVariables', () => {
  it('expresses every figure in the units styles.css expects', () => {
    const variables = pageGeometryCssVariables();

    expect(variables['--fd-page-width']).toBe('8.5in');
    expect(variables['--fd-page-height']).toBe('11in');
    expect(variables['--fd-page-margin-top']).toBe('1in');
    expect(variables['--fd-page-margin-right']).toBe('1in');
    expect(variables['--fd-page-margin-left']).toBe('1.5in');
    expect(variables['--fd-body-width']).toBe('6in');
    expect(variables['--fd-type-size']).toBe('12pt');
    expect(variables['--fd-line-height']).toBe('1');
    expect(variables['--fd-typeface']).toBe("'Courier Prime', monospace");
    expect(variables['--fd-page-number-top']).toBe('0.5in');
    expect(variables['--fd-page-number-right']).toBe('0.75in');
    expect(variables['--fd-character-indent']).toBe('3.7in');
    expect(variables['--fd-dialogue-indent']).toBe('2.5in');
    expect(variables['--fd-dialogue-width']).toBe('3.5in');
    expect(variables['--fd-parenthetical-indent']).toBe('3.1in');
    expect(variables['--fd-parenthetical-width']).toBe('2in');
    expect(variables['--fd-transition-indent']).toBe('1in');
    expect(variables['--fd-blank-lines-before-scene-heading']).toBe('1');
    expect(variables['--fd-blank-lines-before-action']).toBe('1');
    expect(variables['--fd-blank-lines-before-character']).toBe('1');
    expect(variables['--fd-blank-lines-before-dialogue']).toBe('0');
    expect(variables['--fd-blank-lines-before-parenthetical']).toBe('0');
    expect(variables['--fd-blank-lines-before-transition']).toBe('1');
    expect(variables['--fd-blank-lines-before-shot']).toBe('1');
  });

  it('returns every value as a page-edge measurement, leaving margin subtraction to CSS calc()', () => {
    const variables = pageGeometryCssVariables();
    // The character indent (3.7in) is expressed from the page edge, not pre-offset against the
    // 1.5in left margin -- styles.css is responsible for the calc(), not this module.
    expect(variables['--fd-character-indent']).not.toBe('2.2in');
  });
});

describe('applyPageGeometryCssVariables', () => {
  it('sets every geometry variable on the target element', () => {
    const target = document.createElement('div');
    applyPageGeometryCssVariables(target);

    const variables = pageGeometryCssVariables();
    for (const [name, value] of Object.entries(variables)) {
      expect(target.style.getPropertyValue(name)).toBe(value);
    }
  });

  it('defaults to the document root when no target is given', () => {
    applyPageGeometryCssVariables();
    expect(document.documentElement.style.getPropertyValue('--fd-page-width')).toBe('8.5in');
  });
});
