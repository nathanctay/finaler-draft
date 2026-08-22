import type { ScreenplayBlock } from '@finaler-draft/screenplay';

/**
 * Computes each numbered scene heading's printed label, in document order -- the same algorithm
 * `apps/web/src/pagination.ts`'s `computeSceneNumberDecorations` uses over the live ProseMirror
 * document, reimplemented here over the canonical block sequence: this package, like
 * `packages/fdx` and `packages/docx`, is a pure, server-eligible exporter and must not depend on
 * `apps/web` or ProseMirror. An empty scene heading (`block.text === ''`) is skipped entirely --
 * it neither receives a label nor consumes a number -- matching that function's documented rule
 * exactly (the ordinary transient state of a heading the writer has not started typing yet).
 *
 * A stored `sceneNumber` (a locked production number -- this package's scope, item 6) is used as
 * the printed *label* in place of the running counter's own string form, but the counter itself
 * still advances for that heading. This keeps every *other* heading's position in the sequence
 * unaffected by one locked heading -- exactly the property `computeSceneNumberDecorations` has
 * today, since it has no notion of `sceneNumber` at all -- while still honouring "a stored value
 * wins" for the one heading that carries it.
 */
export function computeSceneNumberLabels(
  blocks: readonly ScreenplayBlock[],
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  let sceneNumber = 0;
  for (const block of blocks) {
    if (block.type !== 'scene_heading' || block.text === '') {
      continue;
    }
    sceneNumber += 1;
    labels.set(block.id, block.sceneNumber ?? String(sceneNumber));
  }
  return labels;
}
