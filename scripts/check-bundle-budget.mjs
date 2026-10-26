#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Enforces the bundle-budget table in `plan.md`'s "Export architecture" section, which documents
 * these numbers as "enforced in CI as a build step that fails on regression" -- this script is
 * that step. The budgets are the specification: raising a number here to make a failing build pass
 * is not a valid fix for a regression, it is deleting the check. A budget that still cannot be met
 * after real work is a finding to report, not a number to edit.
 *
 * Kilobytes here are decimal (1 kB = 1000 bytes), matching `vite build`'s own "gzip: NN kB" console
 * report and the `chunkSizeWarningLimit` convention behind the uncompressed 500 kB warning the same
 * plan.md paragraph forbids suppressing -- so a size this script reports lines up exactly with what
 * `vite build`'s own output already showed for the same file.
 *
 * A budget is a ceiling, not an exclusive one: a chunk sitting exactly at its budget passes. Only
 * strictly exceeding it fails.
 */

const KB = 1000;
const BUDGETS = {
  entry: { label: 'Entry chunk', bytes: 120 * KB },
  editor: { label: 'Lazy editor chunk', bytes: 200 * KB },
  css: { label: 'CSS', bytes: 20 * KB },
};

// Vite content-hashes every output filename (`App-BQs-2GrE.js`), so nothing here may key off a
// literal built filename -- a hash changes on every build that touches that chunk's content. The
// only stable handle is where each artifact sits in the manifest's *source* graph:
//
//  - the entry chunk is whichever manifest entry has `isEntry: true`, plus the one CSS file it
//    references;
//  - the lazy editor chunk is resolved by walking the graph from the one route source file that
//    lazily imports the editor (`$projectId.screenplays.$screenplayId/index.tsx` -- collaboration
//    slice 4a moved this from a flat file into a folder + `index.tsx` so the revision-history and
//    historical-preview routes could become its siblings instead of its children; see
//    progress/collaboration-revisions.md), rather than by guessing which built chunk "looks like"
//    the editor.
//
// Any point below where the manifest does not have the exact shape this script expects raises
// instead of guessing, per the brief: an artifact this script cannot confidently classify must
// fail the build loudly, not pass silently.
const EDITOR_ROUTE_SRC_PREFIX =
  'src/routes/projects/$projectId.screenplays.$screenplayId/index.tsx';

// Which of the editor route's lazy imports *is* the editor. The route used to have exactly one, so
// "the only dynamic import" identified it unambiguously; the screenplay-invitations slice added a
// second (`sharingDialog.tsx`, lazy for the same reason the editor is -- only needed once a writer
// opens it), which made "the only one" ambiguous rather than wrong.
//
// Matched on the manifest's `name`, not its key and not a built filename. `App.tsx` is lazily
// imported by three routes (the live editor, the historical-revision preview, and the diff view),
// so Vite emits it as a *shared* chunk, and a shared chunk's manifest key is its built filename
// (`_App-BQs-2GrE.js`) rather than its source path -- there is no `src/App.tsx` key to match, which
// is why this is not simply a source-key lookup. `name` is derived from the source module and
// carries no content hash, so it is a stable source-graph handle of exactly the kind the comment
// above requires.
//
// This is stricter than the count it replaces, not looser: one dynamic import was only ever
// *evidence* that it was the editor, whereas this names the module and still raises when it is
// absent (the editor stopped being lazily imported) or ambiguous (two chunks claiming the name).
const EDITOR_CHUNK_NAME = 'App';

const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const distRoot = path.join(webRoot, 'dist');
const manifestPath = path.join(distRoot, '.vite/manifest.json');

async function loadManifest() {
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read the Vite build manifest at ${manifestPath}. This check reads a built ` +
        `manifest, not source -- run "pnpm --filter @finaler-draft/web build" first. Original ` +
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return JSON.parse(raw);
}

/**
 * Locates the entry chunk, its single CSS file, and the lazy editor chunk from the manifest's
 * source graph. Throws -- rather than falling back to a guess -- the moment the manifest's shape
 * stops matching what this script was written against, so a change to the build graph (a new
 * eagerly-loaded chunk, a route file rename, a second CSS entry) fails the build instead of
 * silently measuring the wrong file.
 */
function classify(manifest) {
  const entries = Object.entries(manifest);

  const entryMatches = entries.filter(([, value]) => value.isEntry === true);
  if (entryMatches.length !== 1) {
    throw new Error(
      `Expected exactly one manifest entry with isEntry: true, found ${entryMatches.length}. ` +
        'Cannot confidently identify the entry chunk.',
    );
  }
  const [, entryValue] = entryMatches[0];
  if (typeof entryValue.file !== 'string') {
    throw new Error('The entry chunk manifest record has no "file". Cannot classify.');
  }
  if (!Array.isArray(entryValue.css) || entryValue.css.length !== 1) {
    throw new Error(
      `Expected the entry chunk to reference exactly one CSS file, found ${
        Array.isArray(entryValue.css) ? entryValue.css.length : 0
      }. Cannot confidently identify "the" CSS artifact.`,
    );
  }

  const routeMatches = entries.filter(([key]) => key.startsWith(EDITOR_ROUTE_SRC_PREFIX));
  if (routeMatches.length !== 1) {
    throw new Error(
      `Expected exactly one manifest entry for the editor route (keys starting with ` +
        `"${EDITOR_ROUTE_SRC_PREFIX}"), found ${routeMatches.length}. If that route file moved, ` +
        'update EDITOR_ROUTE_SRC_PREFIX in this script; otherwise this is a real ambiguity this ' +
        'check refuses to guess through.',
    );
  }
  const [, routeValue] = routeMatches[0];
  const routeDynamicImports = routeValue.dynamicImports ?? [];
  // The editor must still be *lazily* imported by that route -- that is the budget's whole premise.
  // An eagerly-imported editor would drop out of this list and fail here rather than quietly being
  // folded into the entry chunk and measured against the wrong budget.
  const editorMatches = routeDynamicImports.filter(
    (key) => manifest[key]?.name === EDITOR_CHUNK_NAME,
  );
  if (editorMatches.length !== 1) {
    throw new Error(
      `Expected exactly one of the editor route's lazy imports to be the editor chunk (manifest ` +
        `name "${EDITOR_CHUNK_NAME}"), found ${editorMatches.length} among ` +
        `${JSON.stringify(routeDynamicImports)}. If the editor module was renamed, update ` +
        'EDITOR_CHUNK_NAME in this script; otherwise the editor is no longer lazily imported by ' +
        'that route, which is a real regression this check refuses to guess through.',
    );
  }
  const editorKey = editorMatches[0];
  const editorValue = manifest[editorKey];
  if (!editorValue || typeof editorValue.file !== 'string') {
    throw new Error(
      `The editor route's dynamic import "${editorKey}" has no matching manifest entry with a ` +
        '"file". The manifest is inconsistent with itself.',
    );
  }

  // The editor's cost is its own chunk **plus every chunk it statically imports**, transitively,
  // minus whatever the entry chunk already paid for. Measuring `App-*.js` alone used to be the
  // same number, because the editor was one chunk; it stopped being so when a second route began
  // dynamically importing `@finaler-draft/screenplay-editor` (the FDX-import slice's read-only
  // probe), which made that package shared between two dynamic entries and so made Vite extract
  // it into a sibling chunk. `App-*.js` fell from 145 kB gzip to 23 kB with no code removed, and
  // this check reported that as a pass: the 200 kB budget had silently stopped covering about
  // 120 kB of editor code.
  //
  // Nothing about that was a real improvement, so the budget must follow the graph rather than one
  // filename. Subtracting the entry's own closure is what keeps the number meaningful: those bytes
  // are already in the browser before the editor is ever opened, so charging the editor for them
  // would overstate what opening it costs.
  const editorClosure = staticClosure(manifest, editorKey);
  const entryClosure = staticClosure(manifest, entryMatches[0][0]);
  const editorFiles = [...editorClosure]
    .filter((key) => !entryClosure.has(key))
    .map((key) => manifest[key]?.file)
    .filter((file) => typeof file === 'string' && file.endsWith('.js'))
    .sort();
  if (editorFiles.length === 0) {
    throw new Error(
      "The editor chunk resolved to no JavaScript files once the entry chunk's own closure was " +
        'excluded. The manifest is inconsistent with itself.',
    );
  }

  return {
    entry: { files: [entryValue.file] },
    css: { files: [entryValue.css[0]] },
    editor: { files: editorFiles },
  };
}

/**
 * Every manifest key reachable from `startKey` through `imports` (static imports only, never
 * `dynamicImports`) -- the set of chunks a browser must fetch before the module at `startKey` can
 * execute. `dynamicImports` are deliberately excluded: those are separate lazy boundaries that are
 * not paid for until something actually awaits them, which is the entire reason the editor has a
 * budget of its own rather than being part of the entry's.
 *
 * Non-chunk keys (`index.html`) are skipped by the caller's `.js` filter rather than here, so that
 * a genuinely missing manifest record still surfaces as an inconsistency instead of being quietly
 * dropped during the walk.
 */
function staticClosure(manifest, startKey) {
  const seen = new Set();
  const queue = [startKey];
  while (queue.length > 0) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of manifest[key]?.imports ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

function formatKb(bytes) {
  return `${(bytes / KB).toFixed(2)} kB`;
}

async function gzipSizeOf(relativeFile) {
  const absolutePath = path.join(distRoot, relativeFile);
  let contents;
  try {
    contents = await readFile(absolutePath);
  } catch (error) {
    throw new Error(
      `Classified "${relativeFile}" as a budgeted artifact but could not read it from disk at ` +
        `${absolutePath}. Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return gzipSync(contents).length;
}

async function main() {
  const manifest = await loadManifest();
  const artifacts = classify(manifest);

  const failures = [];
  for (const [role, budget] of Object.entries(BUDGETS)) {
    const { files } = artifacts[role];
    let bytes = 0;
    for (const file of files) bytes += await gzipSizeOf(file);
    // Each chunk is gzipped separately, which is what the browser actually fetches -- not one
    // gzip stream over the concatenation, which would understate the real transfer by sharing a
    // dictionary across files that arrive independently.
    const file = files.length === 1 ? files[0] : `${files.length} chunks`;
    const overBy = bytes - budget.bytes;
    const status = overBy > 0 ? 'FAIL' : 'ok  ';
    console.log(
      `[bundle-budget] ${status} ${budget.label.padEnd(18)} ${file.padEnd(28)} ` +
        `${formatKb(bytes).padStart(10)} / ${formatKb(budget.bytes)} budget` +
        (overBy > 0 ? `  -- OVER by ${formatKb(overBy)} (${overBy} bytes)` : ''),
    );
    if (files.length > 1) {
      for (const member of files) {
        console.log(
          `[bundle-budget]        ${formatKb(await gzipSizeOf(member)).padStart(10)}  ${member}`,
        );
      }
    }
    if (overBy > 0) {
      // Both units: kB rounds a sub-500-byte overage to "0.00 kB", which reads as passing at a
      // glance even though this is a real, if tiny, regression -- the exact byte count next to it
      // keeps the failure message honest at any overage size, not just ones that round visibly.
      failures.push(
        `${budget.label} (${file}) is ${formatKb(bytes)} gzip, which exceeds its ` +
          `${formatKb(budget.bytes)} budget by ${formatKb(overBy)} (${overBy} bytes).`,
      );
    }
  }

  if (failures.length > 0) {
    console.error('\nBundle budget exceeded:');
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      '\nThese budgets are documented in plan.md and are the specification for this build. Do ' +
        'not raise them to make this check pass -- reduce what ships in the offending artifact ' +
        'instead.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('\nAll bundle artifacts are within budget.');
}

main().catch((error) => {
  console.error(`[bundle-budget] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
