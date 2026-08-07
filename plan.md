# Finaler Draft Product and Delivery Plan

**Status:** The Phase 0 foundation slice was committed by the user as `7e4b9f4`; the first Phase 1 schema slice was committed as `5423afe`; the local semantic editor was committed as `bb8886c`; its label-overflow correction was committed as `6b4d534`; the Transition-to-Scene-Heading keyboard-flow correction was committed as `58bb4ee`; and PostgreSQL, Better Auth, and authorized project/screenplay persistence were committed as `bb2ce06`. The persisted-editor workflow is being rebuilt on an isolated branch after its prior uncommitted worktree was externally removed; this branch and this plan are the only source of truth for the rebuilt work. Pagination, FDX, and export work remain separate deliveries.

This is the source of truth for product scope, architecture, delivery order, quality gates, and operating rules. Update it deliberately when a decision changes. `progress.md` is the append-only record of work actually performed.

## Product boundaries

Finaler Draft is an original, web-based professional screenwriting application. It will deliver functional compatibility with the workflows writers expect from Final Draft, without copying its branding, visual design, content, or trade dress.

Final Draft is not a single parity target: its desktop product includes extensive production workflows while its web Writer is intentionally narrower. The product will therefore deliver the durable core first, then review, planning, and production features in order.

Screenplays are sensitive creative work. Documents are private by default; sharing must be explicit and role-based. Store assets in private buckets with short-lived authorized URLs, encrypt all network connections, exclude screenplay content and personal data from logs/analytics, and do not send document content to any AI service unless the user explicitly enables a future, separately designed feature.

## Architecture decisions

| Area                           | Decision                                                      | Reason                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application stack              | TypeScript end-to-end                                         | The hard parts of this product—structured editing, browser offline support, and real-time collaboration—have the best-maintained ecosystem in TypeScript. A Go API plus a Node collaboration sidecar would add an authorization boundary and two language stacks without a current benefit. |
| Frontend                       | React, TypeScript strict mode, Vite                           | A fast SPA with no full-stack framework requirement.                                                                                                                                                                                                                                        |
| Routing                        | TanStack Router, file-based routes with Zod validation        | Type-safe paths and addressable UI state suit a document application. Use TanStack Router only, not TanStack Start or SSR.                                                                                                                                                                  |
| API                            | Fastify running on Node LTS                                   | Typed REST API, same-origin session handling, and a clean place for authorization, exports, and collaboration token/session checks.                                                                                                                                                         |
| Authentication                 | Better Auth with PostgreSQL                                   | Self-hosted email/password sessions for v1. Do not implement password handling ourselves. Add verified-email, reset, rate-limiting, and transactional email before public launch.                                                                                                           |
| Editor                         | Tiptap core / ProseMirror, custom screenplay extensions       | The document is structured screenplay data, not HTML or generic rich text. Use only open-source core features; do not depend on Tiptap Cloud or paid extensions.                                                                                                                            |
| Collaboration                  | Yjs via self-hosted Hocuspocus over WebSockets                | Yjs handles concurrent/offline document merging; Hocuspocus is the WebSocket server and persistence/auth integration.                                                                                                                                                                       |
| Primary data                   | PostgreSQL                                                    | Durable relational metadata, permissions, Yjs binary updates/checkpoints, revision projections, comments, and audit data.                                                                                                                                                                   |
| Files                          | Private Railway object storage or compatible S3 storage       | Imported files, image/storyboard assets, and short-lived asynchronous export artifacts. Canonical screenplay data stays in PostgreSQL.                                                                                                                                                      |
| Exports                        | Canonical renderer, headless Chromium PDF, and OOXML `.docx`  | Derive downloads from a hash-identified screenplay snapshot; do not make PDFs or Word files the source of truth.                                                                                                                                                                            |
| Deployment                     | Railway                                                       | One web/API service and PostgreSQL initially. Serve the Vite build from Fastify so web and API share an origin. Add a dedicated export worker with the export feature; it must not block web requests.                                                                                      |
| Horizontal collaboration scale | Redis pub/sub, introduced before adding a second app instance | Connected users on separate instances must receive the same Yjs updates.                                                                                                                                                                                                                    |

### Why Yjs is used with WebSockets

Yjs and a WebSocket library solve different problems:

```text
Browser editor -- Yjs update --> WebSocket transport --> Hocuspocus server --> other editors
                       |                                      |
                 merge/offline/conflict                    authorize/persist/broadcast
```

A basic Express WebSocket library only opens the pipe and sends arbitrary messages. It does not define how two simultaneous edits to the same dialogue block merge, how an offline editor catches up, how selections remain stable after edits, or how local undo differs from another writer's undo. Implementing those concerns correctly would mean building an operational-transformation or CRDT system ourselves.

Yjs is a CRDT library that provides that collaboration logic. It is transport-agnostic and can use a basic WebSocket server; Hocuspocus is selected because it already implements the Yjs protocol, authentication hooks, awareness/presence, and database integration. Express is not selected elsewhere because Fastify is the application server, but the principle is the same: WebSockets are the transport; Yjs is the collaboration model.

### Subscription and licensing policy

No planned library requires a subscription to run the application: React, Vite, Fastify, PostgreSQL, Yjs, Hocuspocus, Better Auth, Drizzle, Tiptap core, and the test tooling will be self-hosted open-source dependencies. Yjs and Better Auth are MIT licensed; Hocuspocus is used as its self-hosted open-source server, not as a cloud product.

There will still be operating costs:

- Railway compute, PostgreSQL, storage, backups/PITR, bandwidth, and domain registration are hosted-service costs.
- Transactional email and optional OAuth providers may have their own pricing.
- Do not adopt Tiptap Cloud, a managed collaboration provider, or paid editor extensions without an explicit plan change.

At scaffold time, pin dependency versions and add license/dependency vulnerability checks. Re-check every third-party license before introducing a package.

### Routing and client data boundaries

Use TanStack Router with its Vite plugin and a file-based route tree. It is the right choice for this React SPA: document, project, and revision identifiers are checked at compile time; Zod validates route parameters and search state; and navigation state is shareable without a parallel URL-state implementation. TanStack Query is the companion cache for REST metadata and mutations.

The router is a user-experience boundary, never an authorization boundary. Route loaders may redirect an unauthenticated user and prefetch permitted metadata, but every API and collaboration request must independently authenticate and authorize the actor.

- Routes will cover authentication, project lists, project detail, individual screenplay editors, revision history, shared-document entry points, and settings.
- Only safe, addressable UI state belongs in the URL: selected scene, outline/revision panel, and view mode. Validate it with Zod. Never put screenplay text, collaboration updates, permissions, session data, or presigned asset URLs in a route or search parameter.
- The active editor document and Yjs synchronization remain editor-owned state, not TanStack Query cache data. TanStack Query is for REST resources such as projects, document metadata, revisions, comments, and export-job status.

### Export architecture

PDF export is a required Phase 1 capability, not a late optional feature. The server creates an immutable canonical screenplay snapshot (and records its hash/revision), renders the same deterministic paginated screenplay layout used for print preview, and uses headless Chromium to produce PDF. The client polls or subscribes to an export job and downloads a short-lived, authorized result.

Provide `.docx` export in Phase 1 from the same canonical snapshot using an OOXML generator. It should preserve the screenplay's content, element semantics, page breaks, and basic page layout, but PDF is the fidelity contract for exact screenplay pagination. Do not support legacy binary `.doc` initially: `.docx` is the modern interoperable format, while reliable `.doc` generation would add a disproportionate compatibility burden.

Exports are derived artifacts, not stored screenplays. PostgreSQL holds the semantic screenplay, revisions, permissions, job metadata, and content hashes. Private object storage holds original imports, user assets, and only temporary export results needed by asynchronous workers; apply a lifecycle expiry and delete a result once it expires. Do not retain an export permanently unless a user explicitly requests an archival copy.

Export correctness requires fixture-driven tests: canonical screenplay to print-preview/page-count assertions, PDF text and page-image regression tests, DOCX package/semantic tests, authorization and expiry checks, and a test that an export made from a historical revision exactly identifies that revision rather than the mutable current document.

## Canonical screenplay model

The editor will use semantic nodes with stable IDs, rather than unstructured text:

```text
screenplay
  scene_heading | action | character | dialogue | parenthetical
  transition | shot | dual_dialogue | page_break

annotations
  note (non-printing, anchored to a stable block ID and text range)
```

Stable scene and block IDs support comments, scene navigation, revision diffs, imports/exports, and future storyboard links even when content is reordered. A shared schema package defines the validation rules and is used by the editor, API, import/export layer, and tests.

The `@finaler-draft/screenplay` package is the public validation boundary for canonical screenplay snapshots. Schema version `1` uses a flat ordered `blocks` collection and UUID stable IDs: scene-heading block IDs are scene/storyboard anchors, avoiding duplicate scene containers. It validates scene headings, action, character, dialogue, parentheticals, transitions, shots, page breaks, and nested dual-dialogue containers with exactly two ordered dialogue columns that each begin with a character and include dialogue; rejects unknown canonical fields; and ensures every screenplay, title-page, root/nested block, and annotation identifier is globally unique within a screenplay. Title pages are a separate `titlePages` collection. Notes are a separate, non-printing annotation layer with stable IDs and bounded UTF-16 code-unit text-range anchors to text block IDs, never body blocks. It preserves authored text exactly rather than normalizing whitespace, and never persists computed pagination or layout data. A schema version change requires an explicit migration at an API/import boundary; consumers must not silently reinterpret a future version.

The API accepts at most 16 MiB of screenplay request bytes. The canonical authored-text limit is 1.5 million UTF-16 code units; a legal control character can occupy six JSON bytes, yielding a 9 MB text-only wire payload before object structure and stable IDs. The 16 MiB bound leaves more than 6 MiB for the maximum node/UUID/object overhead. The test suite constructs and accepts a near-25,000-node canonical screenplay containing the full 1.5 million control-character text budget, verifies that its actual JSON wire payload exceeds 10 MiB but stays within the cap, and rejects any larger request with HTTP 413.

To keep canonical snapshots safe to validate, synchronize, and render, schema version `1` bounds root blocks at 10,000, annotations at 10,000, and each dual-dialogue column at 100 blocks. It also caps canonical screenplay nodes at 25,000, counting every root block, dual-dialogue column container, and nested dialogue-column block, so valid per-array limits cannot compose into an oversized document. Every canonical authored-text field is limited to 20,000 UTF-16 code units and the complete screenplay budget, including title pages, scene numbers, blocks, and annotations, is 1,500,000 UTF-16 code units. These limits intentionally accommodate feature-length and longer scripts while making malformed or adversarial snapshots finite. Annotation offsets use JavaScript/ProseMirror UTF-16 code-unit indices, not Unicode code-point or grapheme-cluster counts; validation compares them to JavaScript string length in the same unit.

The canonical screenplay is an ordered, flat block sequence. A scene is derived from a `scene_heading` block and the following blocks up to the next heading; the heading's stable block ID is its scene anchor. Title pages are a separate ordered collection and never participate in screenplay pagination. `dual_dialogue` is an explicit container with exactly two ordered dialogue columns and stable descendant IDs. Do not persist computed page positions, visual layout, or renderer output in the semantic document.

Notes are non-printing annotations, not screenplay blocks. They must remain anchored to stable block/range identities and must never enter PDF, DOCX, or FDX screenplay flow by accident.

### Initial semantic-editor behavior

The first editor implementation uses the open-source Tiptap core and React bindings with custom screenplay nodes; it does not use a generic rich-text starter schema or a paid Tiptap service. It edits a local canonical screenplay projection only. Persistence, authentication, collaboration, FDX conversion, title-page editing, and deterministic paginated print layout are deliberately separate slices.

The initial keyboard defaults mirror the core Final Draft writing flow: Enter after a scene heading creates action, after action creates action, after character or parenthetical creates dialogue, after dialogue creates action, and after transition creates a scene heading. Tab from action creates character; Tab from dialogue creates parenthetical. The toolbar element selector changes the active block's screenplay element. Each transformation must preserve the block's stable identity where the schema permits it, and the UI must show the active element and derive Navigator scenes from the shared schema. Local undo/redo is required; it must not be presented as collaboration history.

The semantic-editor production bundle currently measures about 177 kB gzip and triggers Vite's default 500 kB uncompressed-chunk warning. Do not suppress that warning. When the TanStack Router route tree is introduced, lazy-load the editor route and establish a documented bundle budget before adding further authoring extensions.

Formatting, keyboard behavior, pagination, and PDF export are product-critical. Do not start Final Draft-style locked pages, colored production revisions, or scene-number insertion rules until deterministic pagination and a robust FDX fixture suite exist.

The editor shell and FDX/PDF fixture suite are explicit first-class Phase 0/1 deliverables. Do not defer them behind generic account screens or collaboration plumbing.

## Collaboration, history, and restoration

### Separate concepts

1. **Revision history:** durable immutable document snapshots and named milestones.
2. **Track Changes:** review proposals with author attribution and accept/reject actions.
3. **Production revision sets:** industry production marks, colors, locked pages, and omissions.

They must never share one implementation or user interface state.

### Durable storage

```text
documents
  id, active_collab_id, active_epoch, project_id, title, owner_id, timestamps

document_yjs_updates
  document_id, epoch, sequence, update BYTEA, received_at, authenticated_actor_id

document_yjs_checkpoints
  document_id, epoch, through_sequence, state_vector BYTEA, merged_update BYTEA, created_at

document_revisions
  id, document_id, source_epoch, kind, label, authored_by, created_at,
  canonical_screenplay JSONB, canonical_hash, rendered_text, preview_metadata

document_exports
  id, document_id, source_revision_id, canonical_hash, format, state, object_key,
  byte_size, expires_at, requested_by, created_at, completed_at
```

Persist authenticated Yjs updates append-only, compact them into checkpoints, and create application-level revisions for named milestones, meaningful idle sessions, major structural changes, and exports. Retain named revisions indefinitely; document the retention policy for automatic revisions. Cursors and presence are transient and never belong in history. Browser IndexedDB stores a local offline copy.

### Restore as current

Restore as current is required, but it is not a Yjs rollback or a database pointer change. It is an epoch cutover and will be delivered in the version-history phase after snapshots, reconstruction, and offline recovery are proven.

1. An authorized owner/editor previews a screenplay-aware diff and confirms the target revision.
2. The server creates a fresh collaboration document seeded from the selected revision's canonical screenplay JSON.
3. In one transaction, it records a `restore` revision linked to both the prior head and source revision, increments the document epoch, and makes the new collaboration document active.
4. Connected clients receive a restore event and reload the new epoch. The server rejects writes to the old epoch.
5. A returning offline client is told the document was restored. Its unsynced work is preserved as a recovery fork/new screenplay for manual comparison or copying; it is never auto-merged into the restored screenplay.

The restore feature is complete only when it is authorized, confirmed, atomic, idempotent, fully auditable, hash-identical to the selected revision, and does not destroy old history or offline work.

Required tests include two active writers racing a restore, offline edits/reconnect, stale epoch rejection on HTTP and WebSocket paths, retry/idempotency, authorization, recovery-fork integrity, transaction crash rollback, historical replay, and export fidelity after restoration.

## UI and interaction direction

The visual direction is **desktop authoring software**, informed by Microsoft Office, Adobe applications, and Google Docs—not a generic consumer dashboard.

- Use a dense, deliberate workspace: application menu/toolbar, document tabs, inspector/navigation panes, resizable split views, status bar, and keyboard-first commands.
- Favor square or subtly rounded rectangles, clear borders, purposeful separators, and compact controls. Pills are reserved only for genuinely categorical tokens such as collaborator presence or tags.
- Use a restrained neutral palette with one functional accent color, rich selection/focus states, and a professional dark mode. Do not use purple gradients, card grids, excessive floating shadows, or generic component-library styling.
- Pair a readable interface sans-serif with a screenplay-appropriate monospaced/industry-style script face for paginated pages. Select fonts with appropriate web licenses; do not use proprietary Office/Adobe fonts without licensing.
- Preserve accessibility: full keyboard operation, visible focus, semantic controls, minimum contrast, zoom support, screen-reader labels, and reduced-motion support.
- Build a small design-token and component system from the product shell outward. Do not adopt an unmodified Tailwind/shadcn visual language.

Before the main editor implementation, create and review a clickable shell/design prototype for the writing workspace, navigator, inspector, review state, and responsive behavior. It must be treated as a product design deliverable, not disposable scaffolding.

## Phased roadmap

### Phase 0 — Engineering foundation

- Create monorepo, root `README.md`, standard Node `.gitignore`, strict TypeScript, environment validation, structured error handling, migrations, seeded local development, CI, and Railway configuration.
- Integrate Better Auth with secure cookie/session settings, password reset/email verification pathways, authorization roles, audit logging, and no secret/PII logging.
- Establish product shell/design tokens, test fixtures, database backup/PITR checklist, dependency/license policy, and observability redaction policy.

### Phase 1 — Canonical screenplay authoring

- Projects, screenplay creation, semantic elements, keyboard element switching, title pages, autosave, and scene/character navigation.
- Deterministic pagination foundation and accessible editor behavior.
- FDX import/export compatibility fixtures; deterministic PDF export through the server-side canonical renderer; and Word-compatible `.docx` export. Add Fountain/plain-text interchange where it does not compromise FDX quality.
- SmartType-style completion from document data.

### Phase 2 — Collaboration and durable version history

- Owner/editor/reviewer permissions, secure sharing, authenticated collaboration rooms, presence, local-only undo/redo, reconnection, and browser offline persistence.
- Append-only updates, checkpoints, automatic/named revisions, historical preview, screenplay-aware diff, and duplicate-as-new-screenplay.
- Restore-as-current epoch cutover with all acceptance tests listed above.

### Phase 3 — Review workflow

- Anchored, threaded comments; reviewer role; notifications as product requirements are defined.
- Track Changes with attributed insertions/deletions, navigation, filtering, individual and bulk accept/reject.

### Phase 4 — Story planning and navigation

- Beat Board, Outline Editor, structure/page targets, Navigator tables, filters, configurable views, and bidirectional scene/outline links.
- Alternate dialogue and character tooling after the core model is stable.

### Phase 5 — Production workflow

- Scene numbering with insertion suffixes, tags, reports, revision sets, color marks, locked pages, omitted scenes, and production export/report fixtures.

### Version 2 — Visual planning and storyboard board

Add a collaborative, freeform board of image and text cards for beats, reference imagery, and storyboards. Cards can be color-coded, connected, spatially arranged, commented on, and linked to stable script scenes or outline beats; links navigate in both directions. Include asset upload, collaborator presence, permissions, and PDF/image board export.

This deliberately provides a better version of Final Draft's image-capable Beat Board workflow, while excluding timed animatics, drawing tools, and production shot-list scheduling from V2. A later presentation/read-through mode may show storyboard frames as a toggleable side-by-side or full-screen script view; it must not affect screenplay pagination.

## Quality and security gates

Every feature is incomplete until all applicable gates pass:

1. Unit tests cover domain logic, validation, error paths, and permissions. New production functionality must meet at least 80% line and branch coverage unless a documented, reviewed exception explains why a metric is misleading.
2. Integration tests exercise the API, PostgreSQL migrations, authorization boundaries, Yjs persistence/reconstruction, imports/exports, and error handling against real service boundaries.
3. System tests use Playwright against a production build, including at least two independent browser contexts for collaboration features.
4. Run formatter, lint, strict typecheck, unit, integration, system, and relevant load/concurrency tests. Test output must be diagnosable and name failed actor/document scenario; do not hide failures.
5. A separate agent performs code review for correctness, security, race conditions, architecture fit, UI/accessibility, tests, and source-of-truth documentation.
6. Check for credentials, secret files, sensitive logs, insecure authorization, and dependency vulnerabilities before handoff. Never commit `.env` files or hard-code credentials.

## Agent, branch, review, and progress protocol

The repository was initialized by the user with baseline commit `ccf12db`. Project policy prohibits agents from making commits or merges on the user's behalf.

For each approved feature:

1. The lead records the task, acceptance criteria, owner, and intended branch in `progress.md` before implementation.
2. The assigned implementation agent works in an isolated `feature/<scope>` branch/worktree, changes only the agreed scope, and updates that branch's `progress.md` as work and verification progress.
3. The agent does not commit, merge, force-push, or stage unrelated files. It hands off a commit-ready diff with exact verification commands/results and known risks.
4. An independent review agent reviews the diff and updates `progress.md` with findings and disposition. The implementation agent resolves findings, then reruns every relevant gate.
5. Only after review, linting, type checks, unit tests, integration tests, and system tests pass may the user create the commit and merge the feature branch. The merge record and test evidence are appended to `progress.md`.

No agent may silently broaden scope, replace this plan, create a partial production workaround, or mark a task complete without test evidence. If requirements, architecture, or a security issue make the intended implementation invalid, stop and request a decision.

## Immediate next action

Complete and independently review the PostgreSQL, Better Auth, and authorized project/screenplay persistence foundation on `feature/persistence-foundation`, including the required real PostgreSQL integration gate. The next feature branch will establish deterministic pagination and print-preview fixtures; FDX/PDF/DOCX work follows the renderer foundation. Collaboration remains separately planned Phase 0 work and private documents must not be represented as launch-ready until the persistence foundation clears its integration gate.

## Research basis

- Final Draft feature set and production workflows: <https://www.finaldraft.com/products/features/>
- Final Draft semantic elements: <https://kb.finaldraft.com/hc/en-us/articles/27646947570196-What-are-script-elements>
- Yjs architecture and document updates: <https://docs.yjs.dev/> and <https://docs.yjs.dev/api/document-updates>
- Google Docs version-history UX: <https://support.google.com/docs/answer/190843>
- Railway PostgreSQL and WebSocket guidance: <https://docs.railway.com/databases/postgresql> and <https://docs.railway.com/guides/socketio>
- Railway private, S3-compatible object storage and export-worker patterns: <https://docs.railway.com/storage-buckets> and <https://docs.railway.com/guides/storage-buckets-guide>
- TanStack Router type-safe routes and validated search parameters: <https://tanstack.com/router/latest/docs/guide/type-safety> and <https://tanstack.com/router/latest/docs/guide/search-params>
- Playwright server-side PDF generation: <https://playwright.dev/docs/api/class-page#page-pdf>
- Tiptap editor core license and extension model: <https://github.com/ueberdosis/tiptap> and <https://github.com/ueberdosis/tiptap/blob/main/LICENSE.md>
- Final Draft element conversion and default Enter/Tab behavior: <https://kb.finaldraft.com/hc/en-us/articles/27648345770772-How-do-I-change-one-element-to-another-in-a-script> and <https://kb.finaldraft.com/hc/en-us/articles/27977488282644-What-keyboard-shortcuts-can-I-use-in-Final-Draft>
- Final Draft image-capable Beat Board: <https://kb.finaldraft.com/hc/en-us/articles/15575274173716-Is-there-any-way-to-integrate-storyboards-into-Final-Draft>
