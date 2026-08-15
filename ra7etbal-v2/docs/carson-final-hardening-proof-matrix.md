# Carson Final Hardening Proof — regression counterfactual matrix

Phase 9 of the Carson Engineering Hardening Project. For each historical regression
class already used as hardening evidence somewhere in this project, this answers:
**"If this exact bad change were submitted today, what automated gate would stop
it — and does that gate actually fail against the bad case?"**

This document does not introduce new tests. It compiles and cites evidence that
already exists in the repository — most of it built during Phases 0–8 and the
final gap-closure pass, one new item from Phase 9 itself (row 1's writer-authority
test). Where a row's proof is a dedicated counterfactual test, the exact test name
is quoted so it can be re-run directly. Nothing here was manufactured against
production; all evidence is either a real historical commit/incident replayed
against current tooling, or a unit/integration test built from a real regression's
own fixture shape.

All required-check names below are cross-checked against
`scripts/validate-carson-registry.mjs`'s `REQUIRED_MERGE_GATE_CHECKS` constant
(Phase 9, rule 10) and the live `gh api .../branches/main/protection` result as of
2026-08-15 — 8 checks, unchanged throughout this document's writing.

---

## 1. Owner WhatsApp canonical-binding contamination (Incident 1)

- **Bad change:** `recordWebhookHeartbeat` (or any future writer) invents a new
  `whatsapp_health_state` binding without both a real `phone_number_id` and a
  caller-verified `user_id` — the exact 2026-08-11 cross-account contamination
  shape.
- **Affected capability:** `owner_whatsapp_canonical_routing`.
- **Registry mapping:** `focused_tests` includes `api/whatsapp-webhook.test.js`,
  `api/_owner-whatsapp-routing.test.js`, `api/whatsapp-health-state-writer-authority.test.js`.
- **Test/contract triggered:**
  `scripts/impact-map.counterfactual.test.mjs` — *"Incident 1 — WhatsApp
  canonical-binding contamination (recordWebhookHeartbeat, api/whatsapp-webhook.js)"*
  proves a change to `api/whatsapp-webhook.js` is mapped to this capability (and
  `whatsapp_delivery_person_identity_continuity`, fan-out). The actual regression
  fixtures live in `api/whatsapp-webhook.test.js` ("never invents a cross-account
  ownership binding") and `api/_owner-whatsapp-routing.test.js` (ambiguous-binding
  fail-closed). `api/whatsapp-health-state-writer-authority.test.js` (added Phase 9,
  this reconciliation) additionally proves the writer-shape invariant statically,
  with real counterfactual mutation of the production file — see
  RA7ETBAL_STATE.md's "WhatsApp health-state writer authority" entry.
- **Required CI check triggered:** `carson-protected-behaviors` (vitest suite),
  `carson-impact-aware-ci` (selects the right tests for this file).
- **Demonstrated failure:** the writer-authority test was proven live by
  temporarily stripping the `on_conflict=user_id,phone_number_id` compound key
  from `upsertHealthState` and confirming the test failed, then reverting.
- **Merge blocked:** yes — both checks are in `REQUIRED_MERGE_GATE_CHECKS`.

## 2. Owner completion push `confirmed_at` mismatch (Incident 2)

- **Bad change:** the completion-push receipt's `dueAt` is generated fresh
  (`new Date().toISOString()`) instead of bound to the real PostgREST-returned
  `tasks.confirmed_at`.
- **Affected capability:** `owner_completion_push`.
- **Test/contract triggered:** `scripts/impact-map.counterfactual.test.mjs` —
  *"Incident 2 — owner completion push confirmed_at mismatch"* proves a change
  to `api/task-confirm.js` selects `api/task-confirm.test.js`. That file's own
  test (`api/task-confirm.test.js:3630`, *"completion receipt dueAt binds exactly
  to the PostgREST-returned confirmed_at — never a freshly generated timestamp"*)
  is PR #246's exact round-trip regression fixture.
- **Required CI check triggered:** `carson-protected-behaviors`, `carson-impact-aware-ci`.
- **Merge blocked:** yes.

## 3. Post-owner-decision worker `person_id` loss (Incident 3)

- **Bad change:** the worker-facing notification after an owner decision is
  written without the same durable `person_id` as the original task assignment.
- **Affected capability:** `owner_decision_lifecycle`.
- **Test/contract triggered:** `scripts/impact-map.counterfactual.test.mjs` —
  *"Incident 3 — worker person_id continuity gap"* proves a change to
  `api/task-confirm.js` + `api/_staff-decision-message.js` selects both
  `api/task-confirm.test.js` and `api/_staff-decision-message.test.js`. Real-Postgres
  proof: `carson-tier1-db-contracts.yml` against migrations
  `20260812_task_review_owner_decision_person_id.sql` /
  `20260812_worker_notification_person_id.sql` — Phase 9 also linked
  `staff-escalation-migration-verification.yml` (job of the same name) as a
  second required real-Postgres gate for this capability's own table.
- **Required CI check triggered:** `carson-protected-behaviors`,
  `carson-impact-aware-ci`, `carson-tier1-db-contracts`, `staff-escalation-migration-verification`.
- **Merge blocked:** yes — all four in `REQUIRED_MERGE_GATE_CHECKS`.

## 4. Automation-runner `person_id`/linkage loss (Incident 4)

- **Bad change:** an automation-runner-linked `whatsapp_deliveries` write drops
  `person_id`, making the event structurally unreachable from Communication
  History with zero error surface (the exact shape that took manual production
  forensics to find the first time).
- **Affected capabilities:** fans out across `automation_execution_confirmation`,
  `communication_history`, `staff_delegation`, `direct_staff_communication`,
  `owner_decision_lifecycle` — five capabilities, because `api/_whatsapp-delivery.js`
  is a shared dependency of all five.
- **Test/contract triggered:** `scripts/impact-map.counterfactual.test.mjs` —
  *"Incident 4 — automation-runner Communication History linkage gap (fan-out
  across three shared files)"* proves a change to
  `api/process-delegation-escalations.js` + `api/send-whatsapp-task.js` +
  `api/_whatsapp-delivery.js` selects all five capabilities and both
  `api/process-delegation-escalations.test.js` and
  `src/lib/carson-communication-history.test.ts`. Production canary
  `evaluatePersonIdContinuity` (`scripts/carson-production-canary.mjs`, class A
  live check) additionally verifies zero recent violating rows in production
  itself, post-deploy.
- **Required CI check triggered:** `carson-protected-behaviors`, `carson-impact-aware-ci`.
- **Merge blocked:** yes. (Post-deploy canary is `workflow_dispatch`-only by
  design — not a merge gate, a separate live-production check.)

## 5. Communication accidentally becoming a delegation

- **Bad change:** `isCommunicationStyleTaskText` regresses so a communication-style
  instruction ("call me", "wait for me") is misclassified as delegated work —
  creates a phantom task and confirmation link where none should exist (the
  PR #49/#50/#52/#53 regression history).
- **Affected capabilities:** `direct_staff_communication` (PERMANENTLY LOCKED
  contract per RA7ETBAL_STATE.md), `staff_delegation`.
- **Test/contract triggered:** `src/lib/carson-protected-behaviors.test.ts`
  (dozens of exact phrase fixtures, e.g. *"'Ask Grace to call me now.' task text
  is communication, not trackable work"* alongside *"'Ask Ghulam to bring the car
  out.' remains tracked delegated work (must not change)"* — both directions
  asserted, not just the positive case), `api/golden-journey-direct-staff-communication.test.js`.
- **Required CI check triggered:** `carson-protected-behaviors`.
- **Merge blocked:** yes.

## 6. Communication History durability incorrectly depending on `task_id`

- **Bad change:** `get_communication_history` (or its callers) depend on
  `task_id` to find historical evidence, so a normal, correct task deletion
  (`ON DELETE SET NULL`) silently makes real historical evidence unreachable —
  the 2026-08-12 regression found live ("What has Christopher told us?" omitted
  a real historical approval).
- **Affected capability:** `communication_history`.
- **Test/contract triggered:** `src/lib/carson-communication-history.test.ts` —
  *"owner-decision history survives task deletion — found via person_id alone"*
  and *"delivery history survives task deletion — found via person_id alone"*
  build real rows, delete the task, and assert the history is still found
  purely through `person_id`. `api/golden-journey-communication-history-durability.test.js`
  and `api/golden-journey-communication-history-cross-writer.test.js` (final
  gap-closure pass) extend this across writers.
- **Required CI check triggered:** `carson-protected-behaviors`.
- **Merge blocked:** yes.

## 7. Stale `RA7ETBAL_STATE.md` closure/status regression

- **Bad change:** a PR silently flips a section from CLOSED/PROTECTED back to
  an incomplete status, or lets a stale-looking section slip through — the
  exact historical stale-state incident this project's Phase 5 was built to
  catch.
- **Affected capability:** `stale_state_doc_integrity`.
- **Test/contract triggered:** `scripts/state-doc-integrity.test.mjs` —
  *"rejects the real historical regression commit against its real parent"*
  replays the actual historical regression commit (not a synthetic fixture)
  and confirms `scripts/state-doc-integrity.mjs` rejects it; the paired test
  *"the real follow-up fix commit that restored the closure passes cleanly...
  (an upgrade, not flagged)"* confirms the tool doesn't false-positive on a
  genuine fix.
- **Required CI check triggered:** `carson-state-doc-integrity` (runs
  `state-doc-integrity.mjs --base origin/main --head <PR HEAD>` for real, not
  just the vitest suite).
- **Merge blocked:** yes.

## 8. Unmapped protected production-file change

- **Bad change:** a new production file that should belong to a Tier 1
  capability is added or changed without any registry mapping, so its own
  tests never run as part of the required suite — silently unprotected code.
- **Affected mechanism:** Impact-Aware CI itself (Phase 2), not a single
  capability.
- **Test/contract triggered:** `scripts/impact-map.counterfactual.test.mjs` —
  *"a genuinely new, unregistered production file ... is caught, not silently
  passed"* asserts `mapChangedFiles` returns the new file in
  `unmappedProtectedFiles` rather than silently ignoring it.
- **Required CI check triggered:** `carson-impact-aware-ci` (fails the build
  when `unmappedProtectedFiles` is non-empty for a production-path change).
- **Merge blocked:** yes.

## 9. Cross-account / RLS regression

- **Bad change:** an RLS policy is loosened or a query stops filtering by
  `user_id`, letting one authenticated account read or write another
  account's rows.
- **Affected capability:** `auth_rls` (cross-cutting; see also
  `owner_whatsapp_canonical_routing`, `owner_decision_lifecycle`).
- **Test/contract triggered:**
  `supabase/migrations/verification/carson_tier1_db_contracts_verification.sql`
  performs real `SET ROLE authenticated` / `RESET ROLE` role-switching against
  a live PostgreSQL instance and asserts cross-account reads/writes are
  rejected — not a mocked client, a real Postgres role boundary.
  `server_authoritative_reminder_rls_verification.sql` does the same for the
  reminders RLS policy, `staff-escalation-migration-verification.yml`'s
  verification files for staff escalation.
- **Required CI check triggered:** `carson-tier1-db-contracts`,
  `real-postgres-rls-proof`, `staff-escalation-migration-verification`.
- **Merge blocked:** yes.

## 10. Owner-decision RPC claim/invariant regression

- **Bad change:** `claim_task_escalation_owner_decision` (or a sibling RPC)
  loses its `SECURITY DEFINER` isolation, its single-claim-wins-under-race
  guarantee, or its restriction to task-review rows only.
- **Affected capability:** `owner_decision_lifecycle`.
- **Test/contract triggered:** `api/task-based-escalation-owner-decisions.test.js`
  — *"provides claim, complete, and fail RPCs restricted to task-review rows"*,
  *"creates claim_task_escalation_owner_decision RPC as SECURITY DEFINER"*,
  *"never automatically reclaims an expired send with an unknown provider
  outcome"*, plus the RPC-throws/RPC-returns-null failure-path tests.
  Real-Postgres proof in `carson_tier1_db_contracts_verification.sql`.
- **Required CI check triggered:** `carson-protected-behaviors`, `carson-tier1-db-contracts`.
- **Merge blocked:** yes.

## 11. Notification lifecycle regression

- **Bad change:** a duplicate `owner_notifications` row, a lost QStash
  callback, or a push/WhatsApp channel silently diverging from the durable
  inbox record — the Notifications Inbox V1 contract.
- **Affected area:** documented in RA7ETBAL_STATE.md's "Notifications Inbox
  V1" entry (not yet a `carson-protected-registry.json` capability — this is
  itself a real, honestly-acknowledged gap, not fabricated coverage).
- **Test/contract triggered:** `src/stores/notifications.test.ts`,
  `src/routes/Notifications.test.ts`, `src/lib/notification-actions.test.ts`,
  `api/_owner-notifications.test.js`, `api/owner-notifications-migration.test.js`,
  `api/owner-notifications-dismissal-migration.test.js` (all currently in
  `pretest:carson-protected`, so they run before every `carson-protected-behaviors`
  check). The durable device-tap lifecycle itself remains a Phase 7-documented
  human-only boundary (classification C) — honestly reported, never silently
  marked PASS by the production canary.
- **Required CI check triggered:** `carson-protected-behaviors`.
- **Merge blocked:** yes for the automatable parts; the human-only boundary is
  not a merge gate by design, same as Phase 7's other class-C items.

## 12. Other regressions already used as hardening evidence

- **Direct push to `main` bypassing PR review** (Phase 6): a throwaway commit
  built directly in the object database and pushed straight to
  `refs/heads/main` was rejected by GitHub itself — `error: GH006: Protected
  branch update failed... 4 of 4 required status checks are expected` — proven
  live against the real repository, not simulated (RA7ETBAL_STATE.md, Phase 6
  entry).
- **`SUPABASE_SERVICE_ROLE_KEY` leak via unredacted `apikey` header** (found
  during this reconciliation's own canary-secrets investigation, PR #275):
  regression test asserts both `Authorization` and `apikey` headers are
  redacted in every logged error path.
- **Canary RPC wrong-token acceptance**: `carson_production_canary_health`'s
  real-Postgres verification proves a wrong/missing token is rejected before
  any production table is touched; independently re-confirmed live via a real
  `curl` against production returning HTTP 403 during this reconciliation.
- **Non-required workflow claiming DB-contract protection** (Phase 9, row added
  by this document's own authoring PR): `validate-carson-registry.mjs` rule 10
  — proven live by temporarily pointing `owner_decision_lifecycle`'s
  `db_contract_workflow` at the non-required `carson-production-canary.yml`
  and confirming the validator rejected it.

---

## What this matrix does not claim

- It does not claim every one of the 76 production migrations has real-Postgres
  verification — `auth_rls`'s own `unresolved` note is explicit that only 4 of
  76 do, by deliberate, documented scope (Phase 4/8).
- It does not claim the Notifications Inbox device-tap lifecycle is mechanically
  provable pre-merge — that boundary requires a real device and is honestly
  reported as human-only (Phase 7 classification C), not silently marked PASS.
- It does not claim `owner-reminder-whatsapp-claim-verification.yml` has a
  registry capability mapping yet — Phase 9 flagged this as a new, honest
  `unresolved` note on `reminders` rather than force-mapping it.
- Rows 1–4, 8 reuse `scripts/impact-map.counterfactual.test.mjs`, which itself
  documents its own scope limit precisely: it proves the *mapper* selects the
  right capability and test file for each incident's real bad-change location,
  not that the selected test's assertions are airtight — that property belongs
  to the test file's own contents, verified separately per row above.
