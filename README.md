# Finaler

Finaler is an original, web-based professional screenwriting application. It is being designed around the writing, collaboration, revision-history, and production workflows screenwriters expect from professional screenplay software, while remaining independent of Final Draft's branding, visual design, and trade dress.

The project is currently in its engineering-foundation phase. No application functionality has been implemented yet.

## Product direction

Finaler will provide a structured screenplay editor rather than a generic rich-text editor. Screenplay elements, scene and block identifiers, keyboard-first authoring, deterministic pagination, FDX interchange, and PDF export are foundational requirements.

Planned major capabilities include:

- Professional screenplay authoring with projects, title pages, navigation, and SmartType-style completion.
- Authenticated sharing and real-time collaboration with offline recovery.
- Durable version history, named revisions, screenplay-aware diffs, and a safe restore-as-current workflow.
- Review tools, including comments and Track Changes.
- Planning and production workflows, followed by a collaborative storyboard and visual-planning board in Version 2.

The interface will feel like desktop authoring software: dense and keyboard-first, with toolbars, panes, split views, a status bar, square or subtly rounded controls, and deliberate visual hierarchy. It will draw interaction inspiration from Microsoft Office, Adobe applications, and Google Docs rather than generic dashboard component libraries.

## Intended stack

| Area | Planned technology |
| --- | --- |
| Web application | React, TypeScript (strict mode), Vite |
| API | Fastify on Node.js LTS |
| Authentication | Better Auth with PostgreSQL |
| Editor | Tiptap core / ProseMirror with custom screenplay extensions |
| Collaboration | Yjs over WebSockets, served by self-hosted Hocuspocus |
| Data | PostgreSQL and Drizzle migrations |
| File storage | Railway object storage or compatible S3 storage |
| Testing | Vitest, integration tests against real services, and Playwright |
| Deployment | Railway |

Yjs is the collaboration model, not a replacement for WebSockets. WebSockets transport updates; Yjs resolves concurrent and offline changes safely. Hocuspocus provides the self-hosted WebSocket protocol, persistence, and authorization integration.

The planned libraries are open source and self-hosted; they do not require a software subscription. Railway hosting, PostgreSQL, object storage, transactional email, domains, and any optional OAuth providers can incur operating costs.

## Status and roadmap

The approved roadmap begins with engineering foundations and a product-shell prototype, followed by the canonical screenplay editor and FDX/PDF fixture suite. Collaboration and durable revision history—including restore as current—come after the document model, pagination, and interchange behavior are proven.

The complete architecture, acceptance criteria, roadmap, and quality gates live in [plan.md](./plan.md). Do not treat this README as a substitute for that document.

## Development prerequisites

No local development environment is configured yet. When Phase 0 scaffolding begins, the expected prerequisites are:

- Current Node.js LTS and its supported package manager.
- PostgreSQL for local integration testing.
- A modern browser for Playwright system tests.
- Railway account and project configuration only when deployment work is explicitly underway.

Dependency versions, setup commands, environment-variable documentation, and local service instructions will be added as part of the Phase 0 implementation. Never commit `.env` files, credentials, tokens, or real production configuration.

## Source of truth and working record

- [plan.md](./plan.md) is the source of truth for scope, architecture, delivery order, quality gates, and operating rules. Update it deliberately when a decision changes.
- [progress.md](./progress.md) is the append-only record of work performed, verification evidence, review findings, handoffs, and merge outcomes.

## Contribution and branch policy

Each approved feature is developed in an isolated `feature/<scope>` branch or worktree after a baseline commit exists. The assigned agent records the task and acceptance criteria in `progress.md`, implements only the agreed scope, writes thorough tests, and hands off a commit-ready diff with exact verification results.

An independent review is required before handoff. Formatting, linting, strict type checks, unit tests, integration tests, system tests, relevant concurrency/load checks, and a security review must pass before a feature is ready to merge. The project owner controls all staging, commits, and merges; agents must not commit, merge, or force-push.

## Security and privacy

Screenplays are private by default. Sharing must be explicit and role-based. The application must use secure sessions and authorization checks, private asset storage with short-lived authorized URLs, encrypted network connections, and redacted logs. Screenplay content, credentials, and personal data must never be logged or sent to external AI services without explicit user authorization.

## License

No project license has been selected yet.
