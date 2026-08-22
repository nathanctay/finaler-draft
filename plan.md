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
                  Railway service: export worker (see "Superseded" note under Exports).
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

PDF export is a required Phase 1 capability, not a late optional feature. The server creates an immutable canonical screenplay snapshot, records its hash and revision, runs the layout function, and produces a PDF from the resulting page model. The client polls or subscribes to an export job and downloads a short-lived, authorized result.

**Superseded: the PDF is generated directly from the layout model, not painted by headless Chromium.** This section originally specified a headless-Chromium worker with its own Dockerfile, written when the browser was the only thing that knew where lines fell. `packages/layout` now computes the page and line model exactly and deterministically without a browser, so Chromium would re-derive layout the product already owns -- and disagreement between browser text metrics and this specification is the precise failure the layout package exists to prevent. It is not a hypothetical one: a CI font-hinting difference silently widened glyph advances and broke every character-grid assertion (`progress/test-harness-hardening.md`). Generating the PDF directly makes it a pure function of the canonical model, testable in process, with no worker service, no Dockerfile, and no browser in the fidelity path. The export worker and its Dockerfile are therefore not required; if a future need reintroduces them, it must be for a reason other than layout.

**Positioning comes from the grid, never from font metrics.** Every line is placed at coordinates derived from `pageFormat`'s character-and-line grid, exactly as `MEASURED_COURIER_PRIME_ADVANCE_EM` is already forbidden from driving layout. This is what makes the typeface a rendering detail rather than a layout input.

**Typeface: the PDF standard Courier while export runs client-side; Courier Prime once it moves server-side.** Courier is one of PDF's fourteen standard fonts, present in every viewer, requiring no embedded font file, and its advance is exactly 0.6em -- precisely the specification's ten characters per inch. Courier Prime is the better-looking face and matches the editor, but embedding it means shipping a font binary and a font-embedding path. Because positions come from the grid, that substitution changes glyph shapes and nothing structural: the page count, the line positions, and the character budgets are identical either way, which is what makes deferring it safe rather than a compromise to be repaid.

**Consequence, and it must be fixed by the server-side move rather than survive it: the standard Courier cannot encode text outside its Latin-1-ish range.** Cyrillic, Greek, and emoji all paste, save, and export to FDX and DOCX correctly -- the canonical model and the other two exporters handle them exactly as they should -- but PDF export of the same screenplay fails outright (verified 2026-08-22). This is the un-embedded standard font's limitation, not a defect in the layout model or the canonical schema.

**Do not resolve this by restricting what a writer may type or paste.** Rejecting characters at the input boundary to accommodate one exporter would be the narrowest consumer dictating the model, and it would block ordinary content -- an accented name in a contact block, a line of dialogue in another language. The canonical model is right; the exporter is the narrow one.

Until embedding lands, the failure is surfaced to the writer rather than logged: `App.tsx` renders the rejection in the status-attention banner, naming the block and element, outside the container the narrow-viewport rule hides. That makes it visible and actionable, which is the most that can be done without a font. **Embedding a face with the required coverage is the actual fix**, and it is the reason the server-side typeface change is a requirement rather than a refinement. Note that Courier Prime's own coverage must be checked against this list before it is assumed sufficient: matching the editor's face is one goal and rendering a writer's characters is another, and a face that satisfies the first may not satisfy the second.

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

### Writing-flow behaviours borrowed from Final Draft

Observed directly in Final Draft 13 and adopted deliberately. They share one purpose: **an element should never be able to sit empty and unlabelled**, because a blank block with an arbitrary inherited type is a formatting error the writer has to notice and undo later. They are listed together because they are one idea, but they need not ship together -- each is independently useful and several fit naturally into other slices.

- **A second Enter opens an element menu rather than creating another empty block.** The first Enter creates a new element as it does today. If that element is still empty when Enter is pressed again, the editor offers the element types instead of stacking a second empty block, with single-key shortcuts so the choice costs no more than the keystroke it replaces. Pressing Enter again with the menu open closes it; the writer is never trapped in it.
- **An element cannot be left empty.** Choosing a type for an empty block and pressing Enter re-opens the menu rather than creating a further empty block. The document therefore never accumulates blank blocks, which is also what keeps pagination honest: an empty block still occupies a line, so a stray one silently shifts every page after it.
- **A line cannot begin with a space.** Indentation is a property of the element, defined by the character grid, and a leading space is either a mistake or an attempt to hand-indent something the format already positions. Rejecting it protects the grid the whole layout package depends on.
- **Parentheticals own their parentheses.** Creating a parenthetical inserts `()` with the caret between them, and those characters cannot be deleted while the block remains a parenthetical. They are structural punctuation belonging to the element, not authored text -- which also means converting a parenthetical to another element must remove them rather than leaving them stranded in the text.

The parenthetical rule is the one to be most careful with, because it is the only one that writes characters into the canonical model. The parentheses are authored text once stored, so they must round-trip, they must export, and the wrapping must not be applied a second time to a parenthetical that already has them -- including one arriving from FDX import, where the parentheses are already part of the text.

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

**Character and transition have no stated character budget because they are short by construction, not because they are unbounded.** Their limit is implied by the geometry and is exact rather than invented: an element may never cross the right margin. A character cue starts at 3.7 in and the right margin is at 7.5 in, giving 38 characters. A transition is right-aligned against the same margin and may extend left to 1.5 in, giving 60. Wrap at those implied budgets rather than allowing an over-long cue to run off the page, which would corrupt the PDF silently.

Dual-dialogue column geometry is **not yet specified** and must be settled before dual dialogue can paginate or export.

### Why no text-measurement library

Text-measurement and layout libraries such as Pretext were evaluated and are deliberately not used for screenplay layout.

At 10 pitch every glyph is exactly 0.1 in wide, so line breaking is arithmetic on character counts against a fixed budget — 60, 35, or 20 characters depending on element — not measurement of rendered text. A measurement library solves a problem the monospace requirement removes.

More decisively, such libraries measure through the browser's font engine via Canvas, which makes them unavailable to the export worker. The layout package must produce byte-identical page models in the browser and on the server, which is the entire reason it is a pure function. Introducing a browser-only measurement step would reintroduce the divergence that decision exists to prevent.

One idea is worth taking without the dependency: use `Intl.Segmenter` directly for grapheme-aware counting, so a combining sequence or an emoji occupies one grid cell rather than several code units. It is a platform API in both Node and the browser. Note that this is a different unit from the schema's annotation offsets, which are UTF-16 code units and must stay that way.

#### Known limitation: characters outside the screenplay face

The engine counts grid cells; the browser measures glyphs. Those agree only while every character is rendered in Courier Prime at its 0.6 em advance. A character the face does not cover triggers font fallback to a substitute at a different advance, and the two disagree.

Measured in Chrome against the shipped renderer:

| Content                                 | Engine lines | Rendered lines |
| --------------------------------------- | ------------ | -------------- |
| 60 Latin characters                     | 1            | 1              |
| Hyphenated word spanning the measure    | 2            | 2              |
| Em dash spanning the measure            | 2            | 2              |
| Non-breaking space spanning the measure | 2            | 2              |
| A long URL                              | 3            | 3              |
| 40 CJK characters                       | 1            | **2**          |
| An emoji ZWJ sequence mid-line          | 1            | **2**          |

Latin text agrees everywhere, including the cases where UAX #14 line breaking and character counting could plausibly have differed. The failure is confined to font fallback.

The consequence is not cosmetic: a line that renders taller than the model predicts shifts every subsequent page boundary on screen relative to the computed model, and the spacers are positioned from the model. Page fidelity degrades from that point down the document.

This is a product decision, not only a technical one, and it is deliberately unresolved. The principled fix is to count East Asian Wide and Fullwidth characters as two grid cells per UAX #11, as a terminal does, and to require a fallback face that is genuinely double-width monospace — which cannot be assumed. The alternatives are to restrict authoring to the face's coverage, or to accept and document that non-Latin screenplays lose exact page fidelity. Decide before advertising the page-count guarantee to anyone writing in a non-Latin script.

### Page numbering

- Arabic numerals by default, top right.
- **The first page of the screenplay carries no number. Numbering begins at 2 on the second page.**
- The title page is never numbered and never counted. It is not page 1.
- Roman numerals are available as a document setting. The setting is offered because "Arabic numerals" is unfamiliar phrasing to many writers; label it in plain language such as "Numbers" and "Roman numerals" rather than by numeral-system name.

### Page break rules

The layout package decides breaks. These rules are the specification:

- **Space before is suppressed at the top of every page.** The first element on a page begins at the top margin with no leading blank line, and this applies to every page, not only the first. Otherwise each page break would push its page's content down one line and the page count would drift progressively as the script grows.

- **A scene heading never ends a page.** It requires at least two lines of the following element on the same page; if that is not possible, the heading moves to the next page and takes them with it.
- **A single orphaned line of dialogue moves to the next page** rather than sitting alone at a page foot.
- **A character cue never ends a page.** If none of its dialogue fits below it, the whole speech moves to the next page. A lone character name at a page foot is the same failure the orphan rule exists to prevent, and the contiguous-speech rule already treats character, parenthetical and dialogue as one unit.
- **A split leaves at least two dialogue lines at the foot of the first page, and at least one at the head of the continuation.** If neither is possible, do not split: move the whole speech.

The asymmetry is deliberate. At a page foot, a cue, one line and `(MORE)` spends three rows to deliver one line of dialogue, and moving the speech is plainly better. At the head of a continuation the `CONT'D` cue is itself content and supplies the context a widow lacks, so a single line there reads as a complete unit rather than a stranded fragment. Requiring two at the top would force short speeches onto the next page for no gain: a three-line speech could never split at all, while under this rule it splits two and one.

**The minimum counts dialogue lines across the whole speech, not within a single dialogue block.** A speech interrupted by a mid-speech parenthetical is still one speech, and a break may fall between its blocks:

- Parentheticals do not count toward the two-and-one minimum. Only dialogue lines do.
- A parenthetical never ends a page. It introduces the dialogue that follows, so it moves to the next page with it, exactly as a character cue does.
- A parenthetical is never split across pages. At two lines wide at most, splitting one gains nothing and reads badly.

Scoping splits to within a single dialogue block would be simpler but wastes space in a common case: a speech of character, dialogue, parenthetical, dialogue whose natural boundary falls between the first dialogue block and the parenthetical would move entirely to the next page, stranding lines that were legitimately usable.

### Page fill and the bottom margin

A page fills to **55 lines**, which leaves a 0.833 in bottom margin.

Filling further is possible within the stated 0.5 to 1.5 in range — 57 lines reaches exactly 0.5 in — and is deliberately not done. Page count is contractual in this form and the one-page-per-minute heuristic is calibrated against roughly 55 lines. A 110-page script at 57 lines per page measures about 106, so routinely filling tighter would make every screenplay read as shorter than it is.

**A page should not end above a 1.5 in bottom margin**, meaning 51 lines, and the keep-together rules bring it close to that but do not guarantee it. The reachable bound is **50 lines, a 1.667 in bottom margin**, and it is reached by one specific shape:

| Speech at a page foot        | Room a legal split needs | Max room left unused | Page ends at | Bottom margin |
| ---------------------------- | ------------------------ | -------------------- | ------------ | ------------- |
| cue and dialogue             | 5 lines                  | 4                    | 51           | 1.500 in      |
| cue, parenthetical, dialogue | 6 lines                  | 5                    | 50           | 1.667 in      |
| scene heading                | 4 lines                  | 3                    | 52           | 1.333 in      |

A parenthetical between the cue and the dialogue adds an atomic, uncounted line to the room a split requires, so one more line can go unused before the speech has to move whole. The parenthetical is not counted toward the two-dialogue-line minimum, because it is not dialogue, and the two-line minimum at a page foot is not relaxed to compensate. Both alternatives trade a well-founded typographic rule for a margin that is already acceptable.

**The engine must never refuse to paginate a legitimate screenplay.** A margin outside the preferred range is ordinary output, not an error: real scripts have pages that end early when a speech or a scene heading moves. Throwing there would mean a writer's document fails to render because of where a page happened to break, which is far worse than 0.167 in of extra white space.

Reserve failure for input the engine genuinely cannot lay out, such as `dual_dialogue` while its column geometry is unspecified. That distinction is the rule: **fail on unsupported input, never on an unwelcome but valid layout outcome.**

Expose the per-page line count and bottom margin in the model so tests can assert the distribution across fixtures and a regression that pushes pages below 50 lines is caught. That is a test-suite assertion, not a runtime one.

- **Long dialogue splits across the break.** When it does:
  - `(MORE)` is placed at the foot of the first part, at the character indent.
  - The continuation on the next page repeats the character name followed by `(CONT'D)`.
  - Both are generated automatically and **both must be deletable by the writer.** Automatic insertion that cannot be removed is a defect, not a feature.

`(MORE)` was not in the owner's original list and is added here: without it the split reads as two separate speeches by the same character.

**`(MORE)` and `CONT'D` are derived, never written into the canonical screenplay.** The layout package marks them as generated lines and the renderer draws them; they are not selectable, editable content.

They exist only because a page boundary fell somewhere, which makes them renderer output, and the canonical model already forbids persisting renderer output in the semantic document. Materialising them would also break things that depend on the document being stable under layout:

- `canonical_hash` identifies a screenplay for exports and revisions. If pagination mutates the document, the hash changes when nobody edited anything, and revision history fills with automatic commits.
- Automatic insertions would enter the same undo history as the writer's own typing, so an undo after one keystroke has no coherent meaning.
- Two collaborators computing the same break would each insert their own copy. Yjs would merge both faithfully; the input was wrong, not the CRDT.
- FDX export would carry them as authored content, so a round-trip would produce duplicates on the next pagination.

The writer keeps control through two mechanisms rather than through deletion:

- A document setting to suppress automatic `(MORE)` and `CONT'D` entirely, added when document settings land. Default on.

**The setting is presentation only. It must not change where pages break.** A speech too long for the remaining page still splits at exactly the same line whether the setting is on or off — only the generated marker lines differ. With the setting off, the engine must **not** reserve the line the `(MORE)` would have occupied: the outgoing page fills to capacity and the speech continues on the next page with no heading. Reserving the line anyway would make an option described as stylistic quietly move every break one line earlier, which is the behaviour a writer would least expect from a setting about whether two words are printed.

- A manual `page_break` block, already in the schema, for a writer who wants a particular speech kept whole. That is authorship and belongs in the document; the `CONT'D` that would otherwise result from it does not.

Revisit only if user testing shows writers genuinely need to edit the text rather than remove it. An override mechanism is possible but carries its own staleness problem — an override keyed to a break becomes meaningless as soon as the break moves — so it needs evidence of a real need before it earns that cost.

### Character names and extensions

A character element may carry an extension on the same line, such as `MARA (V.O.)`.

**The Navigator's character list strips extensions before grouping.** `MARA`, `MARA (V.O.)`, and `MARA (O.S.)` are one character, not three. Strip the full conventional set — `(V.O.)`, `(O.S.)`, `(O.C.)`, `(CONT'D)` — and treat any trailing parenthetical on a character line as an extension rather than matching a fixed list. Note the trailing period in `(V.O.)` and `(O.S.)`; accept the period-less spellings on import but normalise on output.

**Prerequisite, currently missing:** the Navigator's Characters tab (`App.tsx`'s `.panel-tabs`) is inert markup today — a plain `<span>Characters</span>` beside the working `Scenes` tab, with no click handler, no derived character list, and no click-to-navigate. The extension-stripping rule above presumes a working character list to group; that list does not exist yet. Build the tab itself (character list derived from the shared schema, selectable like a scene, keyboard-operable like the rest of the Navigator) before or alongside the stripping logic, not as an assumed given.

### Title page

A new screenplay gets a dedicated title page by default, containing placeholder text blocks:

- Title
- "written by"
- Author name
- A contact block in the lower right: name, address, phone number, email

All are ordinary deletable text blocks. The title page never paginates with the screenplay body and never receives a page number.

**"Ordinary deletable text blocks" describes what the writer experiences, not how a title page is stored.** The canonical schema models a title page as named optional fields — `title`, `authors`, `credit`, `source`, `draftDate`, `contact` — and stays that way. Each present field renders as a text block the writer can edit and delete, and deleting one clears the field. A flat list of blocks was considered and rejected: it cannot express "a contact block in the lower right", which this same section requires, and any list that recovered that guarantee would do it by adding roles or grouping, which is named fields with extra steps. `MAX_TITLE_PAGES` allowing several title pages per screenplay is also a repeatable structured record, not one long block sequence.

**Placeholders are rendered hints on empty fields, never stored strings.** Stored placeholder text is real content: it round-trips, it exports, and a writer who never opens the title page would ship a PDF reading "Author name". The default title page therefore stores only values that are already correct — the `title` the writer typed when creating the screenplay, and the literal credit `written by`, which is the real content of a title page rather than a placeholder. `authors` and `contact` start empty, and the editor renders a hint on the empty field using the same mechanism that already hints empty screenplay blocks. The result is a title page that is correct on creation and degrades to a blank contact area rather than fake text.

**A title page must survive the editor round trip even where the editor offers no controls for it.** Projecting a screenplay into the editor and back must reproduce the canonical value exactly, title pages included.

### Scene numbers

A document setting, **disabled by default**. When enabled, every scene heading receives a number, right-aligned.

This is display only and belongs to Phase 1. It is distinct from the Phase 5 production feature described under "Locked scripts" below, where scene numbers are frozen and inserted scenes take suffixes such as `25A`. Do not conflate them: the Phase 1 setting renumbers freely as scenes move; the Phase 5 feature deliberately does not.

**The Phase 1 setting and the Phase 5 feature are one control, not two.** Before a script has ever been locked, the setting shows the numbers the scenes would receive if it were locked right now, which for a first lock is simply 1, 2, 3 in document order -- the behavior described above, unchanged. After a lock, the same setting shows the real locked numbers, suffixes included. The setting therefore never changes meaning; what changes is whether a lock exists for it to report against.

**Phase 1 numbers are rendered decorations and are never written to the canonical `sceneNumber` field.** They are recomputed from the live document, so they cost nothing when scenes move and cannot destabilise `canonical_hash`. The `sceneNumber` field exists for locked numbers, which are the opposite kind of value: authored-once, stable, and required to survive exactly as issued.

### Document settings

A dialog under the File menu. Adjustable: character indent, parenthetical indent and width, page-number position and numeral style, scene numbers on or off, and automatic `(MORE)` and `CONT'D` on or off, defaulting to on.

Not adjustable, ever: the typeface, the type size, the pitch.

The parenthetical indent shows an inline warning when it drifts more than half an inch from its usual position relative to the character indent, in either direction. A warning, not a block — the writer may have a reason.

**The warning measures drift from the default gap between the two indents, not absolute distance from the character indent.** Read the other way, the specification contradicts itself: "Element indents" puts the parenthetical 0.6 in inside the character indent (3.7 minus 3.1) and calls that correct, which is 0.1 in past a threshold measured absolutely — so a screenplay whose settings no one had ever touched would open to a warning about a value this document endorses. The default gap is therefore the zero point, and the half-inch tolerance applies to departures from it, giving a safe range of roughly 0.1 in to 1.1 in of gap. Derive the default gap from the shipped defaults rather than writing 0.6 in as a literal, so the threshold cannot go stale if those defaults move.

**These values are document state, not application preferences.** They live in the canonical screenplay, travel with it through export and import, and are inputs to the layout package. A screenplay must paginate identically on any machine and for any collaborator, so a setting stored per user or per browser would break the pagination contract.

### Application shell

The shell is fixed to the viewport. **The manuscript is the only thing that scrolls vertically with the page**, and the panels scroll independently of it if their own content overflows.

- Title bar, menu bar, and toolbar are always visible at the top.
- The status bar, if retained, is always visible at the bottom.
- The editor region scrolls; the shell around it does not move.
- Navigator and Inspector scroll their own content independently, and overlay the page at narrow widths.
- **The editor has no way back to the writing desk.** The title bar's brand mark (`App.tsx`'s
  `.brand`, the "F" mark plus "Finaler Draft") is inert today — plain text, not a link. Once
  inside a screenplay, a writer's only way back to `/projects` is the browser back button. Give
  the editor a real route back: either make the brand mark a link to `/projects` (the pattern
  already used by the project's screenplay list, whose header is a plain `Projects` link) or add
  an explicit back control. Whichever is chosen needs a real accessible name, not decoration.

`.application` currently uses `min-height: 100vh`, which lets the grid grow past the viewport instead of constraining it. Measured at an 800 px viewport, the shell computes to 1290 px tall and the status bar's bottom edge lands 490 px below the fold, so a writer has to scroll the whole application to discover it. The editor region is not scrolling at all in that state — its `scrollHeight` equals its `clientHeight`; the row simply expands to fit the 1144 px page. A fixed viewport height is what makes `minmax(0, 1fr)` constrain the row and hand the scrolling to the editor where it belongs.

Zoom belongs in the toolbar, alongside the other controls that act on the document view, rather than in the status bar where it is easy to miss.

The status bar carries the active scene, the word count, and the save state. Save state in particular must not be hidden below the fold: it is the writer's only signal that their work is persisted. If the status bar is ever removed, save state has to move somewhere permanently visible first.

### Page presentation

**Discrete separated pages are the default.** A writer sees individual 8.5 by 11 inch pages with visible boundaries between them, in the manner of Microsoft Word, because knowing where a page ends is the point of a screenplay editor.

A **continuous scroll** toggle is offered for writers who prefer an unbroken column. It is view state, not document state, and it defaults to discrete pages.

**Not yet true: discrete pages do not currently look separated.** They are drawn as a single `.page` element carrying a repeating gradient -- white for one page height, then the gap colour, repeating -- with one box shadow around the whole stack. The result reads as one long sheet with grey bands across it, not as individual pages, which is the specific thing this section says a writer should see. The owner reported it as such on 2026-08-22.

The cause is a constraint worth preserving rather than a mistake: **the manuscript is one contiguous flow**, because selection, cursor movement, and undo have to work across a page boundary. Splitting it into a DOM element per page would break all three, so the gradient was the compromise that kept the flow intact.

It is fixable without giving that up. A widget decoration already exists at every break and draws the spacer and the page number, so it can also draw the seam: the outgoing page's bottom edge and the incoming page's top edge, each with its own shadow, against a gap painted in the application background rather than a band of paper colour. That keeps a single flow, changes no break position, and is view state exactly as this section requires. Whatever approach is taken, the existing guarantee stands: the toggle and the page edges are presentation only, and `page-rendering-persistence.spec.ts` already asserts that a page frame never moves when content reflows around it.

**The toggle changes presentation only. It never changes where pages break.** The layout package computes breaks from the canonical screenplay and the page format; both views render the same break positions. Page count is identical in either mode, and so is every rule below:

- Space before is suppressed at the top of every page in both views. In continuous scroll this means the first element after a break still carries no leading blank line, even though no physical page edge is drawn there.
- `(MORE)` and `CONT'D` appear in both views. They are consequences of a break, not decorations of a page edge.

If the toggle ever changed the page count, the editor would report two different lengths for the same screenplay depending on a view preference, which is the same defect class as an editing affordance consuming grid space.

**The current `:first-child` rule only approximates this.** Space-before suppression is presently implemented as "the first block of the body", which is exact while a single continuous page exists and becomes wrong the moment real page boundaries do. It must become "the first element on each page" as part of the pagination work, in both views.

**The hard part is rendering, not computing.** ProseMirror manages one contiguous document; presenting it as discrete pages while keeping it a single editable document is the principal technical risk in this area. Computing breaks is pure arithmetic over line counts and is exhaustively testable without a browser. Those two problems should not be attempted in one slice: prove the layout package against fixtures first, then render its output.

#### The rendering technique, prototyped

Do not build per-page containers. Content stays one contiguous flow, which is what keeps selection, cursor movement, and undo working across a page boundary.

- Every page block occupies exactly the page height. At each break, a spacer absorbs the unused remainder of the page, plus the inter-page gap, plus the next page's top margin. Its height is `PAGE_HEIGHT - (TOP_MARGIN + lineCount * LINE_HEIGHT) + GAP + TOP_MARGIN`, computable directly from the `lineCount` the layout model exposes.
- Because every page block is then a fixed height, page backgrounds can be painted by a repeating gradient on the container rather than by any per-page element.
- In ProseMirror the spacer is a **widget decoration**: nothing enters the document, so the document remains contiguous and its positions are unaffected.
- A widget decoration's **key must encode everything the widget draws**, not merely which page it introduces. ProseMirror treats equal keys as the same widget and reuses the existing DOM node without re-rendering it. Keyed on the page number alone, a break whose spacer height changed — which happens on every edit that changes the outgoing page's fill without moving a block across the boundary — kept its stale spacer, leaving the incoming page's frame and number a line or more out of position until some later edit happened to change the key. The model was correct throughout; only the rendering was stale.
- A break that falls between two blocks must be **anchored after the block node, not inside it**. A widget anchored within a text block renders as that block's child, and ProseMirror appends an `img.ProseMirror-separator` after a widget that ends a text block. That image is an inline box, so it generates a line box: every such break silently added one line the layout engine knew nothing about, and the error accumulated page over page. Mid-block breaks — a dialogue split — have no block boundary to sit at and stay anchored inside, where following text prevents the separator.

This was verified in Chrome before the work was scoped. Across three pages, including one broken early at 51 lines, the first line of every page landed at exactly 1.0 in from its own page top. The `(MORE)` and `CONT'D` lines are widget decorations by the same mechanism, which is what makes them derived and non-editable rather than document content.

#### Pagination cost and recompute strategy

Pagination was originally measured at roughly 0.038 ms per block — about 100 ms for a feature-length screenplay — and the conclusion drawn was that it could never run per keystroke. That figure was almost entirely `Intl.Segmenter` overhead, not the line arithmetic. Grapheme counting now takes an ASCII fast path: every code point in `\x20-\x7E` is its own grapheme cluster, so its count is simply the string length, and anything outside that range still goes through the segmenter unchanged. The range deliberately excludes control characters, so `\r\n` — the one ASCII sequence forming a single cluster from two code units — cannot reach the fast path. Equivalence was verified against the segmenter across 12,288 code points plus combining marks, ZWJ sequences and regional indicators.

Measured in Node after that change:

| Blocks | Pages | Time    |
| ------ | ----- | ------- |
| ~570   | 25    | 1.52 ms |
| ~2,270 | 100   | 5.39 ms |
| ~6,800 | 300   | 15.4 ms |

Cost is still linear, now at roughly 0.0023 ms per block. A feature-length screenplay repaginates in about 5 ms rather than 100 ms.

**Repagination is coalesced to the next animation frame, not debounced to a typing pause.** At most one recompute is ever queued, a burst of edits within one frame collapses to one recompute, and the recompute never runs synchronously inside the keystroke that triggered it. The debounce it replaced had a defect worse than its cost: for the length of its delay an already-reflowed document was rendered against a stale break computation, which was directly visible as a page frame and its number jumping by a line and snapping back on every edit near a boundary. Frame coalescing closes that window before the next paint.

Measured end to end in real Chrome, driving genuine per-character key events at a realistic 120 WPM:

| Document     | Page breaks | Median keystroke-to-paint | Frames over 16.7 ms |
| ------------ | ----------- | ------------------------- | ------------------- |
| 60 blocks    | 2           | 24 ms                     | 0%                  |
| 400 blocks   | 14          | 24 ms                     | 0%                  |
| 1,200 blocks | 42          | 32 ms                     | 3%                  |
| 2,700 blocks | 96          | 48 ms                     | 15%                 |

Keystroke-to-paint is measured with the Event Timing API (the same mechanism as INP), which rounds to 8 ms buckets. Two results are worth recording because both are counterintuitive:

- **Latency does not depend on typing speed.** Median keystroke-to-paint is 48 ms at feature length whether typing at 120, 200, or an artificial 1,200 WPM. Only the share of frames over budget scales with cadence (15%, 24%, 49%). Benchmarks that type unrealistically fast overstate jank and say nothing extra about latency.
- **Latency depends on document size, and pagination is only about half of it.** There is a ~24 ms floor from the stack itself at any size. Feature length adds another ~24 ms, of which the recompute accounts for roughly 10 ms (phase breakdown at 100 pages: project 2.3 ms, paginate 5.2 ms, decorate 3.1 ms). The remainder is the browser's own style, layout and paint across a ~2,700-element DOM.

48 ms sits well inside the "good" band for INP (the threshold is 200 ms) and is competitive with mainstream browser-based editors, so this is accepted as shipped rather than optimised further.

The consequence for future work is that **incremental repagination is no longer the obvious next lever**. It would remove roughly 10 ms of the 24 ms that feature length adds, taking median keystroke-to-paint from about 48 ms to about 38 ms — real, but not transformative. The other half is DOM size, and the only fix for that is virtualising the rendered document, which conflicts directly with the single contiguous flow that keeps selection, cursor movement and undo working across page boundaries. Neither is worth doing on current evidence. Revisit only against a measured number, not an assumption — that is what the original 100 ms figure turned out to be.

### Zoom controls

Not urgent, and not required for the layout package. Recorded so the design is settled before someone builds it piecemeal.

**Zoom is a mode, not only a number.** Fit-to-page is not a zoom value that happens to be computed once; it is a state that must recompute whenever the available area changes — a window resize, a panel opening or closing, entering or leaving the overlay breakpoint. Model zoom as a discriminated union of a fixed percentage and the fit modes, rather than storing a number and losing the fact that the writer asked for a fit. Storing the computed percentage instead is the mistake that makes fit silently stop fitting after the first resize.

Three additions:

- **Pinch to zoom.** Trackpad pinch arrives as a `wheel` event with `ctrlKey` set, which is a de facto standard rather than a specified one; touch devices need their own handling. Scope the handler to the editor region and call `preventDefault()` there, so the writer can still use the browser's own zoom on the surrounding interface. Intercepting it globally would take away a control the operating system gives them.
- **A preset dropdown** beside the existing plus and minus buttons: a set of fixed percentages plus "Fit page" and "Fit width". The current range is 70 to 150 percent and will need widening to make presets worth having. Use a real `select`, or a listbox that behaves like one; do not build a custom menu that only responds to a mouse.
- **Fit page and fit width**, computed from the available editor area against the page's physical dimensions, recomputed on every change to that area.

Constraints that apply to all of them:

- **The character grid stays invariant at every zoom level and in every mode.** Zoom scales the rendered manuscript and changes nothing about where lines break or pages end. The existing measurement test asserts this; extend it to cover the new paths rather than trusting that a new mechanism preserves the property.
- Keyboard equivalents for zoom in, zoom out, and reset to 100 percent, consistent with the keyboard-first commitment.
- Respect `prefers-reduced-motion`: no animated transition between zoom levels for a writer who has asked for less motion.
- Zoom is view state, not document state. It never enters the canonical screenplay and never travels to a collaborator.

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

### Deleting and restoring

The API for rename, soft delete, and restore exists; this records the interface direction so it is not built piecemeal. Deletion is always soft, and nothing in the product hard-deletes a project or screenplay.

- **Entry point:** an overflow (three-dot) menu on the right of each screenplay card and each project card. It carries **Delete** now and gains **Edit** — rename and other document properties — when that work lands. The menu button needs a real accessible name, `aria-haspopup`, keyboard operation, and Escape to close.
- **No confirmation dialog.** Deletion is reversible by design, so a modal is friction that buys nothing and trains people to dismiss dialogs unread. Confirm after the fact instead: an inline "Deleted — Undo" affordance covers the mistake noticed immediately. Modals are reserved for genuinely irreversible actions, of which this area has none.
- **Deleted items live on their own page**, reachable from the account/settings menu — never on the writing desk or a project's screenplay list. Restoring is a rectangular **Restore** button per row, not an overflow menu: it is the only action available there, so hiding it behind a menu would be perverse. Nothing deleted appears in any main working view.

**Why self-serve restore rather than a support request.** Routing recovery through support was considered and rejected. It does not remove the work, it moves it somewhere riskier: someone must still perform the restore, which means either an admin interface — larger than the page it replaces, and requiring an admin role the schema does not have — or hand-written `UPDATE` statements against production. It also contradicts the reason soft deletion exists at all: a writer who deletes the wrong screenplay and must file a ticket experiences it as destroyed, whatever the database holds. An undo affordance covers the mistake caught in seconds; it does nothing for the one caught on Tuesday. Support-mediated recovery remains a reasonable escape hatch for unusual cases, but it must not be the only route, and the delete interface must not ship before the restore route exists.

**A screenplay whose project was deleted is not itself deleted**, and must not appear on the deleted-items page as though it were. Deleting a project does not write to its screenplay rows; they become unreachable because their parent is, and restoring the project restores exactly those that were not independently deleted. Presenting them as individually deleted would make restoring a project look like it resurrected screenplays the writer never deleted.

**There is no retention window and nothing is purged.** Deletion is permanent-until-restored, so the page is named **Deleted**, not "Recently deleted" — the latter promises an expiry that does not exist. Introducing automatic purging later is a separate product decision with storage and data-protection consequences; do not imply one in a label before it is made.

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
- Zoom gestures and presets, as specified in the zoom controls section: pinch to zoom, a preset dropdown, and fit-page and fit-width modes. Deliberately last in the phase — it is a refinement of a control that already works, and it depends on the page presentation being settled first.

The remaining Phase 1 order is: the layout package, then its rendering as discrete pages; project and screenplay rename and soft-delete; platform hygiene, meaning the Zod major unification, the `packages/config` split, and a typed route contract; title page, scene numbers, and document settings, all of which depend on pagination existing; FDX, PDF, and DOCX, which depend on the layout package; SmartType; and finally the zoom refinements.

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

- Scene numbering with insertion suffixes, tags, reports, revision sets, color marks, locked pages, omitted scenes, and production export/report fixtures. See "Locked scripts" under the screenplay specification for the rules these must satisfy.

#### Locked scripts

Locking is the point at which a script stops being a document that renumbers itself and becomes a production reference other departments have already built work around. Everything below follows from one rule: **once a number is issued it never changes meaning**, because someone has secured costumes, sets, or locations against it.

- **Locking is an explicit, recorded act.** A locked-version history runs alongside the existing revision history but is not the same thing: ordinary revisions accumulate continuously, whereas a lock is a deliberate checkpoint a writer takes, and the suffixes below are computed against the most recent lock. The history must be durable enough to answer "what number did this scene have at lock N" for every lock, not just the latest.
- **Scene numbers are frozen at the lock.** A scene inserted after scene 25 becomes `25A`, the next `25B`, and scene 26 stays scene 26. The suffix follows the number; it does not precede it.
- **Deleted scenes become `OMITTED` rather than disappearing.** Going from scene 40 to scene 42 reads as an error to anyone downstream, so scene 41 remains in the script marked omitted. A number, once issued, belongs to that scene whether or not it is ever shot.
- **Pages take suffixes on the same principle.** New pages created by an insertion become `10A`, `10B`, and so on, so page 11 stays page 11.
- **Changed lines carry a revision mark**, an asterisk beside the line, computed against the previous lock.
- **Scene numbers print in both margins**, left and right, at the start of each scene, and repeat at the top of a page when a scene continues from the previous page.

**Locked pages are the hard part, and they break an invariant this document otherwise holds absolutely.** Everywhere else, pagination is derived: the canonical model never stores layout, and page boundaries are recomputed from content on demand. A locked page number cannot work that way, because its whole purpose is to survive edits that would otherwise move it. Locking pages therefore means persisting page boundaries as authored data at the moment of the lock, and paginating subsequent edits _within_ those frozen boundaries rather than recomputing them freely. Do not treat this as an extension of the existing pagination path; it is a second mode with its own contract, and the two must not be blended silently. Scene locking has no such conflict -- a scene number anchors to a block that already has a stable identity -- so scene locking and page locking are separately sequenceable, and scene locking is much the cheaper of the two.

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

### Importing untrusted files

FDX import accepts a file a stranger can hand a writer, so it is the largest untrusted-input surface in the product and is held to rules that export is not. **Escaping and import hardening solve different problems and neither substitutes for the other**: escaping is output-side and stops our own authored text from breaking the XML we emit; the requirements below are input-side and stop a hostile file from doing anything at all.

- **Disable external entity resolution and DTD processing.** An FDX file is XML, so an unhardened parser will resolve external entities: `file:///etc/passwd` read back into the document, or an entity pointing at an internal host turning the parser into a request forwarder against services that trust it. This is the single highest-severity risk in the feature. If import ever runs server-side, this is not optional; if it runs in the browser, `DOMParser` does not resolve external entities, but that is a property of the environment, not a decision that has been made, so it must be asserted in a test rather than assumed.
- **Bound entity expansion, nesting depth, and input size before parsing.** A few kilobytes of nested entity definitions expand to gigabytes and take the process down. Reject the file on the limit rather than discovering it as an out-of-memory failure.
- **Everything parsed is untrusted text, and the canonical schema is the boundary that makes it safe.** Parsed values are validated by `packages/screenplay` exactly as any other input, so an imported document cannot carry a field, a length, or a structure that authored content could not. Import must never bypass validation for fidelity.
- **Imported text is never rendered as markup.** It reaches the writer through ProseMirror text nodes and, on the title page, through text content -- never `innerHTML`, and never a `content: attr()` path that a future change could turn into markup. The realistic stored-XSS vector here is an imported title or scene heading rendered somewhere that interprets it.
- **Fail closed on anything unrepresentable**, exactly as the editor already refuses canonical features it cannot preserve. A partially-understood import that silently drops content is worse than a refusal, because the writer keeps working against a file they believe was imported faithfully.

These are gates, not aspirations: an import slice is incomplete until each is covered by a test that fails when the protection is removed.

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

Landed since the original audit of `main` at `1bce6d3`: the CI gates are trustworthy (`typecheck` builds leaf packages, `format:check` passes, sign-out and the client-error handler are fixed), the colour token system replaced the ad hoc literals in `styles.css`, sign-in and sign-up carry descriptive errors and a confirm-password field, and the pagination work is complete — the pure layout package, its rendering as discrete pages, and the latency work described in "Pagination cost and recompute strategy". `chore/platform-hygiene` (single Zod major, split server environment parsing, typed Fastify route contract) and `feature/project-screenplay-crud` — both the rename/soft-delete/restore API and, as of `delete-restore-ui`, its interface (the overflow menu, inline undo, the Deleted page, and the account menu it lives behind) — are also merged. Gate results recorded in `progress/` entries from those branches can be relied on.

`feature/security-hardening` (the four items formerly listed below as "surfaced by the `delete-restore-ui` audits and not yet scheduled") is implemented, cross-validated by two independent audits, and gate-clean, but **not yet merged** — it exists only as uncommitted work in the `security-hardening` worktree, awaiting the owner's review and commit. Do not treat it as landed the way the branches in the paragraph above are. `Cache-Control: private, no-store` on every authenticated API response, `@fastify/static` immutable caching for hashed assets with `no-cache` for `index.html` (including on a 304 conditional revalidation, not just the initial 200), `Origin`-allowlist CSRF validation on state-changing routes (comparing against `BETTER_AUTH_URL`/`CLIENT_ORIGIN`, not the request's own spoofable `Host` header), a real database-readiness check ahead of Railway's health probe, and the editor's way back to the writing desk are all done. Full detail, including two rounds of audit findings and pushbacks, is in `progress/security-hardening.md` and `audit/`. Three things from that work are not resolved and are not blocking Phase 1, but need the owner's attention independent of it: branch protection is not enabled on `main` and no application has ever been deployed to Railway (both five-minute owner actions); the terminal, unrecoverable save-conflict lock in `App.tsx` (see "Yjs" note below) needs a Yjs-timing decision before anyone writes code for it; and a pre-existing, unrelated flake in `apps/web/e2e/page-rendering-persistence.spec.ts` (reproduces roughly 2 runs in 3, same assertion each time) was found and reproduced but not fixed.

The remaining Phase 1 order is:

1. Title page, scene numbers, and document settings — **in progress**. Document settings are the load-bearing item of the three, because pagination reads them; the dialog may land late but the defaults and their storage cannot.
2. FDX import/export, PDF export painted from the layout package, and `.docx` export. The PDF worker likely needs its own Dockerfile for headless Chromium.
3. SmartType-style contextual completion.
4. Zoom gestures, presets, and fit-page/fit-width. Deliberately last.

Three Phase 1 items sit outside that sequence and are easy to lose track of because nothing else depends on them:

- The rest of auth hardening: explicit cookie attributes and email verification with password reset. (Rate-limit IP resolution behind Railway's proxy landed as part of `feature/security-hardening`, above.) The email half is blocked on an email provider being configured, not on engineering.
- Character-extension stripping in the Navigator, so `MARA` and `MARA (V.O.)` are one character. The Navigator's Characters tab is itself still inert (see "Character names and extensions" above) — that basic list-and-select functionality is a prerequisite this item was implicitly assuming, not a separate task to schedule later. The menubar labels (`File`/`Edit`/`View`/`Format`/`Tools`/`Help`) are similarly inert and look interactive; worth fixing alongside the Characters tab rather than separately.
- The canonical round-trip test asserting that screenplay-to-editor projection and back is the identity function. It becomes load-bearing the moment FDX import exists, so it should land no later than item 2.

Yjs may run alongside any of the above. Note that it removes work rather than adding it: the version column, the whole-document `PUT`, and the terminal 409 handling all come out when the Yjs document becomes the source of truth, so avoid further investment in conflict-recovery interface work. Billing follows the commercial decisions recorded in the billing section. Private documents must not be represented as launch-ready until the launch-readiness list is complete.

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
