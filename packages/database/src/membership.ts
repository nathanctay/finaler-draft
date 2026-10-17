/**
 * The one definition of "what role does this actor hold on this screenplay", shared by every
 * authorization path that honours screenplay-scoped membership.
 *
 * Before this slice there was exactly one kind of membership -- a `project_members` row -- and
 * every path resolved it with its own copy of the same two-table join. Screenplay-scoped
 * membership (`screenplay_members`; see its own schema comment for why it is a separate table
 * rather than a nullable column on `project_members`) makes that resolution a real decision with a
 * real precedence rule, and a decision duplicated across five files in two services is exactly the
 * kind of correctness-bearing logic `revisions.ts`'s own module comment argues must live in one
 * place. The security property this slice is judged on -- a member invited to one screenplay cannot
 * reach a sibling screenplay by any path -- is only as strong as the weakest copy of this rule, so
 * there is one copy.
 *
 * **Precedence: most privileged wins.** `owner > editor > reviewer`. An actor who is a project
 * reviewer *and* a screenplay editor is an editor on that screenplay; an actor who is a project
 * editor *and* a screenplay reviewer is still an editor on it. Both grants were made deliberately
 * by someone who could make them, and the narrower one is additive rather than a revocation --
 * there is no "deny" in this model, and inventing one here would mean a screenplay-scoped reviewer
 * row silently stripped write access an owner had granted project-wide, which no interface in this
 * product would explain. To actually narrow someone's access, remove the broader grant.
 *
 * **Why SQL text rather than a query function.** Every caller embeds this inside a larger statement
 * it is already running -- a `select ... for update` that locks the screenplay row, a listing that
 * filters and orders, the socket's role-and-epoch lookup. Returning a composable fragment keeps all
 * of those at one round trip, and keeps the role resolved inside the same snapshot (and, where it
 * matters, the same row lock) as the rest of the statement. A helper that ran its own query would
 * resolve the role at a different instant from the row it authorizes.
 */

/**
 * A `cross join lateral`-able subquery yielding at most one `role` column: the actor's effective
 * role on the screenplay identified by `screenplayAlias`, or no rows at all when the actor holds
 * neither kind of membership. Used as `cross join lateral <this> m`, where "no rows" eliminates the
 * outer row entirely -- which is precisely the "not a member, and not told whether the screenplay
 * exists" denial every one of these paths already used.
 *
 * `screenplayAlias` must be the alias of a `screenplays` row in the enclosing query (its `id` and
 * `project_id` are both read). `actorPlaceholder` is a bind placeholder (`$2`, `$1`, ...) chosen by
 * the caller, whose parameter numbering this function cannot know.
 *
 * Both arguments are interpolated into SQL text, so both must be compile-time constants at the call
 * site -- an alias this module chose and a placeholder the caller chose. Neither is ever derived
 * from a request: the actor's id travels as the bound *value* of `actorPlaceholder`, never as part
 * of this string. Every call site in this repository passes literals.
 *
 * The role is cast to `text` on both branches on purpose. `project_members.role` is `project_role`
 * and `screenplay_members.role` is `shared_role` -- two distinct Postgres enums, which a `union all`
 * cannot combine without a common type, and whose own declaration orders must never become the
 * precedence rule by accident. The `order by case` below is the precedence, written out.
 */
export function screenplayRoleLateral(actorPlaceholder: string, screenplayAlias = 's'): string {
  return `(
    select candidates.role
      from (
        select pm.role::text as role
          from project_members pm
         where pm.project_id = ${screenplayAlias}.project_id
           and pm.user_id = ${actorPlaceholder}
        union all
        select sm.role::text as role
          from screenplay_members sm
         where sm.screenplay_id = ${screenplayAlias}.id
           and sm.user_id = ${actorPlaceholder}
      ) candidates
     order by ${ROLE_PRECEDENCE_SQL}
     limit 1
  )`;
}

/**
 * The precedence rule as a bare `order by` expression, exported so the two places that rank roles
 * without the lateral above -- `listSharedScreenplays`'s `distinct on` and nothing else today --
 * cannot disagree with it. Lower sorts first, so `limit 1` takes the most privileged.
 */
export const ROLE_PRECEDENCE_SQL =
  "case candidates.role when 'owner' then 0 when 'editor' then 1 else 2 end";

/**
 * The three roles an effective-role resolution can produce. Declared here, beside the precedence
 * rule that orders them, so `apps/api`'s wire schemas and store interfaces and `apps/collab`'s
 * connection authorization all name the same closed set rather than a bare `string` that a typo
 * could widen.
 */
export type EffectiveRole = 'owner' | 'editor' | 'reviewer';

/** The two roles that may write. Mirrors the `canEdit` predicate `apps/api` already applies to a
 * `project_members` role, stated here once now that a role can come from either table. */
export function roleCanEdit(role: unknown): boolean {
  return role === 'owner' || role === 'editor';
}

/**
 * The Postgres `NOTIFY` channel a committed membership change (a role change, or a removal) is
 * announced on, and which `apps/collab` listens to.
 *
 * `resolveConnectionAuthorization` resolves role and entitlement once, at connection time, so an
 * account that is demoted or removed while it holds an open socket would otherwise keep whatever
 * the handshake decided until it happened to reconnect -- which, for a writer who leaves a tab
 * open, is unbounded. A removed member silently continuing to write is the one outcome this slice
 * is not allowed to ship, so the news has to cross the process boundary the same way a restore's
 * already does (see `SCREENPLAY_RESTORED_NOTIFY_CHANNEL` in restore.ts for the full argument for
 * `NOTIFY` over service-to-service HTTP: one shared database, no new credential, no knowledge in
 * `apps/api` of where `apps/collab` is deployed).
 *
 * The payload names **only the account**, never the project or screenplay whose membership changed.
 * That is deliberate over-inclusion: `apps/collab` closes every socket that account currently
 * holds, each of which reconnects and re-runs `resolveConnectionAuthorization` from scratch. A
 * reconnect cannot grant anything -- it re-reads the database -- so the cost of over-inclusion is a
 * brief, correct reconnect on a document that was not affected, while the cost of *under*-inclusion
 * would be exactly the removed-member-still-writing case. It also keeps the payload a fixed size:
 * naming every affected screenplay would put an unbounded list in an 8000-byte notification for a
 * project-scoped change.
 */
export const MEMBERSHIP_CHANGED_NOTIFY_CHANNEL = 'membership_changed';

export interface MembershipChangedNotification {
  /** The account whose access changed. */
  userId: string;
}

/**
 * Parses a `MEMBERSHIP_CHANGED_NOTIFY_CHANNEL` payload, or `undefined` for anything that is not
 * one. Validated rather than trusted for the same reason `parseRestoreNotification`
 * (apps/collab/src/restoreNotifications.ts) is: a notification payload is a string arriving from
 * outside the listening process, and a listener that assumed its shape would turn someone else's
 * mistake into a crash loop.
 */
export function parseMembershipChangedNotification(
  payload: string | undefined,
): MembershipChangedNotification | undefined {
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const candidate = parsed as { userId?: unknown };
    if (typeof candidate.userId !== 'string' || candidate.userId.length === 0) return undefined;
    return { userId: candidate.userId };
  } catch {
    return undefined;
  }
}
