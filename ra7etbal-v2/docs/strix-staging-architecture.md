# Strix pre-launch security gate — staging architecture (Phase A)

Read-only investigation and design, 2026-08-15. Produces the isolated staging
architecture required before any Strix run, per the locked Strix safety rule:
**no unrestricted active penetration testing against production, production
data, or the production database.** Nothing in this document is implemented —
it is the design that must be approved and provisioned (in part by Sana,
where a new credential is required — see the end of this document) before
Phase B (staging build-out) or Phase C (first controlled Strix assessment)
can begin.

## 1. What staging infrastructure exists today

Checked directly, not assumed:

| Layer | Investigated via | Result |
|---|---|---|
| Supabase | `list_projects` (Supabase MCP) | **One project only**: `ggarvhgqzpooloacjgcj` (production). No second project exists. |
| Supabase branching | `list_branches` on that project | **One branch only**: `main` (`is_default: true`, `persistent: false`). No staging/preview branch exists. |
| Vercel | `list_deployments`/`get_deployment` (this session, repeatedly) | One project, `prj_f32jTzGmYS5m8pc2XU6E0Apw6Y1K` (`ra7etbal-v2`). Every PR gets an ephemeral **preview** deployment, but preview and production deployments point at the **same Supabase project** — confirmed both by direct inspection and by this repo's own documented finding (`RA7ETBAL_STATE.md`'s push-subscription verification entry: "the preview and production Vercel deployments share the same Supabase project (no dedicated staging Supabase project exists ...)"). A preview deployment is not data-isolated from production today. |
| GitHub | `gh api repos/.../environments` | 9 environments exist, all named `Preview*`/`Production*`/`github-pages` — no `Staging` environment, no staging-specific secrets or protection rules. |
| Meta/WhatsApp | `docs/production-verification-policy.md`, `RA7ETBAL_STATE.md`'s "Staging WhatsApp webhook environment" entry | Explicitly documented as **not built** — "a dedicated staging WhatsApp Business Account + Meta App with its own app secret ... target architecture, not yet built." The single production Meta App's webhook always points at `www.ra7etbal.com`. |
| ElevenLabs | Carson Master Plan memory, this repo's own diagnostic tooling (`scripts/carson-diagnose.mjs`) | One live agent only. No staging/sandbox agent exists. `carson-diagnose.mjs` is a read-only diagnostic CLI (`convai_read` scope), not a testing harness. |
| Push notifications | `push_subscriptions` table, Phase 6/7 canary work | Real subscriptions tied to real devices in the single production database. No synthetic/staging subscription pool exists. |
| Cron/automations | `.github/workflows/*.yml`, Vercel cron config | Cron jobs (`api/qstash-reminder.js` scheduling, automation runners) are wired to the single production database and the single production QStash configuration. No isolated staging scheduler exists. |
| External APIs | `.env`/GitHub secrets inventory (names only, values never read) | Same production keys (Supabase, Vercel, Meta, QStash, VAPID) serve every environment today — there is no per-environment credential separation to begin with. |

**Conclusion: zero isolated staging infrastructure exists in any layer.** This
was already known and documented by this repo before today (the "Staging
WhatsApp webhook environment" entry has existed since Workstream 5's
verification-policy work) — today's investigation confirms it is still true
and extends the finding to every layer Strix would need, not just WhatsApp.

## 2. What can be reused vs. what must be isolated

**Safe to reuse as-is (no data/side-effect risk):**
- The application source code itself (Strix's static/local-target mode reads
  a git checkout or repo URL directly — no live target needed for source-level
  analysis).
- Read-only inspection tooling already built this project (`carson-diagnose.mjs`,
  the Vercel/Supabase MCP read paths used throughout this session).
- CI/CD patterns already established (GitHub Actions `workflow_dispatch`-only
  jobs, required-status-check gating) — Strix's own CI integration should
  follow the identical pattern already used for the production canary:
  manual trigger only, never on ordinary PR builds, never a merge gate.

**Must be isolated (cannot reuse production):**
- The Supabase project/database — any account-creation, RLS-bypass, IDOR, or
  business-logic test that actually executes against a real database must
  not touch the one that holds real owner/staff data.
- The WhatsApp/Meta webhook — any test of webhook signature handling,
  inbound message processing, or delivery-status callbacks must not be able
  to send a real WhatsApp message to a real person, and must not be
  reachable by real inbound traffic either.
- Push notification recipients — any test of the push-delivery path must use
  synthetic subscriptions, never real device tokens.
- Cron/automation triggers — any test of the reminder/automation execution
  path must run against synthetic data on a schedule (or on-demand trigger)
  that cannot fire against real production tasks.
- ElevenLabs voice/tool-call surface — if in scope at all, must be tested
  against a non-production agent configuration, never the live Carson agent
  real households talk to.

## 3. Smallest safe Ra7etBal staging environment

Given nothing exists today, the smallest safe design is:

1. **A second, dedicated Supabase project** (new org project, not a branch of
   production — branching still shares billing/infra boundaries and this
   repo's own migrations assume a single canonical project reference in
   several places, e.g. `carson-known-good-release.json`'s `vercel_project_id`
   pairing). Schema replicated via the existing migration files (already
   git-tracked, already the single source of truth for schema — no new
   migration-authoring needed, just applying the existing ones to a new,
   empty project).
2. **A second Vercel project** (or a Vercel project with environment
   variables scoped so its "production" target points at the staging
   Supabase project, never the real one) — deployed from a dedicated
   `staging` branch, never from `main`, so a staging deploy can never
   accidentally become what `www.ra7etbal.com` serves.
3. **A dedicated staging WhatsApp Business Account + Meta App**, exactly as
   already specified in `docs/production-verification-policy.md`'s existing
   target architecture — its own phone number, its own app secret, its own
   webhook URL pointed at the staging Vercel deployment only.
4. **No staging ElevenLabs agent for Phase A/B.** Voice/tool-call surface
   testing is the highest-effort, highest-cost piece to isolate (a second
   agent, a second set of registered tools, a second prompt to keep in sync)
   and this repo's own Carson Master Plan already treats ElevenLabs changes
   as requiring careful, deliberate registration work (see the Blue Pen
   incident's root cause #3). Recommend deferring voice-surface Strix
   coverage to a later, separately-scoped phase rather than building a
   second agent now — Strix's HTTP/API-level coverage (webhook endpoints,
   confirmation links, RPCs, RLS) already reaches the large majority of the
   attack surface named in the locked plan without it.
5. **Synthetic push subscriptions and cron schedules** — generated directly
   in the staging database, never copied from production, with cron/QStash
   scheduling pointed at the staging deployment's own callback URLs.

## 4. Minimum synthetic test data required

To exercise every category the locked plan names, the staging database needs,
at minimum:
- **≥2 distinct synthetic owner accounts** (for cross-account/tenant
  isolation and IDOR testing — one account's data must never be reachable
  from the other's session).
- **≥2 synthetic people/staff records per account** with synthetic phone
  numbers (never real numbers — Meta test numbers or the staging WABA's own
  sandboxed numbers only), at least one with WhatsApp consent granted and
  one with consent withheld (exercises the consent-gating logic already in
  `executeProposedPlan`/`beginWhatsappDelivery`).
- **A handful of synthetic tasks/reminders/automations per account**,
  covering: an open task, a completed task, a task with an active owner
  decision, a task with a real confirmation-link token, a reminder due in
  the past (to exercise the QStash/cron delivery path), and an automation
  run in progress (to exercise `automation_runs`/`whatsapp_deliveries`
  linkage).
- **A synthetic session/JWT per account** for authenticated API testing.
- **No real names, phone numbers, addresses, or message content copied from
  production, ever** — synthetic data only, generated fresh in staging.

## 5. How Strix itself should be installed/integrated

Per the official `usestrix/strix` repository (checked live today, not from
memory — see below):

- **Install**: `curl -sSL https://strix.ai/install | bash`. Requires Docker
  running on the invoking machine (sandboxed execution, not a bare local
  process).
- **Operates via CLI**, results written to `strix_runs/<run-name>/`; a local
  `strix view` dashboard is available.
- **Requires its own credential to operate at all**: an `LLM_API_KEY`
  environment variable (an Anthropic/OpenAI/etc. API key, `STRIX_LLM` model
  spec) — this is Strix's own reasoning-model credential, entirely separate
  from any Ra7etBal secret, and is the first concrete credential blocker
  (see the credential request below).
- **Target modes**: a local file path (`--target ./app-directory`) or a
  GitHub repo URL runs static/source-level analysis with **no live target
  and no new infrastructure needed at all**; a live URL, OpenAPI spec, or
  Postman collection runs dynamic testing against a real, reachable target —
  this is the mode that requires the staging environment above.
- **Built-in scoping controls**: `--scan-mode` (standard/quick), `--scope-mode
  diff` with `--diff-base` (CI mode, limits testing to changed files),
  `--instruction`/`--instruction-file` for explicit rules/exclusions. These
  should be used to hard-scope every run to the staging target only — never
  omit `--target`/rely on a default.
- **CI/CD integration**: the same install command inside a GitHub Actions
  step, `-n`/`--non-interactive` for headless runs, `STRIX_LLM`/`LLM_API_KEY`
  as job secrets. Should be `workflow_dispatch`-only, mirroring the
  production canary's own pattern — never a PR merge gate, never triggered
  automatically.
- **Explicit upstream warning, verbatim**: "only run it against systems you
  own or have explicit, written permission to test, and stay within the
  agreed scope" — Sana owns this repository and its infrastructure, and this
  document's own scoping (staging only, never production) satisfies that
  requirement for the staging target once it exists.

## 6. Threat model — attack surface → staging target → production consequence → existing protection → Strix test needed

| Attack surface | Staging target | Potential production consequence if broken | Existing protection today | Strix test needed |
|---|---|---|---|---|
| Authentication bypass | Staging Supabase Auth + app session handling | Any owner's account reachable without credentials | Supabase Auth, session-scoped Supabase client | Session/token forgery, auth-flow bypass attempts |
| Cross-account/tenant isolation | Staging DB, 2+ synthetic accounts | Owner A sees/edits Owner B's tasks, messages, staff | RLS policies scoped by `user_id` on every table (see `auth_rls`, `carson-tier1-db-contracts.yml`'s cross-account rejection proofs) | Attempt cross-account reads/writes via every authenticated endpoint |
| Supabase/RLS | Staging DB, `SET ROLE authenticated` style probes | RLS policy gap exposes/mutates another account's rows | RLS policies + Phase 4's real-Postgres RLS contract tests (4 of 76 migrations, spot-checked, see this session's migration coverage triage) | Systematic per-table RLS probing beyond the already-spot-checked set |
| IDOR | Staging DB, task/message/delivery IDs | Guessable/enumerable ID exposes another account's record | `person_id`/`user_id` scoping threaded through every writer this session's investigations confirmed (`whatsapp_deliveries`, `whatsapp_health_state` writer-authority tests) | Direct object reference manipulation across every ID-bearing endpoint |
| Privilege escalation | Staging DB, RPCs (`reserve_custom_instruction`, `claim_task_escalation_owner_decision`, etc.) | A caller executes an action reserved for the owner/service role | `SECURITY DEFINER` RPCs are lease-token- and `user_id`-authorized, `REVOKE`d from `PUBLIC`, granted only to `service_role`/scoped roles (confirmed directly this session for the RPCs touching `whatsapp_deliveries`) | Attempt each RPC with wrong/missing lease tokens, wrong `user_id`, or as `anon`/`authenticated` directly |
| Carson APIs | Staging Vercel deployment, `api/*.js` routes | Any state-changing action reachable without proper authorization/idempotency | Idempotency keys (`executeProposedPlan`, delegation flows), service-role-only Supabase writes | Fuzz/replay/parameter-tamper every `api/*.js` route |
| Confirmation links | Staging deep-link tokens | An expired/foreign confirmation link completes an action it shouldn't | Deep-link token scoping (`buildFreshWorkerConfirmationUrl`, `deepLinkToken` validation in `task-confirm.js`) | Token reuse, cross-task token substitution, expiry bypass |
| Owner decisions | Staging `staff_escalation_owner_decisions`/`quality_substitute_decisions` flows | A decision is recorded as the wrong owner's, or duplicated | Claim RPCs (`claim_task_escalation_owner_decision`), first-write-winner semantics, cross-account rejection (Phase 4 contract tests) | Concurrent/duplicate decision submission, cross-account decision attempts |
| WhatsApp/webhook endpoints | Staging Meta App + webhook URL | A forged webhook payload triggers a real state change | `verifyMetaSignature` HMAC check (`api/whatsapp-webhook.js:159`) rejects unsigned/mis-signed payloads with 401 | Signature bypass attempts, replay, malformed payload handling |
| Automation/reminder endpoints | Staging QStash/cron config | A reminder/automation fires against the wrong account or duplicates | `CRON_SECRET`-gated endpoints, idempotent delivery-event recording (Phase 5/8 work) | Endpoint access without/with wrong secret, duplicate-trigger replay |
| Injection | Staging DB + API inputs | SQL/NoSQL injection, prompt injection into Carson's tool calls | Parameterized Supabase queries throughout; no raw SQL string concatenation found in this session's extensive code reading | Standard injection payload sweep across every input surface |
| Sessions/JWT | Staging Supabase Auth | Forged/stolen JWT grants unauthorized access | Supabase-issued JWTs, standard verification | JWT tampering, algorithm-confusion attempts, expired-token reuse |
| Business logic | Staging flows (hosting execution, delegation, owner decisions) | A sequencing bug produces an unintended real-world action (e.g. duplicate send, wrong recipient) | Idempotency keys, fail-closed conflict resolution (this session's `whatsapp_deliveries`/`whatsapp_health_state` investigations), Guard C/D (hosting false-success fix) | Out-of-order/partial-state request sequences against multi-step flows |
| Race conditions | Staging concurrent-request harness | Duplicate execution, lost update, or a claim race gives two actors the same resource | Row-level locks (`FOR UPDATE` in RPCs), lease tokens, partial unique indexes (`whatsapp_deliveries_owner_reminder_task_uidx`) | Concurrent identical requests against every claim/reserve RPC and idempotency-guarded endpoint |

## 7. Staging safety invariants

These must hold before any Strix run against a live staging target, and must
be independently verifiable, not merely asserted:

1. **Staging cannot send a real WhatsApp message.** The staging Meta App's
   phone number is never a real household/staff number; no staging code path
   can reach the production Meta App or its app secret.
2. **Staging cannot mutate production Supabase.** The staging deployment's
   `SUPABASE_URL`/keys point exclusively at the staging project; the staging
   project's connection string is never present anywhere in the production
   deployment's configuration, and vice versa.
3. **Staging cannot execute production cron jobs.** Staging QStash/cron
   configuration is entirely separate from production's; a staging trigger
   firing has zero effect on production schedules or data.
4. **Staging cannot send a real owner push notification.** All staging push
   subscriptions are synthetic, generated in the staging database only.
5. **Staging credentials cannot authorize against production resources.**
   Every staging secret (Supabase keys, Meta app secret, VAPID keys, cron
   secret) is independently generated for staging, never copied from
   production.
6. **Production credentials must never be copied into staging.** If any
   staging setup step would require a production credential's actual value,
   that step stops and is flagged, not silently worked around.
7. **The staging Vercel deployment never serves `www.ra7etbal.com` or any of
   its production aliases.** Confirmed by inspecting the deployment's alias
   list before every Strix run, the same pattern already used this session to
   confirm production deployment identity.

## 8. Findings-handling process

1. Scanner output is a **lead**, not a finding. Every Strix-reported issue is
   independently reproduced against the staging target before being treated
   as real.
2. Reproduced findings are triaged by the same severity lens already used
   throughout this hardening project (does it: send to the wrong person,
   duplicate execution, lose/corrupt state, cause an incorrect irreversible
   external action, bypass RLS/authorization, expose private data, or cause
   a false-success claim?).
3. Confirmed vulnerabilities are fixed **one at a time**, each as its own
   focused change with a regression test proving the fix — never a batch fix
   for multiple unrelated findings in one PR.
4. Each fix runs the full required CI suite (registry validator,
   state-doc-integrity, protected suite, typecheck, build) exactly as every
   PR this session has.
5. The specific Strix test that found the issue is re-run against staging to
   confirm the fix actually closes it.
6. Any production change still goes through the **normal protected PR
   process** — branch protection, required checks, no direct pushes — Strix
   findings do not create a fast-path around existing protection.

## 9. Rollback and cleanup for the staging/Strix infrastructure itself

- The staging Supabase project, Vercel project, and Meta App are each
  independently deletable without any production impact — by design, since
  invariant 5/6 above guarantee no production resource ever depends on a
  staging one.
- Strix run artifacts (`strix_runs/<run-name>/`) are local files, not
  committed to the repository, and can be deleted after each run.
- If staging is ever suspected to have leaked toward production (e.g. a
  misconfigured environment variable), the staging Vercel deployment should
  be paused/deleted first, then the staging Supabase project's keys rotated
  or the project deleted, before any further investigation — fail closed,
  don't investigate live.
- No Strix run should ever be left running unattended against a target that
  can reach real user data; every run is manually triggered and monitored,
  matching this repo's own `workflow_dispatch`-only canary pattern.

## 10. What this document does not do

- It does not build any of the infrastructure above. Building it requires
  new credentials this document is not authorized to create (see below).
- It does not run Strix against anything, staging or production.
- It does not change any production runtime, schema, or configuration.
