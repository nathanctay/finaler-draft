# Finaler Draft Product and Delivery Plan

**Status:** Phase 0 foundation was committed as `7e4b9f4`; the canonical schema slice as `5423afe`; the local semantic editor as `bb8886c`, with corrections `6b4d534` and `58bb4ee`; the authenticated database and API foundation as `bb2ce06`; and the persisted editor workflow as `1bce6d3`. An August 2026 audit of `1bce6d3` found the CI quality workflow cannot pass and recorded several defects; see the immediate next action. Pagination, FDX, export, collaboration, and billing remain separate deliveries.

This is the source of truth for product scope, architecture, delivery order, quality gates, and operating rules. Update it deliberately when a decision changes. Each delivery scope keeps its own append-only record at `progress/<scope>.md`; the root `progress.md` holds the historical record from before that convention.

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
| API                            | Fastify on Node 24 (Active LTS)                               | Typed REST API served from the same origin as the web client, and a clean place for authorization, exports, billing webhooks, and collaboration session checks. Pin Node 24 in `engines`, `.nvmrc`, CI, and Railway.                                                                        |
| Authentication                 | Better Auth with PostgreSQL                                   | Self-hosted email/password sessions for v1. Do not implement password handling ourselves. Sessions are same-origin, so no cross-site cookie relaxation is needed. Add verified-email, reset, and rate limiting before public launch.                                                        |
| Transactional email            | Resend                                                        | Required for email verification, password reset, and billing notices. Until it exists, a user who forgets a password has no recovery path and anyone can register an address they do not control.                                                                                           |
| Editor                         | Tiptap core / ProseMirror, custom screenplay extensions       | The document is structured screenplay data, not HTML or generic rich text. Use only open-source core features; do not depend on Tiptap Cloud or paid extensions.                                                                                                                            |
| Collaboration                  | Yjs via self-hosted Hocuspocus over WebSockets                | Yjs handles concurrent/offline document merging; Hocuspocus is the WebSocket server and persistence/auth integration.                                                                                                                                                                       |
| Primary data                   | PostgreSQL                                                    | Durable relational metadata, permissions, Yjs binary updates/checkpoints, revision projections, comments, and audit data.                                                                                                                                                                   |
| Files                          | Private Railway object storage or compatible S3 storage       | Imported files, image/storyboard assets, and short-lived asynchronous export artifacts. Canonical screenplay data stays in PostgreSQL.                                                                                                                                                      |
| Exports                        | Canonical renderer, headless Chromium PDF, and OOXML `.docx`  | Derive downloads from a hash-identified screenplay snapshot; do not make PDFs or Word files the source of truth.                                                                                                                                                                            |
| Deployment                     | Railway, single origin                                        | Fastify serves the Vite build and the API from one origin with Railway's CDN enabled. Hocuspocus, the export worker, and PostgreSQL are separate Railway services. Do not split the frontend to a second provider; see the deployment topology section.                                     |
| Billing                        | Stripe Billing, hosted Checkout and Customer Portal           | Recurring subscriptions with no card data reaching our servers. Entitlements derive from verified webhooks, never from a client redirect.                                                                                                                                                   |
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

### Deployment topology and origin policy

Everything runs on Railway. The web client and the API share one origin: Fastify serves the Vite build alongside `/api`. This is a deliberate decision, revisited and reaffirmed in August 2026 after evaluating a Cloudflare-frontend/Railway-API split.

```text
app.example.com   Railway service: Fastify serves the Vite build + REST API.  CDN enabled.
ws.example.com    Railway service: Hocuspocus.  Deploys independently.  Not proxied.
                  Railway service: export worker (headless Chromium).
                  Railway service: PostgreSQL.
```

Why single origin rather than a split frontend:

- The cost case does not survive arithmetic. Railway egress is $0.05/GB with no included allowance, and a cold visitor transfers about 320 kB. Even with the CDN disabled and every visitor cold, static egress is roughly $1.60/month at 100,000 monthly visitors, against a compute floor of $25–40/month that is identical either way. Railway's CDN, which is free on all plans and serves cache hits without incurring egress, removes nearly all of that.
- Railway's edge is no longer a weakness. Anycast BGP already terminated TLS at the nearest point of presence before the CDN existed, and Railway shipped its own multi-point-of-presence CDN in 2026.
- A split creates an entire class of bug this project does not currently have: credentialed CORS, preflight on every JSON mutation, an absolute API base URL per environment, and a second deploy pipeline for a pnpm workspace build.
- Preview environments are the specific trap. Provider preview hostnames sit under different registrable domains, so they are genuinely cross-site and `SameSite=Lax` sessions do not work there. Previews would need a different cookie configuration from production and would therefore stop testing the real one. Single-origin previews reproduce production exactly.
- Railway exempts WebSocket connections from request timeouts and keeps them open indefinitely while idle. Proxying them through a general-purpose CDN would inherit an undocumented idle timeout and provider-side disconnects.

Hocuspocus is a separate service on its own subdomain so that API deploys do not drop live editing sessions. That subdomain must not be proxied through a third-party CDN.

Consequences that must be honored:

- Because the SPA and API share an origin, `@fastify/cors` is not required for the web client. Do not add permissive CORS speculatively. If a genuine cross-origin consumer ever appears, add an explicit environment-configured allow-list of exact origins with `credentials: true`, never `Access-Control-Allow-Origin: *`, never reflected arbitrary origins, and integration tests for allowed, rejected, preflight, and credentialed cases.
- Session cookies are `Secure`, `HttpOnly`, and `SameSite=Lax`, set explicitly rather than left to library defaults, and covered by tests.
- Every request that carries identity is verified server-side. See the session verification section; a route guard in the browser is never a substitute.
- The Hocuspocus WebSocket handshake is cross-origin but same-site. CORS does not apply to WebSockets and browsers perform no preflight, so **the server must validate the `Origin` header itself**. Because Hocuspocus authenticates from a cookie the browser attaches automatically, an unvalidated `Origin` is a cross-site WebSocket hijacking vulnerability.
- Static assets must be served with correct caching. Vite emits content-hashed filenames, which require `public, max-age=31536000, immutable`; `index.html` requires `no-cache`. `@fastify/static` currently emits `Cache-Control: public, max-age=0` on every asset because no `maxAge` is configured, which is a freshness directive that overrides any CDN default and forces revalidation on every request.
- Every authenticated API response must carry `Cache-Control: private, no-store` explicitly rather than relying on a CDN's content-type heuristics. Railway's CDN cross-served authenticated responses during a 52-minute misconfiguration incident in March 2026; defense in depth is warranted for unpublished screenplays.

Origin policy does not authenticate anything. Every REST, export, asset, and collaboration endpoint must independently verify the Better Auth session and document/project authorization server-side.

### Session verification

Every request that carries identity is re-verified server-side. The client never supplies a user
identifier: the API derives one from the session cookie in a `preHandler`, and every query scopes
through `project_members`. That property is absolute and does not change. What is tunable is whether
verification costs a database round-trip.

**Current decision: verify against the database on every request.** Revocation is immediate, sign-out
genuinely ends a session, and the latency is invisible at present scale.

Measured in August 2026 against a local database, 50 requests each, with the roughly 9.4 ms client
process baseline subtracted:

| Work                                          | Cost    |
| --------------------------------------------- | ------- |
| Session verification (`session` table lookup) | ~2.8 ms |
| The authorized query it protects              | ~0.2 ms |

Session verification is therefore about fourteen times the cost of the query it guards, and it
competes for the same connection pool as real work.

**Planned change: enable Better Auth's `session.cookieCache`.** It keeps a short-lived signed copy of
the session in the cookie, so verification within the window is an HMAC check with no I/O, and the
next request past the window revalidates against the `session` table. Adopt it when any of the
following becomes true, not before:

- authenticated request latency becomes measurable to users, or the connection pool shows contention;
- Yjs collaboration ships. This is the likely trigger: Hocuspocus authenticates once per connection
  rather than per message, but presence, reconnection, and concurrent autosave traffic multiply
  authenticated requests substantially;
- a second application instance exists, since each one queries the same database for every request.

Do not adopt stateless tokens that skip verification entirely. Without a revocation path, a stolen or
post-sign-out token stays valid until expiry and sign-out stops meaning anything. That is an
unacceptable trade for a product holding unpublished creative work.

When `cookieCache` is enabled, **its `maxAge` is a security parameter, not a performance knob**: it is
the window during which an already-revoked session still functions. Record the chosen value here,
keep it short, default to five minutes, and add a test proving that sign-out stops access within the
stated window.

### Export architecture

**Pagination is a pure function, not a browser layout result.** A dedicated `@finaler-draft/layout` package takes a canonical screenplay and returns a deterministic page-and-line model. It measures against the known metrics of the embedded monospaced screenplay face rather than delegating to a layout engine. Both the in-browser print preview and the server-side PDF renderer consume that precomputed model; Chromium only paints it.

This is deliberate. If the preview and the export each derive their own page breaks from a layout engine, they depend on Chromium version parity between an arbitrary user's browser and the server, and they will diverge. Page count is contractual in this industry, and a script that previews at 112 pages must not export at 113. A monospaced screenplay face reduces to a fixed character-and-line grid with fixed per-element indents, which makes an exact implementation both tractable and far easier to test than browser layout: page counts become unit-testable assertions against FDX fixtures with no browser involved.

PDF export is a required Phase 1 capability, not a late optional feature. The server creates an immutable canonical screenplay snapshot, records its hash and revision, runs the layout function, and uses headless Chromium to paint the resulting page model to PDF. The client polls or subscribes to an export job and downloads a short-lived, authorized result. The export worker will likely need its own Dockerfile, because headless Chromium requires system libraries a buildpack will not reliably provide.

Provide `.docx` export in Phase 1 from the same canonical snapshot using an OOXML generator. It should preserve the screenplay's content, element semantics, page breaks, and basic page layout, but PDF is the fidelity contract for exact screenplay pagination. Do not support legacy binary `.doc` initially: `.docx` is the modern interoperable format, while reliable `.doc` generation would add a disproportionate compatibility burden.

Exports are derived artifacts, not stored screenplays. PostgreSQL holds the semantic screenplay, revisions, permissions, job metadata, and content hashes. Private object storage holds original imports, user assets, and only temporary export results needed by asynchronous workers; apply a lifecycle expiry and delete a result once it expires. Do not retain an export permanently unless a user explicitly requests an archival copy.

Export correctness requires fixture-driven tests: canonical screenplay to print-preview/page-count assertions, PDF text and page-image regression tests, DOCX package/semantic tests, authorization and expiry checks, and a test that an export made from a historical revision exactly identifies that revision rather than the mutable current document.

## Subscription and billing architecture

Finaler Draft will be a paid product. Billing uses Stripe Billing with hosted Stripe Checkout and the Stripe Customer Portal. This is not usage-based billing, so Metronome and the Billing Meters API are both out of scope; do not introduce metered pricing without an explicit plan change.

### Integration shape

- **Checkout Sessions in `mode: 'subscription'`** for purchase. Hosted Checkout handles Strong Customer Authentication, wallets, localization, and proration, and keeps us at the lowest PCI scope because no card data reaches our servers or our frontend.
- **Customer Portal** for upgrades, downgrades, cancellation, and payment-method updates. Do not hand-build subscription management UI; the Portal replaces a large amount of surface we would otherwise own and test.
- **Never pass `payment_method_types`.** Omitting it enables dynamic payment methods configured from the Dashboard. Hardcoding `['card']` silently disables every other method and costs conversion.
- **Model one Stripe Product per plan tier.** Attach multiple Prices to a Product only for variants of the same plan, such as monthly versus annual or alternate currencies. Checkout and invoice line items display the Product name, so tiers sharing one Product are indistinguishable to the customer. Never use the deprecated `plan` object.
- **Production runs on a restricted API key (`rk_`), not an unrestricted secret key (`sk_`).** Both are real Stripe credentials and the secret key is what the Dashboard issues by default, but Stripe's documented recommendation is to prefer restricted keys for server-side integrations, and they are drop-in replacements requiring no code change. Build in a sandbox with a test key, catalogue the calls from the key's request logs, then create a restricted key with matching permissions. For this integration that is expected to mean read and write on Customers, Subscriptions, Prices, Products, Invoices, Checkout Sessions, and Events; confirm against the actual logs rather than against this list. Keys live in Railway environment configuration, never in source, never in a committed environment file, and never in logs, error messages, or analytics. Add a pre-commit hook rejecting strings matching `sk_live_` and `rk_live_`.

### Entitlements derive from webhooks, never from the client

The Checkout success redirect is not proof of payment. A user can navigate to the success URL directly. Granting access on redirect is the single most common way subscription integrations leak paid features.

The authoritative flow is:

```text
Stripe webhook -> signature verification -> event dedupe -> subscriptions table -> API authorization check
```

Requirements:

- **Verify the webhook signature on every event** using the signing secret, before parsing or acting on anything. Treat the signing secret with the same care as an API key. Allowlist Stripe's published IP ranges on the webhook route for defense in depth.
- **The webhook route needs the raw request body.** Fastify's JSON parser will consume and re-serialize the body, which invalidates the signature. Register a raw-body content type parser scoped to that route only; do not disable JSON parsing globally.
- **Events are duplicated and arrive out of order.** Persist `event.id` and reject events already processed. Reconcile state from the event's subscription object rather than assuming ordered arrival, and treat `customer.subscription.*` and `invoice.*` as the state source.
- **Entitlement is a server-side authorization check**, evaluated in the same layer as project and screenplay authorization. It is never a client-side flag, never a route guard, and never inferred from a TanStack Query cache entry.
- Persist a `subscriptions` projection in PostgreSQL keyed to the Better Auth user, holding the Stripe customer id, subscription id, price id, status, current period end, and cancellation state. Stripe remains the source of truth; this table is a queryable cache that the webhook keeps current.

### The free tier

**The free tier is one fully editable screenplay.** Not a read-only preview, not a time-limited trial: a real, writable screenplay with the complete authoring feature set, so a writer can evaluate the actual product by using it for actual work.

A free account can: create and edit one screenplay, use every element, keyboard flow, and Navigator feature, and export to PDF, FDX, and DOCX. It cannot: create a second screenplay, or use collaboration and sharing.

Export is available on the free tier deliberately. A writer who cannot get their work out of a product has not been given a free tier, they have been given a hostage situation.

### What happens when a subscription lapses

**A writer must never lose access to their own work.** A lapsed or cancelled subscription drops the account to the free tier. It never deletes a screenplay, never hides one behind a paywall, and never removes export.

Concretely, a lapsed account retains: reading every screenplay it has, exporting every screenplay to PDF, FDX, and DOCX, editing one screenplay of the user's choosing, and account and billing management. It loses: creating new screenplays beyond that one, editing the others, and collaboration.

**A lapsed account with several screenplays must be asked which one stays editable.** The system must never pick on the user's behalf, and it must never fall back to the oldest, the newest, or the largest. Until the user chooses, all screenplays are readable and exportable and none is editable. This is the one place where the free tier and the lapse path differ, and getting it wrong silently is worse than prompting.

This is a product boundary, not an implementation detail. Unpublished creative work held hostage to a billing state is both a support burden and a serious reputational risk, and export must keep working precisely when a user is most likely to want their data out.

### Tax

Stripe Tax handles sales tax, VAT, and GST calculation for subscriptions, but it is not automatic and the failure mode is silent.

- **`automatic_tax: { enabled: true }` collects nothing, and returns no error, in any jurisdiction without an active registration.** The account appears configured while collecting zero tax. This is the most common Stripe Tax mistake and it cannot be corrected retroactively.
- Setup order is: set the head office address in Tax Settings, add a registration for each jurisdiction where there is an obligation, then enable `automatic_tax`.
- The product tax code goes on the Product and `tax_behavior` on the Price. Take the code from Stripe's canonical tax code list; never invent or hardcode one from memory, and do not default to the generic electronically-supplied-services code for US sales.
- Registrations recorded in Stripe only tell Stripe where we are already registered. They do not register us with any tax authority.
- Sandbox transactions contribute nothing to nexus threshold monitoring; the obligation clock starts at the first live transaction.
- **Which jurisdictions require registration is a legal determination for a tax advisor, not an engineering decision.** Do not add or expire a registration without explicit owner confirmation.

### Testing

- Use a Stripe sandbox and the Stripe CLI for local webhook forwarding. Test keys never go in source.
- Use **test clocks** to exercise the subscription lifecycle: renewal, trial expiry, dunning and failed payment, cancellation at period end, and immediate cancellation. Lifecycle bugs are otherwise undiscoverable before they happen to a real customer.
- Required coverage: signature rejection of a forged webhook, duplicate event delivery producing one state change, out-of-order delivery converging correctly, entitlement denial for an unpaid actor on every gated endpoint, and lapsed-account export remaining available.
- Tax registrations and settings are per-sandbox and must be recreated in live mode before the first real transaction.

### Open commercial decisions

Settled: the free tier is one fully editable screenplay with export, and a lapsed subscription drops to that tier rather than to read-only.

Still needing an owner decision before implementation: the price points, whether there is more than one paid tier and what distinguishes them, whether billing is flat per-user or per-seat on shared projects, and whether to offer a trial on top of the free tier. Seat-based pricing interacts with the Phase 2 sharing model and should not be chosen casually; flat per-user pricing with collaboration requiring the project owner to be subscribed is the simpler starting point.

Note that a free tier defined by screenplay count makes soft-delete a billing-relevant behavior: a soft-deleted screenplay must not count against the free limit, or a user can be locked out by work they already discarded. Purge or exclusion rules must be settled alongside the entitlement check.

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

The editor route is lazy-loaded behind the TanStack Router route tree. The documented bundle budget, enforced in CI as a build step that fails on regression, is:

| Artifact          | Budget (gzip) |
| ----------------- | ------------- |
| Entry chunk       | 120 kB        |
| Lazy editor chunk | 200 kB        |
| CSS               | 20 kB         |

The editor allowance carries deliberate headroom for Yjs, `y-prosemirror`, and the Hocuspocus provider. Do not suppress Vite's default 500 kB uncompressed-chunk warning.

Formatting, keyboard behavior, pagination, and PDF export are product-critical. Do not start Final Draft-style locked pages, colored production revisions, or scene-number insertion rules until deterministic pagination and a robust FDX fixture suite exist.

The editor shell and FDX/PDF fixture suite are explicit first-class Phase 0/1 deliverables. Do not defer them behind generic account screens or collaboration plumbing.

## Screenplay page format

These are the industry conventions the product must produce. They are the contract the layout package implements, the PDF renderer paints, and the FDX fixtures assert. They are not styling preferences and must not be adjusted to make a layout problem easier.

Every measurement is from the physical page edge on US Letter, 8.5 by 11 inches.

### Manuscript and interface are separate type systems

Everything in this section governs the **manuscript**: the page, its margins, and the screenplay text on it. None of it governs the **interface** around the page — menu bar, toolbar, Navigator, Inspector, status bar, entry and project screens.

The two are deliberately unrelated. The manuscript is a fixed physical artefact reproducing an industry standard that predates the product; its measurements are inches and characters and may not be adjusted for visual taste. The interface is desktop authoring software as described under UI and interaction direction; its measurements are pixels and it is free to be dense, responsive, and styled to the design tokens.

Two consequences that are easy to get wrong:

- Manuscript metrics must never leak outward. Applying 12 pt type or single-spaced leading to interface chrome would make the application enormous and sparse.
- Interface conventions must never leak inward. A comfortable reading `line-height`, a responsive width, or a scaled type ramp applied to the page silently destroys the character and line grid, and with it the page count.

Zoom is the one control that crosses the boundary, and it crosses in one direction only: it scales the rendered manuscript and leaves the interface at its natural size.

### Typeface

**12 pt Courier at 10 pitch. No exceptions, no user setting, no fallback.** Ten characters per inch is what makes page count meaningful: it is why one page approximates one minute of screen time, and it is the reason the layout package can be a pure function rather than a measurement of rendered text. Every horizontal measurement below therefore has an exact character equivalent, and the layout engine should work in characters and lines internally, converting to inches only at render.

### The character grid is normative; inches are derived

Line breaking is integer character counting against fixed budgets: 60 characters for action, 35 for dialogue, 20 for parenthetical. **Those budgets are the specification.** The inch measurements throughout this section are a rendering projection of them.

Pagination must never consult a font's advance width. Never compute a character capacity by dividing an inch measurement by a measured glyph width; that single line would make the layout package font-dependent and reintroduce the browser-versus-server divergence the pure-function design exists to prevent.

This has a useful consequence. Because breaks are character counts, pagination stays identical even if Courier Prime fails to load and a fallback monospace renders in its place. Physical widths would differ; page breaks would not.

Measured in Chrome in August 2026, Courier Prime's advance is **1228/2048 em = 0.599609375**, not exactly 0.6. That yields 10.0065 characters per inch rather than 10.0000, so a 60-character line measures 5.996 in against a nominal 6.0 in — 0.1 mm short over a full measure. The deviation is accepted and must not be corrected with letter-spacing or a transform, which would fight the font's real metrics and misbehave under zoom.

The direction is what makes it safe: a full measure falls _short_ of the body width rather than crossing it. A ratio above 0.6 would have overflowed the right margin and would have been a genuine defect.

Record the measured ratio as a constant with its provenance, and pin it with a regression test. If the typeface is swapped, or the webfont silently fails to load and a fallback is measured, that test should fail loudly rather than the page quietly reflowing.

### Page geometry

| Region                 | Measurement                          | Characters |
| ---------------------- | ------------------------------------ | ---------- |
| Left margin            | 1.5 in                               | —          |
| Right margin           | 1.0 in                               | —          |
| Top margin             | 1.0 in                               | —          |
| Bottom margin          | 0.5 to 1.5 in, set by the page break | —          |
| Body width             | 6.0 in                               | 60         |
| Page number from top   | 0.5 in                               | —          |
| Page number from right | 0.75 in                              | —          |

The variable bottom margin is deliberate: the break rules below decide where a page ends, and the remaining space is whatever is left. Do not pad content to force a uniform bottom edge.

### Vertical metrics

| Property       | Value                            |
| -------------- | -------------------------------- |
| Leading        | 12 pt, single-spaced             |
| Lines per inch | 6                                |
| Body height    | 9.0 in at a 1.0 in bottom margin |
| Lines per page | 54 to 55                         |

Leading equals type size: 12 pt type on 12 pt leading. This is not a stylistic choice. It is what makes six lines fill an inch, which is what makes a full page 54 to 55 lines, which is what makes one page approximate one minute of screen time. A CSS `line-height` of 1.0 satisfies it; any larger value silently reduces the page to fewer lines.

The vertical grid is the exact counterpart of the horizontal one. Ten characters per inch fixes where lines break; six lines per inch fixes where pages break. Both are required for a page count to mean anything, and neither may be treated as presentation.

### Vertical spacing between elements

Spacing between elements is measured in **whole lines on the six-per-inch grid**, never in pixels. Every blank line consumes one of the 54 to 55 lines on the page, so inter-element spacing is a pagination input, not a styling choice. A gap of "about a line and a half" is not a valid value.

Blank lines before each element:

| Element       | Blank lines before |
| ------------- | ------------------ |
| Scene heading | 1                  |
| Action        | 1                  |
| Character     | 1                  |
| Parenthetical | **0**              |
| Dialogue      | **0**              |
| Transition    | 1                  |
| Shot          | 1                  |

**A speech is contiguous.** Character, parenthetical, and dialogue run on consecutive lines with no blank line between them, in any combination: character to dialogue, character to parenthetical, parenthetical to dialogue, and dialogue to a mid-speech parenthetical. The blank line before a character element is what separates one speech from the next; inserting one inside a speech breaks the block apart visually and inflates the page count.

Some production houses double-space before a scene heading. One line is the default here. If that becomes a requirement it belongs in document settings, and it must feed the layout package rather than being applied as presentation.

**No editing affordance may consume grid space.** Element-name labels, selection outlines, comment markers, collaborator cursors, and anything else the editor draws to help a writer work must render as overlays: absolutely positioned, `pointer-events: none` where appropriate, and taking zero layout space. If a view toggle changes where lines sit, it changes where pages break, and the same screenplay reports different page counts depending on an editor setting the writer may not connect to the number. Editing affordances are view state and belong in local UI state or a user preference — never in document settings, and never in the canonical screenplay, which travels between users and machines.

### Element indents

| Element       | Left   | Right  | Width  | Characters    |
| ------------- | ------ | ------ | ------ | ------------- |
| Scene heading | 1.5 in | 1.0 in | 6.0 in | 60            |
| Action        | 1.5 in | 1.0 in | 6.0 in | 60            |
| Character     | 3.7 in | —      | —      | —             |
| Dialogue      | 2.5 in | 2.5 in | 3.5 in | 35            |
| Parenthetical | 3.1 in | —      | 2.0 in | 20            |
| Transition    | —      | 1.0 in | —      | right-aligned |
| Shot          | 1.5 in | 1.0 in | 6.0 in | 60            |

Three of these need comment, because the owner's stated figures and the most common industry values differ slightly and the difference should be a decision rather than an accident:

- **Character at 3.7 in.** The Final Draft default and the most widely reproduced value. Adjustable.
- **Parenthetical at 3.1 in.** Roughly half an inch inside the character indent, which 3.7 minus 3.1 satisfies. Adjustable.
- **Parenthetical width of 2.0 in.** The common convention. Adjustable.

These are defaults, not constraints. Every one is exposed in document settings, so a writer who prefers a different house style can set it; the defaults only need to be right for someone who never opens that dialog.

Dual-dialogue column geometry is **not yet specified** and must be settled before dual dialogue can paginate or export.

### Why no text-measurement library

Text-measurement and layout libraries such as Pretext were evaluated and are deliberately not used for screenplay layout.

At 10 pitch every glyph is exactly 0.1 in wide, so line breaking is arithmetic on character counts against a fixed budget — 60, 35, or 20 characters depending on element — not measurement of rendered text. A measurement library solves a problem the monospace requirement removes.

More decisively, such libraries measure through the browser's font engine via Canvas, which makes them unavailable to the export worker. The layout package must produce byte-identical page models in the browser and on the server, which is the entire reason it is a pure function. Introducing a browser-only measurement step would reintroduce the divergence that decision exists to prevent.

One idea is worth taking without the dependency: use `Intl.Segmenter` directly for grapheme-aware counting, so a combining sequence or an emoji occupies one grid cell rather than several code units. It is a platform API in both Node and the browser. Note that this is a different unit from the schema's annotation offsets, which are UTF-16 code units and must stay that way.

### Page numbering

- Arabic numerals by default, top right.
- **The first page of the screenplay carries no number. Numbering begins at 2 on the second page.**
- The title page is never numbered and never counted. It is not page 1.
- Roman numerals are available as a document setting. The setting is offered because "Arabic numerals" is unfamiliar phrasing to many writers; label it in plain language such as "Numbers" and "Roman numerals" rather than by numeral-system name.

### Page break rules

The layout package decides breaks. These rules are the specification:

- **A scene heading never ends a page.** It stays with the action that follows it; if both do not fit, the heading moves to the next page.
- **A single orphaned line of dialogue moves to the next page** rather than sitting alone at a page foot.
- **Long dialogue splits across the break.** When it does:
  - `(MORE)` is placed at the foot of the first part, at the character indent.
  - The continuation on the next page repeats the character name followed by `(CONT'D)`.
  - Both are generated automatically and **both must be deletable by the writer.** Automatic insertion that cannot be removed is a defect, not a feature.

`(MORE)` was not in the owner's original list and is added here: without it the split reads as two separate speeches by the same character.

### Character names and extensions

A character element may carry an extension on the same line, such as `MARA (V.O.)`.

**The Navigator's character list strips extensions before grouping.** `MARA`, `MARA (V.O.)`, and `MARA (O.S.)` are one character, not three. Strip the full conventional set — `(V.O.)`, `(O.S.)`, `(O.C.)`, `(CONT'D)` — and treat any trailing parenthetical on a character line as an extension rather than matching a fixed list. Note the trailing period in `(V.O.)` and `(O.S.)`; accept the period-less spellings on import but normalise on output.

### Title page

A new screenplay gets a dedicated title page by default, containing placeholder text blocks:

- Title
- "written by"
- Author name
- A contact block in the lower right: name, address, phone number, email

All are ordinary deletable text blocks. The title page never paginates with the screenplay body and never receives a page number.

### Scene numbers

A document setting, **disabled by default**. When enabled, every scene heading receives a number, right-aligned.

This is display only and belongs to Phase 1. It is distinct from the Phase 5 production feature, where scene numbers are locked and inserted scenes take suffixes such as `A1`. Do not conflate them: the Phase 1 setting renumbers freely as scenes move; the Phase 5 feature deliberately does not.

### Document settings

A dialog under the File menu. Adjustable: character indent, parenthetical indent and width, page-number position and numeral style, scene numbers on or off.

Not adjustable, ever: the typeface, the type size, the pitch.

The parenthetical indent shows an inline warning when it is set more than half an inch from the character indent in either direction. A warning, not a block — the writer may have a reason.

**These values are document state, not application preferences.** They live in the canonical screenplay, travel with it through export and import, and are inputs to the layout package. A screenplay must paginate identically on any machine and for any collaborator, so a setting stored per user or per browser would break the pagination contract.

### Application shell

The shell is fixed to the viewport. **The manuscript is the only thing that scrolls vertically with the page**, and the panels scroll independently of it if their own content overflows.

- Title bar, menu bar, and toolbar are always visible at the top.
- The status bar, if retained, is always visible at the bottom.
- The editor region scrolls; the shell around it does not move.
- Navigator and Inspector scroll their own content independently, and overlay the page at narrow widths.

`.application` currently uses `min-height: 100vh`, which lets the grid grow past the viewport instead of constraining it. Measured at an 800 px viewport, the shell computes to 1290 px tall and the status bar's bottom edge lands 490 px below the fold, so a writer has to scroll the whole application to discover it. The editor region is not scrolling at all in that state — its `scrollHeight` equals its `clientHeight`; the row simply expands to fit the 1144 px page. A fixed viewport height is what makes `minmax(0, 1fr)` constrain the row and hand the scrolling to the editor where it belongs.

Zoom belongs in the toolbar, alongside the other controls that act on the document view, rather than in the status bar where it is easy to miss.

The status bar carries the active scene, the word count, and the save state. Save state in particular must not be hidden below the fold: it is the writer's only signal that their work is persisted. If the status bar is ever removed, save state has to move somewhere permanently visible first.

### Viewport and zoom

The editor presents a fixed physical page, in the manner of Microsoft Word and Google Docs:

- The page is always 8.5 by 11 inches at the current zoom. It never reflows to the window.
- As the window narrows, the surrounding whitespace shrinks first.
- Once the whitespace is gone, the page area scrolls horizontally. It does not compress the page.
- Zoom changes the rendered scale of the whole page, not the text size within a reflowing container.
- At narrow widths the Navigator and Inspector overlay the page rather than displacing it, which is the behaviour already observed and preferred.

**The current implementation is wrong and produces a visible defect.** `.page` is `width: min(100%, 8.5in)`, so the page shrinks below 8.5 in as the window narrows, while element indents stay at fixed inch values. A character element at a 3.7 in indent inside a page that is now 5 in wide is pushed toward and eventually past the right edge. Zoom is also implemented as a font-size percentage on `.page`, which reflows text instead of scaling the page; `transform-origin: top center` is already set, indicating scale was the original intent.

This model is not only more familiar, it is the only one consistent with the rest of the plan: the layout package computes a page in inches and characters, and the screen must show that same page rather than a fluid approximation of it.

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
- Registration must visibly state every password requirement beneath the password field, require a confirm-password field with an inline match error before submission, and surface safe server-side validation feedback. Sign-in and registration password fields must offer an accessible, opt-in visibility toggle that preserves the entered value and exposes its state to assistive technology.
- Define and test the single-origin deployment, cookie, and static-caching policy before public deployment. Do not add speculative CORS; see the deployment topology section.
- Apply rate limiting to authentication endpoints and a global request cap. This is foundation work, not pre-launch work: credential stuffing is live the moment the service is reachable.
- Establish product shell/design tokens, test fixtures, database backup/PITR checklist, dependency/license policy, and observability redaction policy.

The design-token system is a prerequisite for further interface work, not a parallel task. Without it, each contributor picks values by eye and the interface drifts toward a generic component-library appearance.

### Phase 1 — Canonical screenplay authoring

- Projects, screenplay creation, semantic elements, keyboard element switching, title pages, autosave, and scene/character navigation.
- Rename and soft-delete for projects and screenplays. Deletion is always soft; screenplays are the asset a user least wants a stray click to destroy.
- The deterministic pagination layout package and accessible editor behavior, implementing the screenplay page format section in full: page geometry, element indents, page numbering from 2, and the break rules including `(MORE)` and `CONT'D`.
- The fixed-page viewport and scale-based zoom described in that section. The current fluid page is a live defect: centred elements drift off the right edge as the window narrows.
- Character-extension stripping in the Navigator, so `MARA` and `MARA (V.O.)` are one character.
- The default title page, and the scene-number display setting.
- Document settings as document-level state travelling with the screenplay. The values are Phase 1 because pagination depends on them; the settings dialog itself may land late in the phase, but the defaults and their storage cannot.
- FDX import/export compatibility fixtures; deterministic PDF export painted from the layout package; and Word-compatible `.docx` export. Add Fountain/plain-text interchange where it does not compromise FDX quality.
- A canonical round-trip test asserting that screenplay to editor projection and back is the identity function. This becomes load-bearing once FDX import exists.
- SmartType-style, context-aware completion. Scene-heading input must suggest screenplay prefixes such as `INT.`, `EXT.`, `INT./EXT.`, and `I/E.`, then reuse locations and times already authored in the document; character input must suggest previously authored characters. Suggestions must be keyboard-operable, never replace text without an explicit accept action, and stay local to the screenplay unless a future user-controlled project dictionary is designed.

Collaboration transport moved forward into this phase. The interim autosave sends the entire canonical screenplay on every debounced save, which at feature length is several hundred kilobytes per save and does not scale. That autosave is explicitly scaffolding: when Yjs lands, the Yjs document becomes the source of truth, the canonical JSON column becomes a projection, and the version column, whole-document `PUT`, and terminal 409 conflict handling are removed. Do not invest further in conflict-recovery interface work, because a CRDT has no conflicts to recover from.

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

### Launch readiness

Public launch is gated on a workstream that runs alongside the feature phases rather than inside one of them. None of it is optional, and none of it should be discovered late:

- Transactional email through Resend, with verified-email and password-reset flows. Until this exists there is no account recovery path at all.
- Rate limiting on authentication and a global request cap.
- Stripe Billing, entitlement gating, and the Customer Portal, with the commercial decisions in the billing section settled.
- Stripe Tax registrations confirmed with a tax advisor before the first live transaction.
- Terms of service, privacy policy, and a documented data-retention and account-deletion path.
- Database backup and point-in-time-recovery verified by an actual restore rehearsal, not by the existence of a backup setting.
- Dependency vulnerability and license review.

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

1. The lead records the task, acceptance criteria, owner, and intended branch in `progress/<scope>.md` before implementation, including an explicit out-of-scope list. The lead advises; it does not implement.
2. The assigned implementation agent works in an isolated branch and worktree, changes only the agreed scope, and updates `progress/<scope>.md` as work and verification progress. Worktrees live at `~/Documents/finaler-draft-worktrees/<scope>`, never under a temporary directory: agents never commit, so a worktree always holds uncommitted work, and a temp sweep has already destroyed a slice of this project once.
3. The agent does not commit, merge, force-push, or stage unrelated files. It hands off a commit-ready diff with exact verification commands/results and known risks.
4. An independent review agent reviews the diff and updates `progress.md` with findings and disposition. The implementation agent resolves findings, then reruns every relevant gate.
5. Only after review, linting, type checks, unit tests, integration tests, and system tests pass may the user create the commit and merge the feature branch. The merge record and test evidence are appended to `progress.md`.

No agent may silently broaden scope, replace this plan, create a partial production workaround, or mark a task complete without test evidence. If requirements, architecture, or a security issue make the intended implementation invalid, stop and request a decision.

## Immediate next action

An audit of `main` at `1bce6d3` found that the CI workflow cannot pass: `pnpm typecheck` fails on a clean checkout because leaf packages are typechecked rather than built and their declarations never exist, and `pnpm format:check` fails on files committed unformatted. It also found that `POST /api/auth/sign-out` returns 500, and that the API error handler converts every client error into a 500. Until those are fixed, no branch can produce trustworthy verification evidence, so the recorded gate results in earlier `progress.md` entries should not be relied on.

The delivery order is therefore:

1. `fix/ci-green` — make the gates trustworthy. In progress.
2. `chore/design-tokens` — extract the token system from the 92 distinct color literals currently in `styles.css`. Unblocks all interface work.
3. `feature/auth-hardening` — password requirements interface, shared validation-code allowlist, rate limiting, explicit cookie attributes, Resend for verification and reset.
4. `chore/platform-hygiene` — unify on a single Zod major across the workspace, split server environment parsing out of the shared policy package, and adopt a typed Fastify route contract.
5. `feature/project-screenplay-crud` — rename and soft-delete.
6. `feature/pagination-engine` — the pure layout package, then the renderer.

Yjs follows item 4 and may run alongside item 6. Billing follows the commercial decisions recorded in the billing section. Private documents must not be represented as launch-ready until the launch-readiness list is complete.

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
- Railway pricing, egress rates, and CDN: <https://docs.railway.com/pricing/plans>, <https://docs.railway.com/networking/cdn>, and <https://docs.railway.com/networking/edge-networking>
- Stripe subscription integration design and Customer Portal: <https://docs.stripe.com/billing/subscriptions/design-an-integration>, <https://docs.stripe.com/saas>, and <https://docs.stripe.com/customer-management/integrate-customer-portal>
- Stripe webhook signature verification and API key practice: <https://docs.stripe.com/webhooks> and <https://docs.stripe.com/keys/restricted-api-keys>
- Stripe Tax setup and registration requirements: <https://docs.stripe.com/tax/set-up> and <https://docs.stripe.com/billing/taxes/collect-taxes>
