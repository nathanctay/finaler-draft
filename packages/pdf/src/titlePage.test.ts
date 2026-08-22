import { describe, expect, it } from 'vitest';
import { titlePageLines } from './titlePage.js';
import { titlePageWith } from './testFixtures.js';

describe('titlePageLines', () => {
  it('omits every field that is absent, producing no lines at all for an empty title page', () => {
    const lines = titlePageLines(titlePageWith());
    expect(lines.every((line) => line.text === '')).toBe(true);
  });

  it('renders title, credit, one author, and source, each centered', () => {
    const lines = titlePageLines(
      titlePageWith({
        title: 'THE LAST STOP',
        credit: 'written by',
        authors: ['Ada Lovelace'],
        source: 'based on a true story',
      }),
    );
    const nonBlank = lines.filter((line) => line.text !== '');
    expect(nonBlank.map((line) => line.text)).toEqual([
      'THE LAST STOP',
      'written by',
      'Ada Lovelace',
      'based on a true story',
    ]);
    expect(nonBlank.every((line) => line.alignment === 'center')).toBe(true);
  });

  it('renders every author on its own centered line', () => {
    const lines = titlePageLines(titlePageWith({ authors: ['Ada Lovelace', 'Grace Hopper'] }));
    const nonBlank = lines.filter((line) => line.text !== '');
    expect(nonBlank.map((line) => line.text)).toEqual(['Ada Lovelace', 'Grace Hopper']);
    expect(nonBlank.every((line) => line.alignment === 'center')).toBe(true);
  });

  it('left-aligns draftDate', () => {
    const lines = titlePageLines(titlePageWith({ draftDate: 'Third Draft, June 2026' }));
    const nonBlank = lines.filter((line) => line.text !== '');
    expect(nonBlank).toEqual([{ text: 'Third Draft, June 2026', alignment: 'left' }]);
  });

  it('right-aligns every contact line, one per array entry', () => {
    const lines = titlePageLines(
      titlePageWith({ contact: ['Ada Lovelace', '555-0100', 'ada@example.com'] }),
    );
    const nonBlank = lines.filter((line) => line.text !== '');
    expect(nonBlank).toEqual([
      { text: 'Ada Lovelace', alignment: 'right' },
      { text: '555-0100', alignment: 'right' },
      { text: 'ada@example.com', alignment: 'right' },
    ]);
  });

  it('omits authors and contact entirely when the array is present but empty', () => {
    const lines = titlePageLines(titlePageWith({ authors: [], contact: [] }));
    expect(lines.every((line) => line.text === '')).toBe(true);
  });
});
