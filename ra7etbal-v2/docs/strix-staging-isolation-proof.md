# Strix pre-launch security gate — staging isolation proof (Phase B)

Companion to `docs/strix-staging-architecture.md` (Phase A, merged #294).
Tracks live, mechanically-verified evidence for each staging safety
invariant. **This gate must show PASS on every row before any Strix dynamic
run may begin.**

Last updated: 2026-08-15 (Phase B, staging foundation complete; WhatsApp/
Meta and ElevenLabs surfaces still deliberately deferred).

## Standing rule (Sana, 2026-08-15)

Any problem discovered while constructing or operating staging is treated as
a **staging problem first**. Production is never modified merely to make
staging work. If a staging finding ever suggests a genuine production
defect, the process is: stop before changing production, independently
prove the same defect exists in production using safe/read-only evidence,
report that evidence, and only then discuss remediation. Staging fidelity is
corrected in staging, not by changing application behavior.

## Staging resource identity

| Resource | Production | Staging |
|---|---|---|
| Supabase project ref | `ggarvhgqzpooloacjgcj` | `jmfqzzoqjsfkiqgokqaj` |
| Supabase project name | `sanafaham68@gmail.com's Project` | `ra7etbal-staging` |
| Supabase URL | `https://ggarvhgqzpooloacjgcj.supabase.co` | `https://jmfqzzoqjsfkiqgokqaj.supabase.co` |
| Supabase DB host | `db.ggarvhgqzpooloacjgcj.supabase.co` | `db.jmfqzzoqjsfkiqgokqaj.supabase.co` |
| Region | `eu-west-3` | `eu-west-3` |
| Vercel project | `prj_f32jTzGmYS5m8pc2XU6E0Apw6Y1K` (`ra7etbal-v2`) | `prj_36Q3dOxkilbj7FXUpVMTzhpR5Ut5` (`ra7etbal-staging`) |
| Vercel production branch | `main` | `staging` (dedicated branch, never `main`) |
| Vercel domain | `www.ra7etbal.com` + aliases | `ra7etbal-staging.vercel.app` (no custom domain attached) |

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
| 8 | Staging Vercel project ID != production Vercel project ID | **PASS** | `prj_36Q3dOxkilbj7FXUpVMTzhpR5Ut5` != `prj_f32jTzGmYS5m8pc2XU6E0Apw6Y1K`, confirmed via `get_project` on both. No custom domain attached to staging — only auto-generated `.vercel.app` addresses. |
| 9 | Staging cannot execute production cron jobs | **PENDING** | No staging QStash/cron configuration exists yet — deliberately deferred with WhatsApp/Meta infrastructure (Phase A §3). Currently true by non-existence, not yet independently built and proven. |
| 10 | Staging outbound WhatsApp messaging cannot reach real recipients | **PENDING** | Same as above — WhatsApp/Meta surface deliberately deferred, not yet built for staging. |
| 11 | Staging confirmation links resolve only against staging | **PASS** | The staging app is live and functional at `ra7etbal-staging.vercel.app`, built exclusively against the staging Supabase project (`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` verified baked into the deployed bundle, zero occurrences of the production project ref anywhere in it). Any confirmation link this deployment generates is scoped to this origin only. |
| 12 | Staging owner/staff identities are synthetic | **PASS** | 2 synthetic owner accounts created via real signup on the staging app (`sanafaham1965@gmail.com`, `jewelfaham@gmail.com`), 4 synthetic people (2 WhatsApp-consented, 2 withheld), 6 synthetic tasks (open/done/uncertain mix), 2 synthetic routines — all seeded directly into the staging database, none copied from production. |

**Gate status: PARTIAL PASS.** Rows 1–8 and 11–12 are proven. Rows 9–10
(production-adjacent cron and WhatsApp send paths) remain intentionally
unbuilt per the Phase A design's deferral of the WhatsApp/Meta surface — no
Strix dynamic run covering those specific paths may begin until they are
either built and proven, or explicitly scoped out of a given Strix run.

## Incidents encountered building this environment (staging-only, resolved)

1. **Blank page on first staging deploy.** Root cause: the first build ran
   before `VITE_SUPABASE_ANON_KEY` was actually saved in the Vercel project,
   so Vite baked in an empty string, crashing the app's module-load guard.
   Fixed by re-saving the value and rebuilding (no code changes).
2. **Signup silently failing.** Root cause: this Supabase project defaulted
   to "Confirm email: ON" (the platform default for any new project), but
   the app's signup code assumes confirmation is OFF (matching production's
   actual configured behavior) and doesn't handle a confirmation-pending,
   session-less response. Fixed by turning off email confirmation in the
   staging project's Auth settings — a staging-only Supabase Auth
   configuration change, not a code change, not a production change.

Neither incident indicated an application code defect — both were staging
environment/configuration gaps, consistent with the standing rule above.

## Rollback

Unchanged from Phase A doc §9: the staging Supabase project and the staging
Vercel project are each independently deletable without production impact,
since no production resource depends on any staging one (invariants 6/7/8
above hold; the equivalent WhatsApp/Meta invariant will be proven the same
way once that surface is built, if it ever is).
