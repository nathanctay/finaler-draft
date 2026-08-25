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
//    lazily imports the editor (`$projectId.screenplays.$screenplayId.tsx`), rather than by
//    guessing which built chunk "looks like" the editor.
//
// Any point below where the manifest does not have the exact shape this script expects raises
// instead of guessing, per the brief: an artifact this script cannot confidently classify must
// fail the build loudly, not pass silently.
const EDITOR_ROUTE_SRC_PREFIX = 'src/routes/projects/$projectId.screenplays.$screenplayId.tsx';

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
  if (routeDynamicImports.length !== 1) {
    throw new Error(
      'Expected the editor route to lazily import exactly one module (the editor chunk itself), ' +
        `found ${routeDynamicImports.length}: ${JSON.stringify(routeDynamicImports)}. Cannot ` +
        'confidently identify which one is the lazy editor chunk.',
    );
  }
  const editorKey = routeDynamicImports[0];
  const editorValue = manifest[editorKey];
  if (!editorValue || typeof editorValue.file !== 'string') {
    throw new Error(
      `The editor route's dynamic import "${editorKey}" has no matching manifest entry with a ` +
        '"file". The manifest is inconsistent with itself.',
    );
  }

  return {
    entry: { file: entryValue.file },
    css: { file: entryValue.css[0] },
    editor: { file: editorValue.file },
  };
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
    const { file } = artifacts[role];
    const bytes = await gzipSizeOf(file);
    const overBy = bytes - budget.bytes;
    const status = overBy > 0 ? 'FAIL' : 'ok  ';
    console.log(
      `[bundle-budget] ${status} ${budget.label.padEnd(18)} ${file.padEnd(28)} ` +
        `${formatKb(bytes).padStart(10)} / ${formatKb(budget.bytes)} budget` +
        (overBy > 0 ? `  -- OVER by ${formatKb(overBy)} (${overBy} bytes)` : ''),
    );
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
