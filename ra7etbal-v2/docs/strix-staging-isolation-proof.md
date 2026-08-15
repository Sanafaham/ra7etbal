# Strix pre-launch security gate — staging isolation proof (Phase B)

Companion to `docs/strix-staging-architecture.md` (Phase A, merged #294).
Tracks live, mechanically-verified evidence for each staging safety
invariant. **This gate must show PASS on every row before any Strix dynamic
run may begin.** Currently PARTIAL — Supabase-layer invariants are proven;
Vercel/app-layer invariants are pending deployment.

Last updated: 2026-08-15 (Phase B, in progress).

## Staging resource identity

| Resource | Production | Staging |
|---|---|---|
| Supabase project ref | `ggarvhgqzpooloacjgcj` | `jmfqzzoqjsfkiqgokqaj` |
| Supabase project name | `sanafaham68@gmail.com's Project` | `ra7etbal-staging` |
| Supabase URL | `https://ggarvhgqzpooloacjgcj.supabase.co` | `https://jmfqzzoqjsfkiqgokqaj.supabase.co` |
| Supabase DB host | `db.ggarvhgqzpooloacjgcj.supabase.co` | `db.jmfqzzoqjsfkiqgokqaj.supabase.co` |
| Region | `eu-west-3` | `eu-west-3` |
| Vercel project | `prj_f32jTzGmYS5m8pc2XU6E0Apw6Y1K` (`ra7etbal-v2`) | not yet provisioned — blocked, see below |

Both Supabase projects share the same Supabase organization
(`hjepuwvssiarwytnpvrr`) — this is billing/account-level grouping only, not
data or credential sharing. Each project has its own independent database,
its own independent auth instance, and its own independent API keys issued
by Supabase per-project.

## Schema build evidence

- Foundational schema (11 tables predating migration tracking) reconstructed
  from live, read-only introspection of production's actual current schema
  (`information_schema`, `pg_constraint`, `pg_indexes`, `pg_policies`) and
  applied to staging as migration `00000_foundational_schema_pre_migration_era`.
- All 53 git-tracked migrations in `supabase/migrations/` applied in
  chronological batches, except 2 files skipped because their effect
  (`confirmations_owner_select` policy; `"tasks: reminders require server
  creation"` RESTRICTIVE policy) was already present in the reconstructed
  foundational schema — verified textually identical before excluding.
- Result: 31 tables in `public`, RLS enabled on every one, 0 rows in every
  table.
- `get_advisors(type="security")` run post-migration: all findings are
  pre-existing patterns inherited verbatim from the migration files
  themselves (a handful of trigger functions without a pinned
  `search_path`; a few `SECURITY DEFINER` RPCs reachable by `anon`/
  `authenticated` by original design, e.g. the WhatsApp-webhook-facing
  canary function). Production has these same characteristics today —
  nothing new was introduced by building staging.

## Safety invariant checks

| # | Invariant (from Phase A doc, §7) | Status | Evidence |
|---|---|---|---|
| 1 | Staging Supabase project ID != production project ID | **PASS** | `jmfqzzoqjsfkiqgokqaj` != `ggarvhgqzpooloacjgcj`, confirmed via `get_project` on both. |
| 2 | Staging Supabase URL != production Supabase URL | **PASS** | `get_project_url` on both projects returns distinct hosts (see table above). |
| 3 | No production user records present in staging | **PASS** | `SELECT count(*) FROM auth.users` on staging = 0. |
| 4 | No production phone numbers / people data present | **PASS** | `people` table (and every other table) = 0 rows; no data has ever been imported or copied from production into staging. |
| 5 | No production push subscriptions present | **PASS** | `push_subscriptions` table = 0 rows. |
| 6 | Staging service-role credentials cannot access production | **PASS (by platform guarantee)** | Supabase service-role JWTs are signed per-project; a staging key is structurally rejected by production's PostgREST/GoTrue instance and vice versa. Neither key has been read, copied, or handled by this process — schema work ran through an authenticated MCP session, not a raw key. |
| 7 | Production service-role credentials absent from staging | **PASS** | Never copied; no tooling available to this process can even retrieve a service-role key. |
| 8 | Staging Vercel project ID != production Vercel project ID | **PENDING** | Vercel provisioning blocked — connector currently failing for this session (see Current Blocker below). |
| 9 | Staging cannot execute production cron jobs | **PENDING** | Depends on a staging deployment existing at all; by non-existence this is trivially true today, but must be re-verified explicitly once a staging QStash/cron config exists. |
| 10 | Staging outbound WhatsApp messaging cannot reach real recipients | **PENDING** | App/webhook layer not yet deployed to staging. |
| 11 | Staging confirmation links resolve only against staging | **PENDING** | App layer not yet deployed to staging. |
| 12 | Staging owner/staff identities are synthetic | **PENDING** | Blocked on Option A (real signup through the deployed staging app), which itself needs the Vercel deployment. |

**Gate status: NOT YET PASSING.** Rows 1–7 (all Supabase-layer) are proven.
Rows 8–12 (all Vercel/app-layer) cannot be attempted until a staging Vercel
deployment exists. No Strix dynamic run may begin until every row reads PASS.

## Current blocker

The Vercel MCP connector is failing for this session (`list_teams` /
`list_projects` return "connection invalidated, needs reconnection") despite
showing as connected in Claude Settings. Retested after being told it was
reconnected — still fails. This session cannot proceed with Vercel project
provisioning or app deployment to staging until this resolves. No new
Vercel token has been created; `VERCEL_TOKEN`, `CANARY_RPC_TOKEN`, and
`CRON_SECRET` have not been touched.

## Rollback

Unchanged from Phase A doc §9: staging Supabase project, and (once created)
staging Vercel project and Meta App, are each independently deletable
without production impact, since no production resource depends on any
staging one (invariants 6/7 above hold today; the equivalent Vercel/Meta
invariants will be proven the same way once those resources exist).
