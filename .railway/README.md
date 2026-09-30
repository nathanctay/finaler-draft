# Railway configuration

This project defines its Railway infrastructure in code.

```txt
.railway/railway.ts
```

Use this file to describe the Railway project you want: services, databases, buckets, custom domains, replicas, groups, and environment variables.

The TypeScript file imports `railway/iac`. Install the SDK from the repository root:

```bash
npm install railway
```

## Common commands

Create the configuration files:

```bash
railway config init
```

Import an existing Railway project into code:

```bash
railway config pull
```

Preview what Railway would change:

```bash
railway config plan
```

Apply the planned changes:

```bash
railway config apply
```

## Deploys are automatic; infrastructure changes are not

`.github/workflows/quality.yml` has a `deploy` job, gated on the full `checks` job, that deploys
`app`, `collab` and `landing` on every push to `main`. Two consequences worth stating explicitly:

- **Railway's own GitHub auto-deploy must stay off.** It deploys on push with no knowledge of whether
  the test suite passed, so enabling it alongside this workflow would reopen the exact hole the
  gating closes. No service declares a watched `branch` in `railway.ts`, and that omission is
  deliberate.
- **`railway config apply` is still a manual, reviewed step.** Nothing in CI applies this file. That
  is partly by construction -- the workflow authenticates with a Railway _project token_, which
  cannot apply configuration -- and partly on purpose: omitting a variable or a service from
  `railway.ts` deletes it, so the `railway config plan` output is the only warning before a
  destructive change, and a human should read it. Run `railway config plan`, read it, then
  `railway config apply`.

The deploy job uses `railway up`, which uploads the checked-out tree, rather than
`railway redeploy --from-source`, which would re-resolve the branch head at deploy time and could
build a commit the suite never tested.

`app` deploys before `collab` because `app`'s `preDeploy` runs `db:migrate`, and `collab` reads the
same database.

## Notes

- `railway config plan` is safe and does not change Railway.
- `railway config apply` previews changes and asks before applying unless you pass `--yes`.
- Destructive changes in non-interactive or agent sessions require `railway config apply --confirm-destructive` after reviewing the plan.
- CI should pin a plan (`railway config plan --out railway-plan.json`) and apply that file on merge (`railway config apply --plan railway-plan.json --yes --confirm-destructive`) so the reviewed change set is what lands. On GitHub Actions, use https://github.com/railwayapp/config.
- Services already managed by `railway.json` must be migrated before `.railway/railway.ts` can manage them.
- Keep one `.railway` file for the whole project. A named `export const partial` (or `PARTIAL` / `const Partial`) is a last resort for separate repos that cannot share that file. Do not add it unless omit=delete across repos is a blocker.
- Use `replicas` for scaling; advanced placement can still specify region names.
- Use `group("Name", [resources])` to keep large projects organized on the Railway canvas.
- Secrets imported from Railway are rendered as `preserve()` so existing values are retained without writing secret values to source. Use `railway config pull --omit-preserved-variables` for a smaller import. `railway config pull --include-variables` decrypts and inlines non-sealed values (including secrets that were never sealed).
- `railway config migrate` finds every `railway.json` / `railway.toml` in the repository and writes them into this one file.
