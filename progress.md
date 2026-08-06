# Finaler Draft Progress Log

This is the append-only operational record for the project. It complements `plan.md`, which is the source of truth for decisions and scope.

## Logging rules

- Add an entry before starting a task, when a material decision/blocker occurs, after verification, and at handoff/merge.
- Include date/time, agent, branch/worktree, scope, files changed, commands/tests run, outcome, and remaining risk.
- Record facts and links to evidence. Do not log secrets, tokens, passwords, personal data, or full environment configuration.
- Agents update the copy on their feature branch while they work. The user includes the completed entries when committing/merging that branch.
- Never rewrite prior entries except to correct a factual error with a follow-up entry.

## Entry template

```text
### YYYY-MM-DD HH:MM TZ — <agent> — <branch>
Status: started | blocked | ready-for-review | verified | merged
Scope: <approved feature/task>
Changes: <files and concise description>
Verification: <commands and results>
Review: <reviewer and outcome, if applicable>
Risks/next: <known risks, blocker, or next handoff>
```

## Log

### 2026-08-06 — persistence foundation environment follow-up — feature/persistence-foundation

Status: ready-for-review
Scope: Make Drizzle generation and migration commands use the repository-root local environment file without package-level environment files or production configuration regressions.
Changes: Added a Node launcher and testable environment policy for `db:migrate` and `db:generate`. The launcher invokes Drizzle with Node's non-overriding `--env-file-if-exists` option pointed at the repository root only when `NODE_ENV` is unset or `development`; test and production omit that option and require injected configuration. Updated the developer guide and lint configuration for the launcher. No credentials, local environment values, staging, commit, or merge were recorded.
Verification: Passed policy coverage at 100% for statements, branches, functions, and lines; full workspace formatting, lint, strict typecheck, and coverage; production generation with an injected non-secret database URL; and `git diff --check`. Verified a production command without injected `DATABASE_URL` rejects configuration despite a root local file. Earlier local migration execution could not establish a connection to the local PostgreSQL endpoint from this worktree environment.
Review: Pending focused review.
Risks/next: Shell, Railway, and CI variables retain precedence because Node's environment-file loader does not replace existing variables. Re-run `pnpm --filter @finaler-draft/database db:migrate` once the Docker endpoint is reachable from this environment, then run the real integration suite.

### 2026-08-06 — persistence foundation final verification — feature/persistence-foundation

Status: verified
Scope: Complete all required gates after final security and request-bound corrections.
Changes: None beyond the final-review corrections recorded below.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`, `TEST_DATABASE_URL=<transient reachable URL> pnpm --filter @finaler-draft/api test:integration`, and `git diff --check`. Real PostgreSQL integration passed all 3 tests. The dedicated integration command also correctly fails without `TEST_DATABASE_URL`; compiled production startup correctly fails without persistence configuration, while the explicitly named browser-system-test mode starts only for the static-shell test. The 16 MiB request-bound test validates a >10 MiB, 24,997-node, 1.5-million-control-character canonical payload and an oversized 413 response.
Review: Awaiting independent final review; no commit/merge/staging occurred.
Risks/next: The Vite editor bundle warning remains documented and intentionally unsuppressed. User-controlled review, staging, commit, and merge are still required.

### 2026-08-06 — persistence foundation final-review corrections — feature/persistence-foundation

Status: ready-for-review
Scope: Resolve final review findings on authorization locking, true canonical wire bounds, project timestamps, explicit integration invocation, and secure production startup.
Changes: Replaced membership `FOR KEY SHARE` locks with `FOR UPDATE` locks so editor-to-reviewer downgrade and revocation serialize against an in-flight save. Screenplay creation now advances its parent project timestamp inside the same transaction. Set and documented a 16 MiB API bound derived from canonical resource caps; added a full 1.5 million control-character / 24,997-node wire-payload acceptance test and over-limit 413 test. The dedicated integration command now fails immediately when `TEST_DATABASE_URL` is absent. Production startup now fails without persistence configuration; only the explicitly named browser-system-test environment can serve the compiled static shell without it.
Verification: Passed focused API typecheck and coverage (16 tests; 97.22% statements/lines, 86.48% branches, 100% functions). Passed real disposable PostgreSQL integration after local service availability: 3 tests covering migrations/drift invariants, Better Auth sign-up/sign-in/session/API authorization, same-version saves, revocation race, and role-downgrade race. Verified the explicit integration command fails without `TEST_DATABASE_URL`. Full workspace gates and final independent review remain pending after these final corrections.
Review: Awaiting independent re-review.
Risks/next: No staging, commit, or merge occurred. The production/static startup distinction is intentionally tested by the browser-system environment; deployment must set complete persistence configuration.

### 2026-08-06 — persistence foundation final local gates — feature/persistence-foundation

Status: blocked
Scope: Re-run all local quality gates after remediation and confirm migration metadata has no further schema drift.
Changes: None beyond the verification-remediation entry below.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`, `DATABASE_URL=<disposable URL> pnpm --filter @finaler-draft/database db:generate`, and `git diff --check`. Config coverage is 100% in every metric; screenplay coverage is 100%; API coverage is 97.20% statements/lines, 86.48% branches, and 100% functions across `app.ts`, `auth.ts`, and `projects.ts`; web per-file coverage remains above 80%. The browser system test passed against the compiled production service with no persistence credentials. The existing Vite 500 kB editor-chunk warning remains intentionally unsuppressed and is separately planned for route-level code splitting.
Review: Pending independent final review.
Risks/next: The real PostgreSQL integration suite remains an unpassed gate because the transient local endpoint refused connections; it safely created no database. Do not merge until it passes against a reachable endpoint and an independent reviewer approves the complete diff.

### 2026-08-06 — persistence foundation verification remediation — feature/persistence-foundation

Status: blocked
Scope: Close the persistence foundation's remaining test, coverage, migration-drift, server-startup, and concurrency gaps without expanding product scope.
Changes: Added a disposable-PostgreSQL integration harness that creates and drops only a UUID-named `finaler_draft_test_*` database from `TEST_DATABASE_URL`, runs Drizzle migrations twice, verifies the migration schema and single-owner partial index, and exercises real Better Auth sign-up, sign-in, session, project/screenplay authorization, same-version save serialization, and revocation-versus-save behavior. Reworked save/create authorization to lock the membership row inside the write transaction, preventing a revocation race; added a schema-declared/generated migration for the single-owner index so Drizzle metadata and SQL no longer drift. Added valid near-maximum canonical-body and over-limit 413 coverage; the API's size limit is 2 MiB. The production server can now serve health/static system-test traffic with no persistence variables, while partial persistence configuration still fails validation and configured persistence remains protected. CI provisions PostgreSQL and runs migration integration plus generation/diff verification.
Verification: Passed API unit coverage with 16 tests (97.18% statements/lines, 86.48% branches, 100% functions across app/auth/projects) before final workspace rerun. The real integration command was invoked with a transient, user-supplied `TEST_DATABASE_URL` and made no database changes because the configured local PostgreSQL endpoint refused connections; cleanup is guarded so it does not issue cleanup queries after failed setup. Full workspace formatting/lint/typecheck/coverage/build/system rerun remains pending after the final documentation and config-test correction. No secret was written, logged, or staged.
Review: Independent final review remains required after real database availability and all gates pass.
Risks/next: This branch is not merge-ready. Start the local PostgreSQL service or supply a reachable disposable-test endpoint, rerun the integration command, then rerun full quality and browser-system gates. Email verification, reset, transactional email, rate limiting, sharing, collaboration, revision history, FDX, PDF, and DOCX remain out of scope.

### 2026-08-06 — persistence foundation agent — feature/persistence-foundation

Status: in progress
Scope: Establish the bounded PostgreSQL/Drizzle, Better Auth, and authorized project/screenplay persistence foundation required before autosave can connect the local editor to private documents.
Changes: Added a database workspace package and generated reviewed SQL migration for Better Auth's core tables plus projects, membership roles (`owner`, `editor`, `reviewer`), and screenplays. Added DI-composed Fastify auth transport and protected project/screenplay routes, canonical-screenplay validation, a 2 MiB request limit, SHA-256 snapshot hashes, and optimistic version-conflict responses. The project owner is represented exclusively by a membership row; no duplicate owner field can drift.
Verification: In progress. Focused API tests cover auth cookie forwarding, protected-route rejection, canonical validation, and save conflict behavior. A real disposable PostgreSQL integration test remains required before handoff.
Review: Pending independent review.
Risks/next: Email verification, password reset, transactional delivery, and public-launch hardening cannot be completed until the project selects an email provider/domain. They are deliberately not simulated or represented as complete. No staging, commit, or merge occurred.

### 2026-08-06 — Codex and independent editor reviewer — feature/transition-next-scene-heading

Status: verified
Scope: Final review and verification of the Transition-to-Scene-Heading keyboard-flow correction.
Changes: Changed only the local editor's Transition Enter mapping from Action to Scene Heading, with a regression test that inserts at the end of a Transition and confirms an empty Scene Heading with a fresh stable ID.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`, and `git diff --check`. The web suite contains 10 tests and retains enforced per-file coverage above 80%.
Review: Focused independent review approved the mapping, cursor position, documentation, and limited scope with no actionable findings.
Risks/next: This is a verified, uncommitted behavior correction. The user must review, stage, commit, and merge it. The Vite editor-bundle warning remains the separately documented performance follow-up.

### 2026-08-06 — Codex — feature/transition-next-scene-heading

Status: started
Scope: Change the local semantic editor's Enter transition from a Transition block to a Scene Heading block.
Changes: Created an isolated feature branch from user-committed semantic-editor label fix `6b4d534`. Updated `plan.md` to define this screenwriting-flow default.
Verification: Pending focused keyboard regression coverage and relevant quality gates.
Review: Pending focused review.
Risks/next: This is a local editor behavior adjustment only; it must preserve stable IDs, shared-schema validity, and the existing scope exclusions. No agent will stage, commit, or merge.

### 2026-08-06 — Codex — bugfix-semantic-editor-label-overflow

Status: verified
Scope: Correct the semantic editor's overflowing element-type labels without changing screenplay behavior, document data, or pagination scope.
Changes: Moved the element label from an absolute left-side gutter position that exceeded the page margin to a compact in-page line above each screenplay block. Added a production-browser assertion that the heading label anchors at the block's in-page top-left coordinate.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`, and `git diff --check`.
Review: Focused implementation and production-browser regression verification passed.
Risks/next: This is a verified, uncommitted CSS and system-test correction. The Vite editor-bundle warning remains the separately documented performance follow-up; this fix does not change it. The user must review, stage, commit, and merge the branch.

### 2026-08-06 — Codex — bugfix-semantic-editor-label-overflow

Status: started
Scope: Correct the semantic editor's overflowing element-type labels without changing screenplay behavior, document data, or pagination scope.
Changes: Identified the layout cause: the 82 px label plus 18 px gap is positioned outside a 0.8 inch page gutter. Created an isolated bugfix branch from user-committed editor revision `bb8886c`.
Verification: Pending CSS change and browser regression test.
Review: A small layout correction will receive focused verification before handoff.
Risks/next: Preserve the desktop editor visual hierarchy while keeping labels within the page. Do not change editor semantics or stage, commit, or merge.

### 2026-08-06 — Codex and independent editor reviewer — feature/phase-1-semantic-editor

Status: verified
Scope: Final review and verification of the local semantic screenplay-editor slice.
Changes: Replaced the static screenplay with custom Tiptap v3 screenplay nodes backed by the shared validation package. Added local semantic element conversion, Final Draft-style core Enter/Tab transitions, stable-ID-preserving splits and conversions, derived Navigator scenes, local undo/redo, empty-screenplay handling, accessible editing controls, and per-file coverage enforcement. No persistence, authentication, collaboration, FDX, PDF, DOCX, title-page editing, or print pagination was added.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`, and `git diff --check`. Web coverage is App 97.87% statements / 91.93% branches / 91.66% functions / 97.87% lines and screenplay editor 94.48% / 86.79% / 89.47% / 94.48%; per-file thresholds enforce 80% in every category. The local production test uses Chrome because the downloaded Playwright Chromium bundle is incomplete in this environment; CI installs its required Chromium runtimes.
Review: Independent review approved after selected-text splitting, per-file coverage, and empty-document behavior were corrected. No blocking findings remain.
Risks/next: The production editor bundle is 177.39 kB gzip and triggers Vite's 500 kB uncompressed-chunk warning. This is recorded in `plan.md` for route-level lazy loading and a bundle budget once routing is introduced; the warning must not be silenced. This feature is verified but uncommitted. The user must review, stage, commit, and merge it.

### 2026-08-06 — Phase 1 semantic editor correction agent — feature/phase-1-semantic-editor

Status: ready-for-review
Scope: Resolve independent review findings on local semantic-editor splitting, empty-document behavior, and module-level coverage enforcement.
Changes: Enter now respects both `TextSelection.from` and `TextSelection.to`: it preserves text before the selection, removes selected text, moves the remaining suffix into the next semantic block, retains the original block ID, and allocates a new UUID for the inserted block. The custom top-level editor document now permits zero screenplay blocks, projects that state as the shared schema's valid empty screenplay, and creates a fresh action block when Enter is pressed in an empty document. Enabled Vitest coverage enforcement per production file, not merely aggregate coverage. Added direct editor tests for non-collapsed and empty-boundary splits, keyboard dispatch, empty-document initialization, unsupported/malformed projection reporting, and no-active-block behavior.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test:coverage`. Web tests: 9 passing; per-file thresholds are enforced at 80%. `App.tsx` reports 97.87% statements, 91.93% branches, 91.66% functions, and 97.87% lines. `screenplayEditor.ts` reports 94.48% statements, 86.79% branches, 89.47% functions, and 94.48% lines. Passed `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` and `git diff --check`.
Review: This correction set is ready for the reviewer who raised the findings. No staging, commit, or merge occurred.
Risks/next: The slice remains intentionally local-only and unpaginated. Existing scope exclusions remain unchanged.

### 2026-08-06 — Phase 1 semantic editor implementation agent — feature/phase-1-semantic-editor

Status: ready-for-review
Scope: Replace the static screenplay sample with the bounded local semantic-editor slice specified in `plan.md`.
Changes: Added a custom Tiptap v3.23.6 document schema with screenplay-only blocks and stable UUID attributes; no StarterKit or generic paragraph schema is used. The editor projects every update to the committed `@finaler-draft/screenplay` validator, visibly reports invalid projections, derives Navigator scenes from that shared projection, preserves IDs for element conversions, and allocates fresh IDs for explicit caret splits. Implemented the approved Enter and Tab transitions, local undo/redo, active-element selector, accessible editing canvas, local word-count/validation status, and clear scope exclusions for unsupported nodes and operations. Replaced inert formatting controls and the fabricated page count. Added unit, UI-integration, and production-browser coverage. Pinned every installed Tiptap package, including transitive React menu dependencies, to exact v3.23.6 through root pnpm overrides to avoid version drift or peer mismatches.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test:coverage`. The web suite contains five editor-focused tests and reports 93.77% statements, 80.19% branches, 90.69% functions, and 93.77% lines across the application and editor module, above the enforced 80% floor. Passed `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` against the compiled production Fastify service; it exercises health, custom editor selection conversion, Navigator derivation, physical Enter insertion, local validation status, pane toggle, and zoom. `git diff --check` passed. Local Chrome is selected because this environment's downloaded Playwright Chromium is incomplete; CI continues to install its normal browser runtime.
Review: Awaiting independent code review. No agent staged, committed, or merged changes.
Risks/next: The canvas is intentionally a local, unpaginated semantic draft. It has no persistence, authentication, collaboration, title-page editing, dual-dialogue/page-break editing, imports, exports, or deterministic print layout. The current Vite bundle emits a non-blocking 500 kB chunk warning that should be addressed when route/editor code-splitting is introduced with TanStack Router, rather than obscuring this bounded editor delivery with premature bundler tuning.

### 2026-08-06 — Codex and Phase 1 implementation agents — feature/phase-1-semantic-editor

Status: started
Scope: Replace the static screenplay demonstration with a local semantic screenplay editor using the committed shared schema, custom Tiptap nodes, element switching, default Enter/Tab transitions, derived Navigator scenes, and local undo/redo.
Changes: Created this dependent feature branch from committed schema revision `5423afe`. Updated the source-of-truth editor behavior, scope exclusions, and acceptance direction in `plan.md` before implementation.
Verification: Pending implementation. Required gates are formatter, lint, strict typecheck, coverage-enforced unit tests, browser/editor integration tests, production system test, and independent code review.
Review: Pending architecture and final implementation review.
Risks/next: The editor must not silently create an alternate document model, mutate shared-schema contracts, or claim print-accurate pagination. No authentication, persistence, collaboration, FDX, PDF, DOCX, or title-page editor is included in this slice. No agent may stage, commit, or merge.

### 2026-08-06 — Codex and independent schema reviewer — feature/phase-1-screenplay-schema

Status: verified
Scope: Final review and verification of the bounded Phase 1 canonical screenplay-schema slice.
Changes: The completed package provides strict, versioned validation; flat stable-ID screenplay blocks; derived scenes; title pages; non-printing range-anchored notes; dual-dialogue invariants; global ID uniqueness; and explicit text, collection, and aggregate-node resource limits. It is wired into the workspace build/typecheck pipeline.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`, and `git diff --check`. The screenplay package has 21 tests and 100% measured statement, branch, function, and line coverage. The local system test uses Chrome because the downloaded Playwright Chromium bundle is incomplete in this environment; CI installs its required Chromium runtimes.
Review: Independent reviewer approved after three review passes. The initial review's dual-dialogue/scene/global-ID findings and final review's resource-composition and UTF-16 offset findings are resolved; no blocking findings remain.
Risks/next: This is a verified, uncommitted feature slice. The user must review, stage, commit, and merge it. The future API must apply a request-body byte limit before receiving untrusted snapshots; schema validation only constrains parsed canonical data. The editor, persistence, FDX, pagination, PDF, and DOCX remain unimplemented.

### 2026-08-06 — Codex and schema advisory reviewer — feature/phase-1-screenplay-schema

Status: verified
Scope: Resolve canonical-schema decisions before the Phase 1 implementation agent finalizes its public API.
Changes: Recorded a flat ordered screenplay block model; derived scene identity from stable scene-heading block IDs; out-of-band title pages; non-printing, range-anchored notes; explicit two-column dual dialogue; and exclusion of computed layout from canonical data.
Verification: Independent read-only review checked the plan against current application architecture and Final Draft interoperability constraints.
Review: The lead accepted and relayed the decisions to the implementation agent before handoff.
Risks/next: FDX import/export remains a later slice and must emit explicit diagnostics for unsupported source features rather than silently converting or discarding them.

### 2026-08-06 — Codex and Phase 1 implementation agent — feature/phase-1-screenplay-schema

Status: started
Scope: First Phase 1 delivery: a shared, versioned canonical screenplay schema, validation API, fixtures, and test suite. The editor UI, persistence, authentication, FDX conversion, pagination, and export implementation are not included in this slice.
Changes: Created the feature branch from user-committed `main`; implementation is delegated under the branch/review protocol.
Verification: Pending implementation. Required gates are formatter, lint, strict typecheck, coverage-enforced unit tests, integration checks where applicable, and independent review.
Review: Pending independent review after implementation.
Risks/next: The schema is a cross-cutting contract. Any ambiguity or architecture conflict must be raised before the implementation agent finalizes its public API. No agent will stage, commit, or merge changes.

### 2026-08-06 — Phase 1 schema implementation agent — feature/phase-1-screenplay-schema

Status: started
Scope: Implement the approved shared canonical screenplay schema package, realistic fixtures, and unit tests only.
Changes: Added `packages/screenplay` with strict Zod validation, a versioned public API, fixture exports, and coverage configuration. Updated the root build/typecheck orchestration to include the package and recorded the validation contract in `plan.md`.
Verification: Implementation in progress; focused package and full workspace quality gates will run before review handoff.
Review: Pending independent review.
Risks/next: The semantic model intentionally does not impose keyboard/editor sequencing rules or pagination behavior. Those belong to later editor and renderer slices.

### 2026-08-06 — Phase 1 schema implementation agent — feature/phase-1-screenplay-schema

Status: started
Scope: Apply the independent advisory constraints to the canonical schema before verification.
Changes: Replaced printable note blocks with separately anchored, non-printing annotations; separated title pages from body blocks; retained a flat body block order; and constrained dual dialogue to exactly two ordered columns with stable descendant IDs.
Verification: Pending focused and full quality gates.
Review: Binding advisory architecture decision received from the lead's independent reviewer.
Risks/next: Computed pagination and layout data remain intentionally absent from canonical persistence.

### 2026-08-06 — Codex — main

Status: verified
Scope: Record approved architecture decisions for routing and document export.
Changes: Updated `plan.md` and `README.md` to select TanStack Router with Zod-validated URL state and TanStack Query for REST resources; to make server-generated PDF and `.docx` downloads required Phase 1 work; and to define canonical PostgreSQL storage with temporary private object-storage export artifacts.
Verification: Checked the current TanStack Router, Playwright, and Railway documentation. The decisions introduce no implementation code or dependencies.
Review: The lead selected the design after evaluating the project boundaries and deployment model.
Risks/next: PDF/DOCX generation needs a dedicated feature branch, dependency/license review, fixture suite, and worker deployment before implementation. Legacy `.doc` is intentionally not planned.

### 2026-08-06 — Codex and Phase 0 agents — feature/phase-0-foundation-workspace

Status: ready-for-review
Scope: Phase 0 TypeScript workspace, deployable product-shell prototype, and quality baseline.
Changes: Added the pnpm workspace; React/Vite authoring-shell prototype; Fastify API with production static-client serving and health endpoint; validated configuration package; CI; exact dependency lockfile; local environment example; self-hosted IBM Plex Sans and Courier Prime typography; unit, integration, and production-system tests. Updated README, `.gitignore`, and plan status. Corrected review findings on dependency pinning, coverage enforcement, logging, same-origin deployment, UI semantics/layout, and documentation accuracy.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test:coverage`. Coverage is config 100% line/branch/function, web 100% lines/branches and 91.66% functions, API 100% line/branch/function; each exceeds the enforced 80% threshold. Passed `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` against the built Vite client served by Fastify, including `/api/health`, pane toggle, and zoom interaction. Playwright's downloaded Chromium bundle was incomplete in this environment; local Google Chrome was used only for this validation. CI installs the normal Chromium runtime.
Review: Preliminary independent review completed with blockers; all listed blockers were addressed. Final independent review is in progress.
Risks/next: No database, authentication, persistence, FDX/PDF fixtures, or editor semantics are implemented in this foundation slice by design. Awaiting final review outcome and the user's commit/merge decision.

### 2026-08-06 — Codex and independent Phase 0 reviewer — feature/phase-0-foundation-workspace

Status: verified
Scope: Final verification and review of the Phase 0 foundation slice.
Changes: Corrected the production start path so Railway and Playwright run the compiled Fastify server, added `railway.toml`, and aligned the README and system-test configuration with the same-origin production deployment.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test:coverage`. Passed `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`, which builds the workspace and exercises the compiled Fastify server, its static SPA fallback, `/api/health`, navigator toggle, and zoom interaction. The local Playwright Chromium download was incomplete, so local Chrome was selected only through `PLAYWRIGHT_CHANNEL=chrome`; CI installs its required Chromium runtimes before running the default test command.
Review: Independent review approved the final deployment and system-test changes with no remaining actionable blocking findings.
Risks/next: This is a verified, uncommitted foundation slice. The user must review, stage, commit, and merge it. Semantic screenplay editing, FDX/PDF fixtures, authentication, database persistence, collaboration, history, and storyboards remain unimplemented planned work.

### 2026-08-06 — Phase 0 verification agent — feature/phase-0-foundation-workspace

Status: started
Scope: Correct and verify the uncommitted Phase 0 workspace against independent review findings: reproducible dependencies, deployable same-origin service, safe startup behavior, UI-shell quality, and enforced test coverage.
Changes: Reviewing and correcting only Phase 0 implementation files; `plan.md` is intentionally not modified.
Verification: Pending dependency installation and full quality-gate execution.
Review: Findings supplied by the lead; a subsequent independent review remains required before handoff.
Risks/next: Existing uncommitted Phase 0 work is retained and corrected in place. No files will be staged, committed, or merged.

### 2026-08-06 — Phase 0 foundation agent — feature/phase-0-foundation

Status: started
Scope: Implement the approved Phase 0 TypeScript workspace, Fastify health API, functional authoring-shell prototype, quality tooling, and setup documentation; persistence, authentication, and database dependencies are explicitly out of scope.
Changes: Beginning scaffold in isolated `/private/tmp/finaler-draft-phase-0-foundation` worktree. `plan.md` will remain unchanged.
Verification: Initial repository inspection confirmed branch `feature/phase-0-foundation` is based on `ccf12db`; toolchain reports Node 24.16.0 and pnpm 10.17.1.
Review: Pending independent lead review.
Risks/next: Install dependencies, run all available quality gates, and report any browser-install limitation.

### 2026-08-06 — Phase 0 foundation agent — feature/phase-0-foundation-workspace

Status: started
Scope: Continue the approved Phase 0 implementation on the dedicated feature branch.
Changes: Worktree routing was corrected by the lead before dependency installation. The active implementation branch is `feature/phase-0-foundation-workspace`; the temporary `/private/tmp/finaler-draft-phase-0-foundation` worktree is unused.
Verification: Confirmed this correction before continuing implementation.
Review: Pending independent lead review.
Risks/next: Run install and all quality gates in the active workspace.

### 2026-08-06 — Codex — main bootstrap workspace

Status: verified
Scope: Correct product name in source-of-truth documentation.
Changes: Updated README, plan, and progress-log headings and product references to the full product name, Finaler Draft. The existing directory path remains unchanged.
Verification: Searched all root documentation and confirmed no standalone product-name references to the prior abbreviated form remain.
Review: Not required; documentation-only naming correction.
Risks/next: None.

### 2026-08-06 — Codex — main bootstrap workspace

Status: started
Scope: Phase 0 repository hygiene and documentation baseline.
Changes: Created Node/React-oriented `.gitignore`; updated `plan.md` to record authorization and the editor-shell/FDX-PDF-fixture priority. A delegated implementation agent is preparing the root README.
Verification: Confirmed Git repository exists but has no commits, so branches/worktrees cannot be created yet. Ignore rules intentionally do not exclude FDX or PDF test fixtures.
Review: Pending README review and user-created baseline commit.
Risks/next: This is a bootstrap exception to the branch protocol. After review, the user must create the first commit before agents can work on isolated feature branches.

### 2026-08-06 — Codex and README bootstrap agent — main bootstrap workspace

Status: verified
Scope: Complete Phase 0 documentation and ignore baseline.
Changes: Added `README.md`, `.gitignore`, and source-of-truth updates in `plan.md`; no application source, dependencies, credentials, or deployment resources added.
Verification: Reviewed README for accuracy against `plan.md`; `git diff --check -- .gitignore plan.md progress.md README.md` passed. Confirmed the ignore policy keeps FDX/PDF fixtures trackable and protects local environment files, build outputs, test artifacts, and local database files.
Review: README independently drafted by the bootstrap agent and reviewed by the lead; no findings.
Risks/next: All files remain untracked because the repository has no commit. The user must make the initial baseline commit before the required isolated feature-branch workflow can begin.

### 2026-08-06 — Codex, Locke, Hypatia, Sartre — planning

Status: verified
Scope: Greenfield audit, Final Draft parity research, version-history research, initial architecture plan.
Changes: Created `plan.md` and this progress log. No application code, repository initialization, dependencies, credentials, or deployment resources were created.
Verification: Confirmed workspace was empty and not a Git repository. Researched official Final Draft, Yjs, Better Auth, Hocuspocus, Google Docs, and Railway documentation; sources are recorded in `plan.md`.
Review: Research results cross-checked by separate agents for Final Draft parity and version restoration.
Risks/next: User must authorize Phase 0 implementation. Before branch/worktree workflow can operate, the user must initialize Git and create the baseline commit because agents do not commit or merge on the user's behalf.

### 2026-08-06 — Codex schema corrections agent — feature/phase-1-screenplay-schema

Status: verified
Scope: Correct the bounded Phase 1 canonical-schema review findings only.
Changes: Required each dual-dialogue column to begin with a character block and include dialogue; added the public pure `deriveScenes` helper for flat ordered scene-heading blocks; made stable IDs globally unique across the screenplay, title pages, root/nested blocks, and annotations; added coverage for each invariant; and aligned the canonical-model plan assertion with the implementation.
Verification: Passed `pnpm --filter @finaler-draft/screenplay test:coverage` (17 tests; 100% statements, branches, functions, and lines) and `pnpm --filter @finaler-draft/screenplay typecheck`. Focused Prettier formatting was applied before verification.
Review: Corrections implement the lead's specified code-review requirements; no independent merge review performed in this bounded task.
Risks/next: The schema slice remains uncommitted and must complete the full workspace quality gates and independent review before the user stages, commits, or merges it. No unrelated scope was changed.

### 2026-08-06 — Codex schema corrections agent — feature/phase-1-screenplay-schema

Status: verified
Scope: Complete workspace verification for the bounded canonical-schema corrections.
Changes: No additional implementation changes after the focused schema verification.
Verification: Passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, and `git diff --check`. Workspace coverage remains at or above the configured 80% threshold; the screenplay package is 100% across all measured categories.
Review: Pending the feature branch's independent review and user-controlled Git handoff.
Risks/next: Do not stage, commit, or merge this work on the agent's behalf.

### 2026-08-06 — Codex schema corrections agent — feature/phase-1-screenplay-schema

Status: ready-for-review
Scope: Resolve the independent final review's resource-bound and annotation-offset findings.
Changes: Added exported bounds of 10,000 root blocks, 10,000 annotations, 100 blocks per dual-dialogue column, 20,000 UTF-16 code units per authored-text field, and 1,500,000 UTF-16 code units for the complete canonical screenplay. Total-text accounting includes screenplay/title-page text, scene numbers, root/nested block text, and annotation text. Published the `Utf16CodeUnitOffset` and `AnnotationAnchor` types, documented JavaScript/ProseMirror UTF-16 semantics, and tested non-BMP plus combining-sequence range boundaries and rejection.
Verification: Passed focused `pnpm --filter @finaler-draft/screenplay test:coverage` (20 tests; 100% statements, branches, functions, and lines) and `pnpm --filter @finaler-draft/screenplay typecheck`. Passed workspace `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, and `git diff --check`.
Review: This entry resolves the final review findings but is intentionally not verified until the independent reviewer approves the changes.
Risks/next: Await independent final review, then user-controlled staging, commit, and merge. No agent has performed Git write operations.

### 2026-08-06 — Codex schema corrections agent — feature/phase-1-screenplay-schema

Status: ready-for-review
Scope: Resolve the final review finding that individually bounded arrays could compose into an oversized canonical node tree.
Changes: Exported and enforced `MAX_CANONICAL_NODES` at 25,000, counting each root block, both dual-dialogue column containers, and every nested dialogue-column block. Added composed near-boundary coverage: 24,969 canonical nodes are accepted and 25,172 are rejected while every individual array remains within its own limit. Updated the documented resource-bound contract.
Verification: Passed focused `pnpm --filter @finaler-draft/screenplay test:coverage` (21 tests; 100% statements, branches, functions, and lines) and `pnpm --filter @finaler-draft/screenplay typecheck`. Passed workspace `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, and `git diff --check`.
Review: The independent reviewer must re-review this correction before this feature slice is marked verified.
Risks/next: No staging, commit, or merge has occurred. Retain the individual resource and text limits alongside the aggregate node budget.

### 2026-08-06 — Codex environment-loading correction — feature/persistence-foundation

Status: ready-for-review
Scope: Correct root local-environment loading for the persistent API without creating per-application environment files.
Changes: Added an API startup environment loader that resolves the repository-root `.env` from the server module location, loads it only when present for local startup, and runs before strict configuration validation. It intentionally bypasses local files in injected production and browser-system-test modes. Node preserves values injected by the shell or Railway, so deployment configuration takes precedence and startup remains compatible with no local file. Documented the single-root-file rule and added isolated non-secret tests for startup policy, absent-file handling, local loading, and injected-value precedence.
Verification: Pending focused API and workspace quality gates.
Review: Pending independent review.
Risks/next: Do not inspect, print, stage, or commit any local `.env` file. The existing root ignore rules cover `.env` and `.env.*` while preserving `.env.example`.

### 2026-08-06 — Codex environment-loading correction verification — feature/persistence-foundation

Status: verified
Scope: Complete verification after correcting the production/browser-system startup policy for root local environment loading.
Changes: The loader now runs only for local startup. Injected production and browser-system-test processes bypass the local file, preserving production fail-closed behavior and allowing the static system server to start independently of local development configuration.
Verification: Passed focused API tests (19 unit tests; 3 integration tests skipped outside the explicit integration command), API typecheck, workspace formatting, lint, coverage, build, disposable PostgreSQL integration (3 tests), browser system test, and `git diff --check`. The existing unsuppressed Vite editor-chunk warning remains unchanged.
Review: Pending independent review.
Risks/next: No local `.env` contents were inspected, printed, staged, or committed. The earlier attempt to launch an integration command through a nonexistent worktree-local pnpm module was a tooling invocation error only; it made no database changes and was replaced by the standard verified integration command.

### 2026-08-06 — Codex environment-loading policy correction — feature/persistence-foundation

Status: ready-for-review
Scope: Tighten the local root-environment loader so test processes cannot read developer configuration.
Changes: The loader now runs only when process `NODE_ENV` is unset or `development`; it never runs for `test`, `production`, or browser-system-test processes. Added the test-environment regression case and clarified that the injected process environment determines this policy before a root file is considered.
Verification: Pending focused gates.
Review: Pending independent review.
Risks/next: No local `.env` contents were inspected, printed, staged, or committed.
