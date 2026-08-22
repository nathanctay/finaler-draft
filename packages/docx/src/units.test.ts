import { describe, expect, it } from 'vitest';
import { halfPointsFromPoints, twipsFromInches } from './units.js';

describe('twipsFromInches', () => {
  // Known figures, not round-trips through this same formula: US Letter's Word-native page size
  // (12240 x 15840 twips) is independently well known, and a 1in margin is the textbook
  // twips-per-inch figure (1440). If the `* 1440` in the implementation were ever changed, these
  // would fail against a fact external to this codebase, not against a constant this code itself
  // produced.
  it('converts 1 inch to 1440 twips', () => {
    expect(twipsFromInches(1)).toBe(1440);
  });

  it('converts US Letter width (8.5in) to 12240 twips', () => {
    expect(twipsFromInches(8.5)).toBe(12240);
  });

  it('converts US Letter height (11in) to 15840 twips', () => {
    expect(twipsFromInches(11)).toBe(15840);
  });

  it('converts 0 inches to 0 twips', () => {
    expect(twipsFromInches(0)).toBe(0);
  });

  it('rounds to the nearest whole twip', () => {
    // 1/1440 inch is smaller than any figure this package computes, but the conversion must not
    // emit a fractional twip regardless -- `w:val` is an integer attribute.
    expect(twipsFromInches(1 / 2880)).toBe(1);
  });
});

describe('halfPointsFromPoints', () => {
  // The specification's own worked example (ECMA-376 17.3.2.38): w:val="27" means 13.5pt.
  it('reproduces the specification example: 13.5pt is 27 half-points', () => {
    expect(halfPointsFromPoints(13.5)).toBe(27);
  });

  it('converts 12pt (the screenplay type size) to 24 half-points', () => {
    expect(halfPointsFromPoints(12)).toBe(24);
  });

  it('converts 0 points to 0 half-points', () => {
    expect(halfPointsFromPoints(0)).toBe(0);
  });
});
