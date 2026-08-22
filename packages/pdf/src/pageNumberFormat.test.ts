import { describe, expect, it } from 'vitest';
import { formatPageNumber } from './pageNumberFormat.js';

describe('formatPageNumber', () => {
  it('formats arabic numerals as plain decimal', () => {
    expect(formatPageNumber(1, 'arabic')).toBe('1');
    expect(formatPageNumber(42, 'arabic')).toBe('42');
  });

  it('formats roman numerals', () => {
    expect(formatPageNumber(1, 'roman')).toBe('I');
    expect(formatPageNumber(4, 'roman')).toBe('IV');
    expect(formatPageNumber(9, 'roman')).toBe('IX');
    expect(formatPageNumber(14, 'roman')).toBe('XIV');
    expect(formatPageNumber(40, 'roman')).toBe('XL');
    expect(formatPageNumber(90, 'roman')).toBe('XC');
    expect(formatPageNumber(1994, 'roman')).toBe('MCMXCIV');
  });
});
