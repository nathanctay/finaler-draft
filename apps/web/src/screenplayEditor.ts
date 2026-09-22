// Moved to `@finaler-draft/screenplay-editor` (packages/screenplay-editor) so `apps/collab` --
// the Hocuspocus server -- can build the identical ProseMirror schema and canonical projection
// server-side without duplicating either. This module is a plain re-export so every existing
// import from `./screenplayEditor.js` inside `apps/web` keeps working unchanged; see
// `progress/collaboration-slice-1.md` for the reasoning.
export * from '@finaler-draft/screenplay-editor';
