# Collaboration: the slice plan

Phase 2 of plan.md, planned before any code. Collaboration is the largest remaining body of work
and it touches the document model, the save path, and authorization at once — so this is written
to be argued with now rather than discovered slice by slice.

Decisions recorded here were made by the owner on 2026-09-04. Where a decision closes off an
option, the rejected option is written down too, so a later reader can tell a deliberate choice
from an accident.

## What is already settled by plan.md

Not re-litigated here:

- **Yjs via self-hosted Hocuspocus over WebSockets.** Yjs is the collaboration model; WebSockets
  are only transport. plan.md's "Why Yjs is used with WebSockets" explains why a bare WebSocket
  server is not an alternative: it would mean writing a CRDT ourselves.
- **Hocuspocus is a separate Railway service on its own subdomain**, and must not be proxied
  through a third-party CDN. Two independent reasons: an API deploy must not drop live editing
  sessions, and Railway exempts WebSockets from request timeouts while a general-purpose CDN would
  impose an undocumented idle timeout.
- **Redis pub/sub before a second app instance.** Not needed at one instance; required the moment
  there are two, or connected writers on different instances stop seeing each other.
- **Revision history, Track Changes, and production revision sets must never share one
  implementation or interface state.** Only revision history is Phase 2.
- **Restore-as-current is an epoch cutover**, deferred until snapshots, reconstruction, and offline
  recovery are proven.
- **Local undo/redo must never be presented as collaboration history.**

## Decisions taken for this plan

**1. Yjs becomes the source of truth in slice 1; canonical JSON becomes a projection.**
Rejected: dual-writing Yjs alongside the existing whole-document `PUT` and cutting over later.
Dual-write means two systems can disagree about one document, and that divergence is difficult to
test and worse to debug. The cost is a larger first slice: the version column, the whole-document
`PUT`, and 409 conflict handling all come out at once. plan.md already anticipates exactly this
deletion and instructs against further investment in conflict-recovery work.

**2. Authorization lands at the WebSocket layer in slice 1.**
Rejected: connection authentication first, per-role write rules later. A collaboration server that
trusts its clients is a data-integrity problem, not merely a permissions gap — a reviewer with
devtools could write to a document they may only read, and the resulting updates would be
indistinguishable from legitimate ones after the fact.

**3. Live collaboration is fully working before any revision-history work.**
Matches plan.md's own sequencing. History builds on the append-only update log, and that log is
cheaper to design once the editing path it records is proven.

**4. Slice 1 is a thin vertical slice.** One document, two browsers, authenticated, edits merging,
surviving a server restart. No presence, no offline, no history.

**Presence and remote cursors are required, not optional.** The owner was explicit: they are wanted
for showing different users, just not in slice 1. They are slice 2.

## The slices

### Slice 1 — the vertical chain

Stand up Hocuspocus as its own Railway service on its own subdomain. Authenticate the connection
against the existing session, resolve the actor's role on the document, and reject both
unauthorized connections and unauthorized writes. Bind the editor to a Yjs document with
`y-prosemirror`. Persist through Hocuspocus's Database extension. Make the canonical screenplay a
projection of the Yjs document, and delete the version column, the whole-document `PUT`, and 409
handling.

Done when: two browsers edit one screenplay, both see each other's changes, a reviewer cannot
write, and the document survives a Hocuspocus restart.

**`@tiptap/extension-history` must be removed** (`screenplayEditor.ts:763`) and replaced with
y-prosemirror's `yUndoPlugin`. Standard ProseMirror history would let one writer undo another's
edits — precisely what plan.md forbids. This changes `screenplayExtensions`, so it touches every
test that builds an editor. Expect that blast radius rather than being surprised by it.

**Durability in slice 1 is snapshot-based, not append-only.** Hocuspocus's Database extension
stores the whole Y.js state on a debounced `onStoreDocument`, retries in memory if the store
throws, and flushes pending writes on `Server.destroy()`. That is real durability, but it is not
the append-only log revision history needs — that arrives in slice 3. The gap to watch is a hard
crash (not a graceful shutdown) between debounced writes, which loses at most the debounce window.
Choose that window deliberately and write down the reasoning.

### Slice 2 — presence, cursors, and reconnection

Awareness protocol, remote cursors and selections in the manuscript, a participant indicator, and
reconnection that recovers cleanly from a dropped socket. Presence is transient and **must never
reach the database** — plan.md: "Cursors and presence are transient and never belong in history."

The screenplay is a fixed character grid, so a remote cursor is a decoration on that grid, not a
free-floating overlay. This is the same class of problem as the seam caret and the page-break
widgets: anything drawn into the manuscript must be proven not to displace a line. That defect has
been introduced and fixed four times in this codebase; the measurement approach in
`page-rendering-persistence.spec.ts` is the precedent.

### Inserted slice — connection tokens (placed before slice 3)

Added 2026-09-25, after the first real deployment of `apps/collab` proved the cookie-based handshake
cannot work across the deployed topology. Not renumbered into the 3/4/5 sequence deliberately:
other documents in `progress/` already refer to "slice 3" as the append-only update log, and
renaming it here would silently invalidate those references.

**What the deployment showed.** With `app` on `app-production-d342.up.railway.app` and `collab` on
`collab-production-3d77.up.railway.app`, every handshake is rejected with `Authentication required`
(`transient: false`). The origin guard _passes_, so this is not `CLIENT_ORIGIN` and not a missing
variable -- the Better Auth session cookie simply never arrives. It is set host-only
(`packages/auth-server/src/index.ts`: `httpOnly`, `sameSite: 'lax'`, `secure`, no `Domain`, no
`crossSubDomainCookies`), so a cookie set on one host is never sent to the other. Giving it a
`Domain` cannot rescue it either: `up.railway.app` is a public suffix, and browsers reject a
`Domain` attribute set to one. `SameSite=Lax` independently blocks it, the two hosts being different
sites.

This never appeared locally because `localhost:5173` and `localhost:4400` differ only by port, and
cookie scope ignores ports -- same site, cookie attached. plan.md's stated topology
(`wss://ws.example.com`, a subdomain of the app's own apex domain) does work, because a cookie
scoped to `.example.com` is same-site for both. The defect is that nothing in the code _requires_
that topology, so a correct-looking deployment silently produces a dead socket.

**The decision: authenticate the socket with an explicit, short-lived, collab-scoped token**, minted
by the API and passed as `HocuspocusProvider`'s `token`, validated in `onAuthenticate` instead of
reading a cookie.

Rejected: waiting for a custom domain and keeping cookies. It needs no code and would work -- but it
leaves authentication coupled to DNS layout, so it breaks again the first time the collaboration
server changes hostname, and it is a constraint no test can express.

Explicitly **not** the session token handed to JavaScript: the session cookie is `httpOnly` on
purpose, and exposing it to script to forward over a socket would undo that for every other reader.
A separate, short-lived, single-purpose credential is the point.

The other reason, weaker today but real: a desktop (Tauri/Electron) or mobile client shares no cookie
jar with a browser session, and neither does a CLI, an export worker that needs to read a live
document, or a future third-party integration. Each would need a token bolted on regardless.

**Why before slice 3, not after.** Short-lived tokens and offline editing interact directly: a client
that has been offline for hours reconnects holding an expired token and needs a refresh path.
Building offline recovery against cookie auth and then changing the auth model underneath it means
building that reconnection logic twice.

Watch for: token lifetime versus the reconnection backoff already built in slice 2 (an expired token
must produce a _refresh_, not the permanent-denial terminal state, or a reconnecting tab gives up
forever); the existing three permanent-denial reasons in `apps/collab/src/authenticate.ts` and the
`TransientAuthenticationError` path must keep their current meanings; and the read-only/reviewer
resolution must continue to happen server-side after the token identifies the actor, never be
carried as a claim the client could forge.

### Slice 3 — offline and durable updates

Browser IndexedDB for a local offline copy, and append-only `document_yjs_updates` with
`document_yjs_checkpoints` compaction on the server. plan.md's schema sketch is the starting point.
An offline editor must catch up on reconnect without losing work, and compaction must never lose an
update that a checkpoint has not yet absorbed.

**An offline writer whose entitlement lapses: quarantine, not reject and not merge.** Decided by
the owner on 2026-09-25, before slice 3 is built, because it shapes what slice 3 has to record.

The tension the owner named: refusing the work outright means someone loses writing they actually
did, which is unacceptable for a screenwriting tool; accepting it silently means going offline is a
way to edit for free, every time, forever.

These only look like one decision. Whether to **accept the data** and whether to **grant editing
access** are separate, and the resolution is to say yes to the first and no to the second. On
reconnect, updates for a document the actor is not entitled to write are accepted by the server but
**not merged into the live document** -- they are retained aside (they are ordinary Yjs updates, and
slice 3's append-only log is already the right substrate) and the writer is told they have unsynced
changes made while their subscription was inactive, which resubscribing merges. Nobody loses work,
and nobody edits for free.

Worth recording how large the hole actually is, because it governs how much to build: the client
already renders read-only when lapsed (the lapse-chooser slice), so this is not "just go offline" --
it requires defeating your own client with devtools and then reconnecting. The free tier already
grants one editable screenplay, so what the exploit buys is editing your _other_ screenplays while
giving up collaboration and cross-device sync entirely. Narrow and awkward, not an open door.

**Scope split for slice 3:** build the detection -- the server must classify a reconnecting client's
updates by entitlement at merge time, and retain rather than drop the ones it refuses. That is the
part that is expensive to retrofit, because it decides what gets written down. The
resubscribe-and-merge interface is deferred until someone needs it.

This makes the socket's write rejection (slice 1's "single most important assertion") a rule about
_merging_, not only about live writes: the same entitlement check now has to answer for a batch of
updates arriving from the past, not just a keystroke arriving now.

### Slice 4 — revisions, preview, and diff

`document_revisions` with automatic and named revisions, historical preview, and a screenplay-aware
diff. plan.md requires revisions at named milestones, meaningful idle sessions, major structural
changes, and exports; named revisions are retained indefinitely and the automatic-revision
retention policy must be documented.

### Slice 5 — restore as current

The epoch cutover. Explicitly last, per plan.md, and only once slices 3 and 4 are proven.

## Risks worth naming before starting

**The undo change is the most disruptive edit in slice 1.** It is one line in a shared extensions
array and it affects every editor test in the suite.

**`y-prosemirror` must agree with the installed ProseMirror.** The workspace is on Tiptap 3.23.6
and `@tiptap/pm` 3.23.6. A y-prosemirror pulling a second copy of `prosemirror-state` or
`prosemirror-view` will produce plugin-key and instance-identity failures that look like logic
bugs. Verify the resolved tree, do not assume the lockfile deduplicates it.

**The canonical projection is the correctness boundary.** Once Yjs is the source of truth, every
export, the pagination model, and the entitlement checks read a projection. `canonicalRoundTrip.test.ts`
already asserts that screenplay-to-editor projection and back is the identity function; that test
becomes load-bearing in a way it currently is not.

**Entitlement now has a second enforcement point.** `entitlementProjectStore.ts` gates REST writes.
A WebSocket connection bypasses it entirely unless Hocuspocus performs the same check. The lapse
rules — one editable screenplay, read-only beyond it — must hold on the socket, or the read-only
editor state built in the lapse-chooser slice becomes advisory.

**Presence is a privacy surface.** Awareness carries user identity to every other connected client.
Decide what it exposes before building it, not after.

## Answered 2026-09-04

**Reviewers connect to the socket.** The owner: "They should not be second class viewers just
because they cannot edit." So a reviewer sees live edits arrive as they happen, with the same
immediacy an editor has.

The consequence is worth stating plainly, because it changes slice 1's risk profile: **write
rejection at the socket is now the only thing separating a reviewer from an editor.** There is no
"they cannot reach the socket anyway" fallback. `onAuthenticate` resolving the role is not
sufficient on its own — inbound updates must be rejected for a connection whose role may not
write, and that rejection needs a test that fails if it is removed. This is the single most
important assertion in slice 1.

Presence makes this sharper still: a reviewer is _visible_ to editors, so the system asserts they
are present in a document they must not modify. That claim needs to be true at the protocol level,
not just in the interface.

**Debounce starts at Hocuspocus's defaults — 2s `debounce`, 10s `maxDebounce`** — and is tuned
against real use rather than guessed now. The owner: "we might need to play with it a little to
find a good timing."

What those numbers mean concretely: a write lands 2s after typing stops, and at most 10s into
continuous typing. A **graceful** shutdown flushes pending writes, so the exposure is a hard crash
only, bounded by `maxDebounce`. Tune with that framing — the question is how much continuous
typing may be lost in a crash, not how often the database is written.

**Hocuspocus lives in this monorepo**, as a new app alongside `apps/api`, `apps/web` and
`apps/landing`. It shares `packages/database`'s schema and the API's session verification; a
separate repository would mean duplicating both, and drift between two copies of session
verification is a security bug rather than an inconvenience. It remains a **separate Railway
service on its own subdomain** — one repository, two deployables, exactly as `apps/landing`
already is.

Note the `.railway/railway.ts` consequence: adding a service means adding it to that file, and
`railway config plan` must be reviewed before applying. Omitting an existing service from that file
deletes it.
