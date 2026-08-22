import { describe, expect, it } from 'vitest';
import { computeSceneNumberLabels } from './sceneNumbers.js';
import { actionBlock, sceneHeadingBlock } from './testFixtures.js';

describe('computeSceneNumberLabels', () => {
  it('numbers scene headings 1-based, in document order', () => {
    const labels = computeSceneNumberLabels([
      sceneHeadingBlock('sh1', 'INT. KITCHEN - DAY'),
      actionBlock('a1', 'Ada waits.'),
      sceneHeadingBlock('sh2', 'EXT. STREET - NIGHT'),
    ]);
    expect(labels.get('sh1')).toBe('1');
    expect(labels.get('sh2')).toBe('2');
  });

  it('skips an empty scene heading entirely -- no label, and it consumes no number', () => {
    const labels = computeSceneNumberLabels([
      sceneHeadingBlock('sh1', 'INT. KITCHEN - DAY'),
      sceneHeadingBlock('sh2', ''),
      sceneHeadingBlock('sh3', 'EXT. STREET - NIGHT'),
    ]);
    expect(labels.get('sh1')).toBe('1');
    expect(labels.has('sh2')).toBe(false);
    expect(labels.get('sh3')).toBe('2'); // not '3' -- the empty heading consumed no number
  });

  it('lets a stored sceneNumber win as the printed label, without disturbing later numbers', () => {
    const labels = computeSceneNumberLabels([
      sceneHeadingBlock('sh1', 'INT. KITCHEN - DAY'),
      sceneHeadingBlock('sh2', 'INT. HALLWAY - DAY', '25A'),
      sceneHeadingBlock('sh3', 'EXT. STREET - NIGHT'),
    ]);
    expect(labels.get('sh1')).toBe('1');
    expect(labels.get('sh2')).toBe('25A');
    expect(labels.get('sh3')).toBe('3'); // the running counter still advanced past sh2
  });

  it('produces no labels for a screenplay with no scene headings', () => {
    const labels = computeSceneNumberLabels([actionBlock('a1', 'Nothing happens.')]);
    expect(labels.size).toBe(0);
  });
});
