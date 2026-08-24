# Finaler Draft

Finaler Draft is an original, web-based professional screenwriting application. It is being designed around the writing, collaboration, revision-history, and production workflows screenwriters expect from professional screenplay software, while remaining independent of Final Draft's branding, visual design, and trade dress.

The project is in its engineering-foundation phase. It includes a tested workspace shell and local semantic screenplay editor. PostgreSQL persistence and Better Auth are being implemented on a dedicated branch and remain subject to real-database integration verification; imports/exports and collaboration are not yet implemented.

## Product direction

Finaler Draft will provide a structured screenplay editor rather than a generic rich-text editor. Screenplay elements, scene and block identifiers, keyboard-first authoring, deterministic pagination, FDX interchange, and PDF export are foundational requirements.

Planned major capabilities include:

- Professional screenplay authoring with projects, title pages, navigation, and SmartType-style completion.
- Authenticated sharing and real-time collaboration with offline recovery.
- Durable version history, named revisions, screenplay-aware diffs, and a safe restore-as-current workflow.
- FDX interchange plus downloadable, print-faithful PDFs and Word-compatible `.docx` files.
- Review tools, including comments and Track Changes.
- Planning and production workflows, followed by a collaborative storyboard and visual-planning board in Version 2.

The interface will feel like desktop authoring software: dense and keyboard-first, with toolbars, panes, split views, a status bar, square or subtly rounded controls, and deliberate visual hierarchy. It will draw interaction inspiration from Microsoft Office, Adobe applications, and Google Docs rather than generic dashboard component libraries.

## Intended stack

| Area            | Planned technology                                              |
| --------------- | --------------------------------------------------------------- |
| Web application | React, TypeScript (strict mode), Vite                           |
| Routing         | TanStack Router with Zod-validated route/search state           |
| API             | Fastify on Node.js LTS                                          |
| Authentication  | Better Auth with PostgreSQL                                     |
| Editor          | Tiptap core / ProseMirror with custom screenplay extensions     |
| Collaboration   | Yjs over WebSockets, served by self-hosted Hocuspocus           |
| Data            | PostgreSQL and Drizzle migrations                               |
| File storage    | Private Railway object storage or compatible S3 storage         |
| Exports         | Canonical renderer, headless Chromium PDF, OOXML `.docx`        |
| Testing         | Vitest, integration tests against real services, and Playwright |
| Deployment      | Railway                                                         |

Yjs is the collaboration model, not a replacement for WebSockets. WebSockets transport updates; Yjs resolves concurrent and offline changes safely. Hocuspocus provides the self-hosted WebSocket protocol, persistence, and authorization integration.

The planned libraries are open source and self-hosted; they do not require a software subscription. Railway hosting, PostgreSQL, object storage, transactional email, domains, and any optional OAuth providers can incur operating costs.

Screenplays are stored as canonical semantic data and revision snapshots in PostgreSQL, not as PDF or Word files. PDFs and `.docx` files are generated from a hash-identified snapshot; a private object bucket holds user assets, imports, and only short-lived asynchronous export results.

## Status and roadmap

The approved roadmap begins with engineering foundations and a product-shell prototype, followed by the canonical screenplay editor and FDX/PDF fixture suite. Collaboration and durable revision history—including restore as current—come after the document model, pagination, and interchange behavior are proven.

The complete architecture, acceptance criteria, roadmap, and quality gates live in [plan.md](./plan.md). Do not treat this README as a substitute for that document.

## Development prerequisites

The Phase 0 workspace is configured. Its prerequisites are:

- Current Node.js LTS and its supported package manager.
- PostgreSQL for local integration testing.
- A modern browser for Playwright system tests.
- Railway account and project configuration only when deployment work is explicitly underway.

`pnpm dev` builds the workspace packages before starting the API and the web client. That step is not optional and not a convenience: `apps/api` and `apps/web` import the workspace packages by their published entry points, which resolve to each package's `dist`, and `pnpm install` does not build them. Without it a fresh clone -- or an existing one after pulling a change to any package -- starts the API against whatever `dist` happens to be on disk, and fails with a module that "does not provide an export" naming something that plainly exists in the source. Run `pnpm build:packages` directly if you need the packages rebuilt without starting anything.

Install dependencies with `pnpm install`, then copy the root `.env.example` to the root `.env` and set the local persistence values before running `pnpm dev`. The API and Drizzle commands load only that root file when `NODE_ENV` is unset or `development`; do not create `apps/api/.env`, `apps/web/.env`, or `packages/database/.env` files. Test and production Drizzle commands require injected `DATABASE_URL` and never read a local file. Before considering that file, commands read process-injected variables first: shell, Railway, and CI values take precedence, and Railway predeploy works with injected variables alone. The API loads a local file only when `NODE_ENV` is unset or `development`, never in test, production, or browser-system-test mode. Run `pnpm --filter @finaler-draft/database db:migrate` after configuring a new local database; use `pnpm --filter @finaler-draft/database db:generate` only when intentionally generating a reviewed migration from schema changes. Build and launch the same-origin production service with `pnpm build` followed by `pnpm start`. Install the Chromium test runtime with `pnpm exec playwright install chromium chromium-headless-shell`, then run `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, and `pnpm test:system` before handoff. Railway uses the checked-in `railway.toml` to build, launch, and health-check the service. Never commit `.env` files, credentials, tokens, or real production configuration.

## Source of truth and working record

- [plan.md](./plan.md) is the source of truth for scope, architecture, delivery order, quality gates, and operating rules. Update it deliberately when a decision changes.
- [progress.md](./progress.md) is the append-only record of work performed, verification evidence, review findings, handoffs, and merge outcomes.

## Contribution and branch policy

Each approved feature is developed in an isolated `feature/<scope>` branch or worktree after a baseline commit exists. The assigned agent records the task and acceptance criteria in `progress.md`, implements only the agreed scope, writes thorough tests, and hands off a commit-ready diff with exact verification results.

An independent review is required before handoff. Formatting, linting, strict type checks, unit tests, integration tests, system tests, relevant concurrency/load checks, and a security review must pass before a feature is ready to merge. The project owner controls all staging, commits, and merges; agents must not commit, merge, or force-push.

### Gates

`.github/workflows/quality.yml` is the authority. It runs the full list -- formatting, lint, strict types, the Drizzle migration check, unit and integration tests, the build, and both browser suites including the database-backed persistence suite -- on every pull request and on pushes to `main`.

`.githooks/pre-push` is a local backstop, not a second authority. It runs only `format:check`, `lint` and `typecheck`: the subset that is fast enough to sit in front of a push, and enough to catch the failure this hook exists for -- a branch that was gate-clean when it was written but stopped being so once other work merged around it. A dead variable left behind when a merge removed its only reader is exactly that shape, and it reached `main` once already, because a branch verified in isolation is not the same thing as a branch verified against what it will land on.

The hook is wired by the `prepare` script (`git config core.hooksPath .githooks`), so `pnpm install` activates it and no manual setup step is needed. To skip it deliberately, set `FD_SKIP_PUSH_GATE=1`; prefer that to `--no-verify`, which disables every hook rather than this one.

## Security and privacy

Screenplays are private by default. Sharing must be explicit and role-based. The application must use secure sessions and authorization checks, private asset storage with short-lived authorized URLs, encrypted network connections, and redacted logs. Screenplay content, credentials, and personal data must never be logged or sent to external AI services without explicit user authorization.

## License

No project license has been selected yet.
