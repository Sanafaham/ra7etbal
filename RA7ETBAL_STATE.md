# Ra7etBal Current State

Last updated: 2026-08-14 (Notifications Inbox release-stabilization closure; Carson Engineering Hardening Project Phase 6)

This file is the operational source of truth for agents working in this repository. Update it whenever a task changes what is complete, protected, blocked, or next.

## Product

Ra7etBal is a personal Chief of Staff that reduces mental load. Carson is the AI Chief of Staff.

Typed Carson and voice Carson are the same person, sharing the same memory, identity, and reasoning. Product decision (2026-07-25): Type to Carson is advisory-only — thinking, planning, drafting, research, and review only. Talk to Carson (voice) remains the sole execution channel for reminders, recurring reminders, push notifications, calendar events, staff messages, hosting plans, delegations, and any other state-changing action. See "Type to Carson is advisory-only" below.

## Current next task

Public launch remains deliberately closed. Do not start another roadmap task until Sana explicitly decides to reopen registration. Reopening requires both Supabase Auth's server-side **Allow new users to sign up** setting and `VITE_PUBLIC_SIGNUP_ENABLED=true`; never enable only the frontend control.

### Notifications Inbox V1 — CLOSED, PRODUCTION VERIFIED, PROTECTED

PR #230 is merged and deployed at `20dd476cf17ccd1e3797b40f0234f8d27aae1b30`. The controlled production reminder `7a982c35-df7f-4e67-b635-cc73425867ff` proved one canonical `owner_notifications` row, one QStash callback, one push attempt batch, one owner-WhatsApp lifecycle, independent channel truth, retry/safety-net deduplication, and cross-owner RLS isolation. Sana confirmed the durable inbox item and unread badge in production.

Production also exposed a V1 completeness defect: reminder notifications stored `/updates?tab=todo`, but that tab reads the separate `carson_todos` model, so the underlying reminder task and its existing Mark done/Delete actions were absent. PR #233 (`3b0168b89a42ebfecc04334327ad4d5f49a25270`) corrected this by routing reminder notifications to `/updates?tab=needs-you&task=<task-id>`, opening the existing Pending task section, and scrolling/highlighting the exact canonical task. Legacy stored reminder notifications derive the same safe route from their kind and task ID, so no notification data rewrite was required. The same UI pass renamed Later to Pending, preserved the existing due-time ordering (overdue unresolved reminders first), labeled the header bell Alerts, and made dates outside the current year show the year. No notification, task, reminder, push, WhatsApp, auth, billing, or household schema/truth contract changed.

The artificial parked task `56666716-ba02-4677-975c-78453b77865f` was verified to have no QStash ID, push attempt, reminder-delivery state, delivery event, notification row, WhatsApp delivery, or automation-run dependency, then deleted through an exact guarded production query on 2026-08-12. Immediate production verification returned zero rows for that ID.

Final production verification on 2026-08-12: Sana tapped the existing controlled notification and production opened Pending with the exact `Notification inbox verification` reminder visible and highlighted; the existing Mark done and Delete actions were visible and neither was used; the Alerts label was visible; and no duplicate notification, push, or WhatsApp appeared. The final database recheck still showed exactly one canonical notification row (`5d6ccd0f-f356-46a6-bad6-045f35903cd7`), one QStash callback, one push-attempt batch across three subscriptions, and one owner-reminder WhatsApp lifecycle (`400774d9-0ce0-4d0a-9e2e-2e63837bf2c9`, webhook-proven `read`). The notification's `read_at` recorded the owner's inbox interaction independently. The canonical task stayed `pending` with `reminder_delivery_status=delivery_unconfirmed`; no channel overwrote another channel's truth.

Protect: one semantic notification per owner event; user/household RLS; independent inbox, push, and WhatsApp evidence; validated internal destinations; reminder deep links resolving to the canonical task rather than `carson_todos`; the existing TaskCard action semantics; Pending's unresolved-task meaning and overdue-first ordering; and the separate What's Happening attention count. Reopen only on a reproduced production regression.

**Update (2026-08-14): Notifications Inbox release-stabilization hotfix — CLOSED, PRODUCTION VERIFIED, PROTECTED.** PR #264 was squash-merged to `main` at `4b9839d26eb85c313995f1644b7a58ac1acd3c45` and deployed by Vercel as production deployment `dpl_ChrYSTwX4VrL6dSFtMhSPMNTQsBT`; `ra7etbal-v2.vercel.app`, `ra7etbal.com`, and `www.ra7etbal.com` all resolve to that deployment with no alias error. The production defect was that several important owner-facing push producers—most visibly recurring/automation execution—sent directly through Web Push without creating the canonical `owner_notifications` row, while one-time reminder producers did persist one. Push delivery therefore succeeded on iOS while the durable in-app Inbox stayed stale. Individual notification dismissal did not exist in schema, data access, store, or UI.

The minimal fix keeps `owner_notifications` as the only durable Inbox system and extends its existing `(user_id, event_key)` uniqueness contract across retained owner-facing reminder, automation-run, completion/review, escalation, and important outbound-failure notifications. Retries reuse the canonical row; no parallel notification store was introduced. Inbox persistence is deliberately fail-open for delivery: a secondary durable-write failure cannot block or duplicate an otherwise working push. Migration `20260814180000_owner_notifications_soft_dismiss.sql` adds only nullable `dismissed_at`, an active-row partial index, and authenticated UPDATE rights limited to that column. Existing owner-scoped UPDATE RLS remains exactly `USING (auth.uid() = user_id)` / `WITH CHECK (auth.uid() = user_id)`. Active Inbox reads exclude dismissed rows; dismissal does not delete historical notification rows or mutate any reminder, automation, task, message, escalation, WhatsApp lifecycle, or push-delivery evidence.

Release verification: typecheck and production build passed; the protected suite passed 79 files / 1,348 tests with zero failures (4 skipped, 3 todo); the final focused dismissal/inbox gate passed 27/27; the protected-behavior registry and impact mapper were updated so the canonical Inbox helper, client query, and dismissal migration cannot bypass impact-aware CI. GitHub's `carson-protected-behaviors`, `carson-impact-aware-ci`, both Vercel checks, and CodeRabbit were green on the final PR head. Production catalog verification after the migration confirmed the column, filtered index, column-level grant, and unchanged owner UPDATE RLS policy. The deployed bundle contains both `owner_notifications` and `dismissed_at`; the protected production scheduler endpoint still rejects unauthenticated requests with HTTP 401.

**Live production acceptance — PASSED on Sana's installed iPhone PWA, 2026-08-14.** Sana created the future reminder `Check the notification inbox.` for 18:56 local time through the supported Carson flow. Exactly one matching iPhone push arrived at 18:56 and exactly one matching Notifications Inbox entry appeared with the correct content and timestamp. Tapping it routed correctly. Sana dismissed it with the new × control, fully closed/reopened Ra7etBal, and confirmed it remained absent. The existing WhatsApp reminder delivery also occurred normally. No duplicate iPhone push and no duplicate matching Inbox row were observed.

Protect additionally: every important retained owner push producer must claim exactly one canonical `owner_notifications` event before/alongside delivery semantics; never make Inbox persistence a prerequisite that can suppress or duplicate push delivery; keep dismissal soft and owner-scoped; never let dismissal alter the underlying business object or delivery evidence; preserve the `(user_id, event_key)` idempotency boundary and existing tap routing. Reopen only on a reproduced production regression.

**Correction (2026-08-13):** this section was briefly, incorrectly reverted to "PRODUCTION CORRECTION PENDING VERIFICATION" by a stale-branch merge (commit `7b83a00`, part of the PR #235 series, branched before PR #234's closure landed on `main`), which also deleted the "Automation-run assignee-confirmation synchronization" item PR #234 had recorded here. That gap is not lost — it is exactly what PR #236 (below) later fixed and closed. Restored from PR #234's original closure text; no unrelated history rewritten.

Notifications Inbox V1 is no longer the current next task — see below.

### Current next task: none ready without Sana's own live check (2026-08-14)

**Correction (2026-08-13):** Post-owner-decision worker WhatsApp identity gap, set as the next task above, was itself found to already be fixed and merged (PR #243) — see its entry below, now marked CLOSED. This file's OPEN-item tracking has repeatedly gone stale this way (see also the Notifications Inbox V1 correction above); do not assume any status in this file reflects `main` without checking the actual code/production state first.

**Full current-state reconciliation (2026-08-14, Stage 1 Item 3):** every section in this file was inspected and cross-checked against `main`, merged PRs, tests, and production evidence where relevant. Result: every item is genuinely CLOSED, LOCKED, FORMALLY CLOSED, or intentionally deferred by product decision (D — e.g. Universal Timestamp System V2, the staging WhatsApp webhook environment, Carson capability expansion, "Meta rejection may still report success" reclassified unverified), **except exactly one genuine C item (implemented but needs a production check only Sana can perform):**

- **"Morning brief does not proactively include reminders"** (PR #24): the fix is merged and deployed — Carson's morning brief automation now includes supported owner reminders due in the next 24 hours. This has never been confirmed by Sana actually hearing/reading a real morning brief that includes a real reminder. This agent cannot self-verify a spoken/typed morning brief experience. **Action needed from Sana:** the next time a real reminder is due within 24 hours, confirm the morning brief actually mentions it, then this file can mark that entry Stable and protected.

Two stale documentation corrections found and fixed in this same pass (no code involved): the "WhatsApp owner decision template" section incorrectly still read "pending Meta approval" despite 24 real production sends since 2026-07-13 (now corrected to CLOSED, PRODUCTION VERIFIED, PROTECTED); the Historical Lookup Phase 1 section had a leftover pre-closure "remaining work" paragraph contradicting its own PERMANENTLY CLOSED header (removed).

**Zero genuine B (open, needs new implementation) items were found.** The Carson Engineering Hardening Project may begin once Sana's morning-brief check above is resolved, or on her explicit decision to proceed without waiting for it.

**Update (2026-08-14):** the Carson Engineering Hardening Project proceeded (Sana's explicit per-phase authorization). Phases 0–6 are complete and merged (PR #257, #258, #259, #260, #261, #262, #263, #266) — see "Carson Engineering Hardening Project — Phase 4 (real-PostgreSQL / RLS contract testing)", "— Phase 5 (stale-state / engineering-record protection)", and "— Phase 6 (GitHub merge/branch protection hardening)" below for the current phases' evidence. Phase 7 has not been authorized.

### Carson Engineering Hardening Project — Phase 4 (real-PostgreSQL / RLS contract testing) — CLOSED, MERGED

PR #260, squash-merged to `main` at `e41cbe4c26f4f1e8990d1f75248d785d28fbbcf0`. Built real-PostgreSQL contract protection (constraints, RLS, RPC behavior, ownership/isolation, migration/rollback) for four Tier 1 tables — `whatsapp_health_state`, `whatsapp_deliveries`, `messages`, `staff_escalation_owner_decisions` — reusing the existing real-Postgres GitHub Actions verification architecture (service container → bootstrap → fixture → forward migration → verification → rollback → post-rollback verify → reapply → re-verify), not a new framework.

New/changed files: `supabase/migrations/verification/carson_tier1_bootstrap_extension.sql`, `carson_tier1_db_contracts_verification.sql`, `carson_tier1_whatsapp_health_state_post_rollback_verification.sql`; `.github/workflows/carson-tier1-db-contracts.yml`; `carson-protected-registry.json` extended with `db_contract_tests`/`db_contract_workflow` on 4 capabilities (`owner_whatsapp_canonical_routing`, `owner_decision_lifecycle`, `communication_history`, `whatsapp_delivery_person_identity_continuity`); `scripts/validate-carson-registry.mjs` and `scripts/impact-map.mjs`/`impact-map.test.mjs` extended to validate and surface those new fields. No production runtime code or schema/migration changed — protection infrastructure and tests only.

Proven (real Postgres 17, real roles/RLS, not mocked): `whatsapp_health_state`'s `UNIQUE(phone_number_id)` canonical-owner binding rejects a second account; owner-isolation RLS (correct account reads own row, different account reads none, different account cannot write, same-account authenticated cannot write — service-role-only write is deliberate); `whatsapp_deliveries`' nullable-`person_id`/`task_id`/`automation_run_id` linkage shapes are all accepted as production writes them (no new NOT NULL invented); real `ON DELETE SET NULL` durability (task deletion nulls `task_id`, `person_id` survives) for both `whatsapp_deliveries` and `messages`; `staff_escalation_owner_decisions`' `claim_task_escalation_owner_decision` RPC persists `person_id`, reuses the row on a duplicate claim (no double-escalation), rejects cross-account claims (`SQLSTATE 28000`), and rejects direct `authenticated`/`anon` execution (service_role-only `EXECUTE`).

CodeRabbit's initial review returned 5 legitimate findings (workflow path-filter gap, an unregistered bootstrap file, `impact-map.mjs` not indexing the new registry fields, an unverifiable epistemic claim about an FK's delete action, and a section-3c assertion that could pass vacuously) — all fixed in a follow-up commit (`21ba1dd`), re-verified end-to-end against a fresh local Postgres 17 instance plus the full test/typecheck/build suite, and included in the same PR before merge. CodeRabbit was rate-limited on the re-review request and explicitly declined a second incremental pass; merge proceeded on the strength of the independent local re-verification plus all 4 required CI checks passing green.

Honest gaps, not silently covered: `messages`' own real `CREATE TABLE`/RLS DDL predates this repo's tracked migration history, so Section 3 of the suite does not assert RLS for `messages` at all, and the bootstrap's `task_id ON DELETE SET NULL` is a documented fixture choice, not a fact independently verified against production DDL. No test currently proves every *future* writer into `whatsapp_health_state` stays scoped correctly — only the current shape is covered. `carson-tier1-db-contracts.yml` is visible and green but is **not yet a required branch-protection merge gate** — that remains explicitly out of scope until a later phase authorizes it.

### Carson Engineering Hardening Project — Phase 5 (stale-state / engineering-record protection) — CLOSED, MERGED

PR #262, squash-merged to `main` at `062da41b52908f57ed972f43dc6ea9fd984bc621`. Replaces the Phase 1 `stale_state_doc_integrity` registry placeholder with a real, working mechanism: a script (`scripts/state-doc-integrity.mjs`) that compares a PR's proposed `RA7ETBAL_STATE.md` against the correct base version from `main` and fails when a previously CLOSED/PROTECTED/PRODUCTION VERIFIED (or otherwise closed-class, per the file's own real observed vocabulary — no invented terminology) section either silently regresses to a non-closed status with no genuinely new, dated `**Correction (date): ...**` / `**Update (date): ...**` marker in its body, or disappears entirely (no marker-based exception for disappearance — a closed section must never simply be deleted).

Counterfactual proof is not synthetic: the checker's test suite loads the actual two git blobs of `RA7ETBAL_STATE.md` from the real historical stale-state incident (commit `7b83a0089876ac784fbd3b9c98a0c5816581fb94`, whose diff silently reverted "Notifications Inbox V1" from `CLOSED, PRODUCTION VERIFIED, PROTECTED` back to `PRODUCTION CORRECTION PENDING VERIFICATION` and deleted an unrelated recorded item) and proves the checker rejects it, while the real follow-up fix commit (`110a155`) that restored the closure passes cleanly.

New CI workflow `.github/workflows/carson-state-doc-integrity.yml` runs on `RA7ETBAL_STATE.md` or its integrity tooling changing. Visible and green, but **explicitly not a required branch-protection merge gate** — that remains Phase 6 scope.

CodeRabbit's initial review returned 4 legitimate findings (a doc/code mismatch implying a marker could excuse a disappearing section when the checker has no such escape hatch; a duplicate-heading anchor collision that could silently hide a regression behind a later same-titled section; a reopen-marker regex loose enough to accept a bare `**Update**` with no date or explanation; and `loadRef` treating an unresolvable base ref the same as a legitimately-missing file, which could mask a CI misconfiguration as "OK") — all fixed in a follow-up commit (`58d4feb`), with new regression tests for each, re-verified end-to-end (22/22 state-doc-integrity tests, registry validation, impact-map tests, full protected suite, typecheck, build). CodeRabbit was rate-limited on the re-review request; merge proceeded on the strength of the independent re-verification plus all required CI checks passing green.

Known limitations, not silently covered: only closed-class-section regression/disappearance is detected — an OPEN/PENDING section disappearing, or a closed section's body being materially gutted while its status wording stays untouched, is not mechanically caught (deliberately, to avoid a brittle prose-diff system that would block harmless wording edits). Section identity is matched by normalized heading title text; a heading rename that also drops its status is not distinguishable from a genuine disappearance-plus-new-section.

### Carson Engineering Hardening Project — Phase 6 (GitHub merge/branch protection hardening) — CLOSED, MERGED

PR #266 (`c7dbc3793da5fc2bca4d5049a15f8f9755578c12`) made `carson-tier1-db-contracts` and `carson-state-doc-integrity` safe to require: both had `paths:`-filtered triggers, which would deadlock any PR that didn't touch those paths if made required (the check would simply never run, leaving GitHub's "expected" status permanently pending). `carson-state-doc-integrity`'s filter was removed entirely (its own cost is small and running unconditionally is also more correct). `carson-tier1-db-contracts` now triggers on every PR but internally computes relevance via a real `git diff` against the PR base and skips only the expensive Postgres verification steps — not the job — when nothing Tier-1-relevant changed, so an unrelated PR still gets a genuine, fast success instead of no status at all. No test coverage was weakened.

Branch protection on `main` was then updated directly via the GitHub API: `required_status_checks` now lists all four hardening checks (`carson-protected-behaviors`, `carson-impact-aware-ci`, `carson-tier1-db-contracts`, `carson-state-doc-integrity`) with `strict: true` (branches must be up to date with `main` before merging); `enforce_admins` was turned on (previously `false` — this was the exact gap that let the historical stale-state incident land as a direct authenticated push, bypassing all protection as an admin). Force-push and branch-deletion protection were already enabled and are unchanged. No branch-protection ruleset or merge queue was configured — classic protection already covers the target contract and a second, potentially-conflicting mechanism wasn't warranted for a single-owner repository processing one PR at a time.

**Deliberately not enabled: required PR review/approval.** This repository has one human owner and no second collaborator who could approve Sana's own PRs — GitHub does not count self-approval, so a "1 approving review" rule would have made the repository unusable by its own owner. CodeRabbit was also confirmed unreliable as a review gate (rate-limited on multiple prior phases' PRs, and it comments rather than issuing a formal APPROVE review state). Protection instead comes from `required_status_checks` (which, by construction, can only be satisfied by a commit that went through a `pull_request`-triggered CI run — a direct push to `main` can never carry that status) combined with `enforce_admins`.

**Historical counterfactual, proven live, not simulated:** a throwaway commit was built directly in the object database on top of `origin/main` (never checked out, never part of any branch) and pushed straight to `refs/heads/main` — the exact mechanism of the historical incident. GitHub's server rejected it: `error: GH006: Protected branch update failed... 4 of 4 required status checks are expected.` `origin/main`'s SHA was confirmed unchanged before and after the attempt. The historical route is mechanically closed.

**Deadlock-safety proven live, not just by design:** PR #266 itself doesn't touch `RA7ETBAL_STATE.md`, its integrity tooling, or any Tier 1 DB-contract migration/verification path (aside from the workflow file it edits, which is itself in `carson-tier1-db-contracts`' relevance set) — and both `carson-state-doc-integrity` and `carson-tier1-db-contracts` still reported genuine, real successes on it, confirmed by inspecting each job's own log output (`state-doc-integrity: OK ...` ran unconditionally; the DB-contracts job's "Determine relevance" step correctly evaluated the changed-file set via a real `git diff`).

Remaining limitations: no branch-protection ruleset (classic protection only); no merge queue (not needed at current single-PR-at-a-time usage); required PR review is intentionally absent per the reasoning above, so a compromised admin credential could still merge unreviewed code as long as it passes CI — only a second human reviewer or signed-commit policy would close that residual gap, and neither is operationally available today.

Phase 7 scope has not been authorized — do not begin without Sana's explicit go-ahead.

### Communication History durable person attribution — CLOSED, PRODUCTION VERIFIED PASS

Sana's own master-plan tracking (kept outside this repo) numbers the Unified/Immutable Communication History capability as Workstream 4, Phase 1 — this file has never carried that numbering, so this entry documents the durability fix on its own terms; do not mark Workstream 4 complete based on this entry alone — that decision belongs to Sana's own tracking, and is explicitly gated on the production test below.

**Root cause found (read-only investigation, 2026-08-12):** `staff_escalation_owner_decisions.task_id` and `whatsapp_deliveries.task_id` are `ON DELETE SET NULL` against `tasks.id`. Task deletion — Updates → History → Clear History (`deleteTasks()`, bulk, `status='done'` only) and Carson's voice "delete that task" (`deleteTask()`, single row) — is a real, intentional, actively-used feature, not a bug. But every time a task is deleted, any `staff_escalation_owner_decisions`/`whatsapp_deliveries` row that was linked to it silently loses its only linking key, even though the row's own content survives intact. `get_communication_history`'s wave-2 join (added by the 2026-08-11 Communication History patch) depended entirely on that link, so it silently stopped finding real historical evidence — traced live via a production regression: Carson's answer to "What has Christopher told us?" omitted a real, historically-true owner approval event because its task had since been cleared through this normal, working feature. Blast radius at time of fix: 100% of `staff_messages.task_id` (41/41), 89% of `staff_escalation_owner_decisions.task_id` (16/18), 99.3% of `whatsapp_deliveries.task_id` (685/690) — accumulated gradually since 2026-07-27 through routine, correct use of task deletion, not one incident.

**Decision: do not change task deletion, Clear History, or the `ON DELETE SET NULL`/`CASCADE` behavior.** Instead, add a durable `person_id` column to the two evidence tables, populated at write time from an already-resolved person identity that exists independent of the task, and never affected by task deletion.

**What was implemented** (migration `20260812_durable_person_id_communication_history.sql`, additive only):

- `staff_escalation_owner_decisions.person_id` and `whatsapp_deliveries.person_id` — new nullable `uuid` columns, FK to `people.id`, indexed. `messages.person_id` already existed as a plain column (no FK — one pre-existing row has an orphaned value that was not touched); this migration does not add an FK to it.
- `claim_escalation_owner_decision` RPC now populates `person_id` from the `staff_messages` row it already loads for authorization (`v_msg.person_id`) — zero new queries. `claim_task_escalation_owner_decision` (the task-based quality-review path, no staff message involved) is unchanged and correctly leaves `person_id` NULL — `tasks` has no person identity to derive it from.
- `messages.person_id` is now populated at write time across every production send path that creates a `messages` row — `send_delegation` (voice/typed), `send_direct_whatsapp_message`, the typed direct-message fast path, Todos/Inbox delegate actions, and `save.ts`'s brain-dump delegation path. Every one of these paths was already resolving a real `Person` (exact id or exact case-insensitive name match against the `people` table) before creating the message — this only threads the id that was already there through into the row. No new recipient-resolution logic was added anywhere; when a path only has free text with no matching person, `person_id` stays NULL, never guessed.
- `beginWhatsappDelivery`/`resolveDeliveryContext` (`api/_whatsapp-delivery.js`) resolve `person_id` from a linked `staff_messages.person_id` or `messages.person_id`. If both are present and disagree, `person_id` is left NULL rather than guessing — logged, never silently resolved.
- `get_communication_history`'s wave 2 now queries both tables by `person_id.eq.<id>` OR the existing legacy `task_id`/`message_id`/`staff_message_id` linkage, in one `.or(...)` per table — a single row satisfying both branches is returned once by Postgres, so no duplicate-event risk from the dual path.

**Deterministic-only backfill, applied to production 2026-08-12** (no timestamp proximity, no text/name matching, no task-description guessing): `staff_escalation_owner_decisions` — 9 of 18 rows recovered via surviving `staff_message_id → staff_messages.person_id` (never touched by task deletion). `whatsapp_deliveries` — 9 of 690 rows recovered via `metadata->>'staff_message_id'`; the migration's initial attempt also tried a second path (`message_id → messages.person_id`), but production's one existing non-null `messages.person_id` value does not itself match any real `people.id` — an already-orphaned value from before this fix, unrelated to task deletion. The migration failed cleanly (no partial write) on that FK violation; the backfill query was corrected to require the source value independently resolve to a real `people` row before copying it, and reapplied — confirmed 9/18 and 9/690, exactly as expected. 681 `whatsapp_deliveries` rows remain permanently NULL and unrecoverable — `messages.person_id` was essentially never populated before this fix, so almost nothing survives to backfill from for ordinary delegation/direct-message deliveries. This is an accepted, known limitation of historical data written before this fix; going forward, new writes populate `person_id` reliably wherever a person was already resolved.

**Separate finding, explicitly not addressed by this fix:** `messages`, `confirmations`, `quality_substitute_decisions`, and `reminder_delivery_events` are `ON DELETE CASCADE` (not `SET NULL`) against `tasks.id` — meaning Commitment History likely has a *more severe* version of this same defect: full row loss on task deletion, not just orphaning. Flagged as a separate, high-priority, read-only follow-up investigation. Not folded into this PR.

**Production verification required before closing:** ask Carson (voice or typed) "What has Christopher told us?" and confirm the answer includes the historical owner-approval event that was previously missing (the "Approve it" decision, correctly dated, correctly attributed to the owner as "you"), with no fabricated dates and no duplicate events. Do not mark this closed, and do not mark Sana's own Workstream 4 tracking complete, before that evidence exists.

**Correction, found during the required production retest (2026-08-12):** the retest failed. The "Approve it" decision still did not appear, and Carson separately fabricated an unsupported "August 5" date for a Christopher photo event (traced and confirmed: no such event exists anywhere in the reachable data — model-side rendering issue, tracked separately below, prompt not touched). Investigating the missing "Approve it" row corrected an assumption this entry's own earlier write-up carried: the row is **`review_type = 'substitute_review'`**, created via `claim_task_escalation_owner_decision` (the task-based quality-review path) — **it was never staff-message-linked**, despite being chronologically adjacent to a Christopher photo submission. The backfill above (9/18) only ever covered `claim_escalation_owner_decision`'s staff-message-linked path; it could never have reached this row. This was a genuine gap in the fix described above, not a defect in it — see the next entry.

**CLOSED, PRODUCTION VERIFIED PASS (2026-08-12).** A fresh controlled production delegation (task `f51a864c-5625-4c39-8a37-bd6ea0fc3489`, "Buy a blue pen," assigned to Christopher) proved this fix's own write path directly: the original assignment `messages` row and its `whatsapp_deliveries` row both carried Christopher's canonical `person_id` at write time, exactly as this fix implemented. The "Approve it" historical row remains permanently unrecoverable as documented above — that is expected, not a defect. See the next entry for the follow-up gap this same test surfaced and closed.

### Task-based owner-decision durable person attribution — CLOSED, PRODUCTION VERIFIED PASS (PR #237)

Follow-up to the entry above. The prior fix (PR #235) made `person_id` durable for `claim_escalation_owner_decision` (WhatsApp-staff-message-triggered escalations, `review_type='staff_escalation'`) only. `claim_task_escalation_owner_decision` (`uncertain_proof`/`substitute_review`/`correction_limit` — proof-upload-triggered, no WhatsApp staff message involved) was deliberately left unchanged, because `tasks` has no person identity to derive one from. A full read-only trace of every caller confirmed no canonical `people.id` was resolved anywhere in that call path before this fix — `task-confirm.js`'s two active call sites (`uncertain_proof`, `substitute_review`) only ever had `task.assigned_to` (free text).

**What was implemented** (migration `20260812_task_review_owner_decision_person_id.sql`): `claim_task_escalation_owner_decision` gains an optional `p_person_id` parameter (default NULL, backward compatible — the old 3-argument signature is explicitly dropped first so PostgREST never sees an ambiguous overload). `notifyOwnerOfTaskReview` (`api/_escalation-notify.js`) resolves it from the same `userId`/`assignedTo` it already receives, via a new exact, case-insensitive name-match lookup against `people` — mirroring the resolution shape already trusted elsewhere in this codebase (`task-confirm.js`'s `findAssigneePerson`), not new identity logic. Ambiguous (more than one matching name) or failed lookups leave `person_id` NULL, never guessed. `task-confirm.js` itself was not touched — no changes needed to its two call sites or its 120-test suite.

**No backfill was possible or attempted.** Traced exhaustively: no call path for this creation type ever resolved a person identity, so no existing task-based row — including the motivating "Approve it" row — has any surviving deterministic evidence of who it concerned. Per the deterministic-only rule, it was **not** manually set to Christopher's `person_id` despite this investigation knowing that from context; it remains NULL, an accepted, permanent, historical limitation. Only rows created after this fix ships will have `person_id` populated.

Communication History's query was not touched — it already queries `staff_escalation_owner_decisions` by `person_id` regardless of `review_type` (verified directly; that column isn't even read by the query), so no redesign was needed once `person_id` is populated correctly.

**Separate, still-open issue, not addressed by any of this:** Carson fabricated an "August 5" date for a Christopher event with no supporting row anywhere in the reachable data, during the production retest that surfaced this whole gap. This is a model-rendering issue, not a database or query defect — the prompt's existing actor/date rules were deliberately not touched in this pass, per explicit instruction. Remains open.

**CLOSED, PRODUCTION VERIFIED PASS (2026-08-12).** A fresh `substitute_review` owner decision was created post-deploy on the same controlled test task (`f51a864c-5625-4c39-8a37-bd6ea0fc3489`): Christopher submitted a white pen instead of the requested blue pen, and the resulting `staff_escalation_owner_decisions` row (`c1737d63-1920-45ce-ba96-7d6ac7ba7441`) was queried directly and confirmed to carry `review_type = 'substitute_review'`, `person_id` = Christopher's exact canonical `people.id`, and `staff_message_id = NULL` — proving this fix's write-time assertion for the task-based path, exactly as designed. Exactly one decision row existed (no duplicate creation). This production test is the same event that surfaced the separate, still-open post-owner-decision worker WhatsApp identity gap recorded below — that gap is **not** part of this fix's scope and does not affect this verdict; PR #237's own write path is closed and correct.

### Owner completion push reliability — CLOSED: DEVICE-STAGE OBSERVABILITY DEFECT FIXED, PRODUCTION VERIFIED, PROTECTED (PR #240, fixed by PR #246)

Not part of Workstream 4 / PR #237 — a separate capability, surfaced while producing PR #237's own controlled production test. Do not fold this into or reopen PR #237 based on this entry.

**Verified production incident (task `f51a864c-5625-4c39-8a37-bd6ea0fc3489`, "Buy a blue pen," 2026-08-12 13:23:58 UTC):** Christopher completed the task through the normal confirmation flow. Vercel runtime logs proved `sendOwnerPush()` ran and `webpush.sendNotification()` resolved without error for all 3 of the owner's enabled push subscriptions (server-side send confirmed clean) — but the owner never saw the notification, and `push_subscriptions.enabled=true` confirmed the eligibility gate was open. Root cause could not be proven beyond "provider accepted the send" because `sendOwnerPush` had zero durable evidence — only `console.log`, no database row — for anywhere between provider acceptance and device display.

**What was implemented** (PR #240, merge commit `7e497adc137d40e9b37e8a08eb2315a322690fb2`): reuses the existing reminder-push observability system (`reminder_delivery_events`, `recordDeliveryEvent`, signed receipts, `send-push-for-task.js`'s endpoint dedup, `sw.js`'s already-generic receipt reporting) rather than building a second one. `sendOwnerPush()` gains an optional `taskId` — only the final-completion call site (no `variant`) passes it; the four QI review/escalation-variant call sites are unaffected (verified by a dedicated regression test: unchanged payload, no durable recording). When present: dedupes subscriptions by endpoint, includes a signed receipt in the push payload, records `provider_send_attempted`/`provider_accepted`/`provider_rejected`. Receipt signing is wrapped so a signing failure (e.g. `CRON_SECRET` unset) degrades to the pre-existing plain payload rather than losing the notification entirely. `qstash-reminder.js`'s `notification-receipt` handler is widened to accept `kind: 'completion'` (validated against `tasks.confirmed_at`) alongside the existing default `kind: 'reminder'` (validated against `due_at`, byte-for-byte unchanged) — same HMAC signing/verification, no security weakening. `sw.js` forwards one new field (`receipt.kind`) — the only service-worker change, additive, backward compatible with already-cached copies. Event-kind separation uses existing `metadata.kind` — no schema change for that.

**Evidence-retention fix, resolved before implementation per the Engineering Completeness Rule** (migration `20260812_reminder_delivery_events_survive_task_deletion.sql`, applied to production): `reminder_delivery_events.task_id` was `NOT NULL, ON DELETE CASCADE` — Clear History deleting a just-completed task would have deleted this new evidence outright, the same durability class already fixed for `staff_escalation_owner_decisions`/`whatsapp_deliveries.person_id` above. Verified against every current reader before changing it: `carson-commitment-history.ts` only queries a still-loaded reminder task by id (unaffected); `push-notifications.ts`'s `listPushSubscriptionDevices()` filters by `user_id`/`subscription_id` only, never `task_id` (unaffected, and benefits — its "last delivered" evidence no longer disappears when history is cleared). Relaxed the FK to `ON DELETE SET NULL`, dropped `NOT NULL` — additive/backward-compatible, existing rows untouched, mirrors the PR #235 precedent exactly.

No WhatsApp completion behavior added — WhatsApp was never part of this contract (confirmed by code trace and absence in git history) and stays that way.

**Tests:** `api/task-confirm.test.js` (+3), `api/qstash-reminder.test.js` (+8), `public/sw.test.js` (+1). `npm run test:carson-protected` — 1068/1068 passing. Typecheck and production build clean.

**Original verdict (2026-08-12), preserved as historical record — no longer the current status, see correction below.** A real post-deployment staff-task completion (task `d9a814f8-1862-476d-888d-04f8de033001`, "Please confirm the kitchen is ready," assigned to Christopher, `confirmed_at = 2026-08-12 16:59:54.555+00`) produced exactly one logical completion-push lifecycle per each of the 3 enabled subscriptions (`provider_send_attempted` → `provider_accepted`, all `metadata.kind = "completion_push"`, no duplicates, no extra/missing subscriptions targeted) — confirmed via direct `reminder_delivery_events` query. Sana visibly received the push ("Christopher confirmed: Please confirm the kitchen is ready."). `service_worker_received`/`show_notification_attempted`/`notification_clicked` were absent for this event — the client-side receipt never reached the server (confirmed via Vercel runtime logs on the exact deployment: no `notification-receipt` POST in that window). This was read as truthful-not-defect at the time: the durable lifecycle correctly shows evidence stops at `provider_accepted`, exactly the "tell us where it stopped" behavior this capability was built to provide, rather than falsely claiming visible delivery. Reminder-push regression: confirmed unchanged from the merged code/tests (byte-for-byte identical reminder-kind validation in the widened receipt handler); no live reminder retest was run since no evidence indicated a regression.

**CORRECTION — REOPENED (2026-08-13): device-stage observability defect confirmed by direct Vercel log evidence, not merely suspected.** A later production completion event (task `c5a07eff-a624-4d03-8ea9-5c6bacb2a78b`, delegated to Christopher via a Carson-created one-time automation, `tasks.confirmed_at = 2026-08-12 22:31:44.395+00`) produced the same provider-side pattern as above — `reminder_delivery_events` shows exactly one `provider_send_attempted` → `provider_accepted` pair per each of 3 subscriptions, `metadata.kind = "completion_push"`, zero `provider_rejected`, Sana physically received the push — but this time the service worker *did* call back, unlike the original verdict's event. Direct Vercel runtime log query (`get_runtime_logs`, project `ra7etbal-v2`, window `2026-08-12T22:31:00Z`–`22:45:00Z`) shows six `POST /api/qstash-reminder` requests at `22:31:46`–`22:31:52`, **all returning HTTP 404**. Reading `handleNotificationReceipt` in `api/qstash-reminder.js` directly: a 404 here can only mean `isValidCompletion` was false, i.e. `task.confirmed_at !== dueAt`. This is directly corroborated by the DB evidence already captured: the receipt's embedded `dueAt` is `2026-08-12T22:31:44.781Z`, 386ms after the real `tasks.confirmed_at` of `2026-08-12 22:31:44.395+00` — never equal, because `sendOwnerPush()` (`api/task-confirm.js`) computes its receipt's `dueAt` as `const sentAt = taskId ? new Date().toISOString() : null;` at push-send time, independently of the `now` value already written to `tasks.confirmed_at` moments earlier in the same request, rather than reusing it. Six honest device receipts, six rejections — this is a real, reproducible defect in the completion-push observability capability, not an absence of evidence: it explains why *both* investigated events show no `service_worker_received`/`show_notification_attempted`/`notification_clicked` rows, just via two different failure modes (no callback attempt at all vs. six callback attempts all rejected).

**Interim status (2026-08-13, superseded by the fix below): MERGED. DEPLOYED. PROVIDER-SIDE PRODUCTION VERIFIED. DEVICE-STAGE OBSERVABILITY DEFECT OPEN.** Preserved as historical record of the confirmed-defect state between discovery and fix. Record explicitly, for anyone reading this section: the owner did physically receive the push (confirmed twice, independently, by direct observation) even while this defect was open; provider-side durable evidence (`provider_send_attempted`/`provider_accepted`, endpoint dedup, correct `kind`, retention) was fully proven throughout and never needed reverifying; the gap was specifically that the system could not yet truthfully record which device-side stages the notification reached, because its own validation gate incorrectly rejected genuine device receipts.

**Fix implemented and merged (PR #246, merge commit `485c25973e7fc49ffd073cc8d4ec0ddf90c690c3`, squashed from branch `fix/pr240-completion-receipt-timestamp-binding`):** `sendOwnerPush()` (`api/task-confirm.js`) now accepts a `confirmedAt` parameter instead of generating a second, independent timestamp — the completion call site threads through the PATCH's own PostgREST-returned `confirmed_at` (`Prefer: return=representation`, no `select=` filter → full row), the exact value `approvedRows?.[0]?.confirmed_at`, falling back to the in-memory `now` only if PostgREST didn't return a representation (defensive; not expected in production). This mirrors the pattern the existing, always-correct reminder path already uses (`send-push-for-task.js`'s `dueAt: task.due_at`, also PostgREST-sourced) — both the write and the later validation read go through the identical PostgREST serialization layer for the same column, so the values are guaranteed to match byte-for-byte. No other `sendOwnerPush` call site is affected (only the `taskId`-gated completion path uses `confirmedAt`; the four QI review/escalation variants and the two `whatsapp-webhook.js` call sites never pass `taskId`). Preserved unchanged: HMAC signing/verification, event-kind separation, `provider_send_attempted`/`accepted`/`rejected` recording, endpoint dedup, 404/410 dead-subscription cleanup, reminder-receipt validation, PR #236 automation-run synchronization, owner-decision routing, Quality Intelligence, WhatsApp behavior. No schema change. New regression tests: exact `dueAt`-binding proof (proves it's the PostgREST value, not a freshly generated one), a full round-trip test feeding `sendOwnerPush`'s actual receipt output into `qstash-reminder.js`'s real validation handler, `show_notification_attempted` stage coverage, and a PR #236 non-interference test. 136 `task-confirm.test.js` + 40 `qstash-reminder.test.js` passing; full `test:carson-protected` (55 files, 1091 tests) passing; typecheck and production build clean. Deployment confirmed: `dpl_2fb8apa1yRT4KYLn4QcgcdcPJvM5`, `readyState: READY`, `target: production`, `githubCommitSha` matches the merge commit exactly, `alias` includes `www.ra7etbal.com`/`ra7etbal.com`, `aliasError: null`.

**CLOSED, PRODUCTION VERIFIED PASS (2026-08-13).** A fresh controlled production completion (task `d28b2d8f-083e-4a24-93bd-ec3e48e6e812`, "Please confirm the kitchen is ready," a plain delegation — not an automation, `automation_runs` count for this task is correctly `0`) on the exact PR #246 deployment (`dep=dpl_2fb8apa1yRT4KYLn4QcgcdcPJvM5`) proves the defect is fixed:

- `tasks.confirmed_at = 2026-08-13 00:51:47.496+00`.
- `reminder_delivery_events` for this task: 12 rows — `provider_send_attempted`×3 and `provider_accepted`×3 (`provider_status_code=201`, zero `provider_rejected`, `metadata.kind="completion_push"`), plus, for the first time on a genuinely mismatched-in-the-past event, real device-stage rows: `service_worker_received`×2 and `show_notification_attempted`×2 and `show_notification_resolved`×2 (`metadata.kind="completion"`), one set per each of 2 actively-reporting subscriptions — zero `show_notification_failed`, no `notification_clicked` (Sana received but did not tap it, correctly not fabricated).
- The receipt's embedded `dueAt` (`2026-08-13T00:51:47.496+00:00`) and `tasks.confirmed_at` (`2026-08-13 00:51:47.496+00`) are now the same canonical persisted timestamp — the exact regression PR #246 targeted.
- Direct Vercel runtime log query (`get_runtime_logs`, scoped to `dep=dpl_2fb8apa1yRT4KYLn4QcgcdcPJvM5`, window `2026-08-13T00:51:40Z`–`00:52:10Z`) shows six `POST /api/qstash-reminder` requests at `00:51:49`–`00:51:53`, **all HTTP 200** — zero 404s, directly reversing the prior confirmed-defect event's 6/6 404 result on the exact same endpoint under the exact same conditions. No error/warning-level logs for this task in the surrounding window.
- No duplicates: exactly 1 `confirmations` row, 3 `provider_send_attempted` (one per unique subscription endpoint, matching the existing dedup guarantee), each device-stage sequence recorded exactly once per subscription — no reminder-kind contamination (every row correctly tagged `completion`/`completion_push`), no stray `automation_runs` row (this was a plain delegation).
- Deployment identity independently confirmed via both the Supabase evidence's timing and the Vercel log's own `dep=` tag matching `dpl_2fb8apa1yRT4KYLn4QcgcdcPJvM5` → `githubCommitSha: 485c25973e7fc49ffd073cc8d4ec0ddf90c690c3` (the PR #246 merge commit, exact match).

Protect: the `confirmedAt` threading in `sendOwnerPush()` and its call site in `task-confirm.js` (`confirmedAt: approvedRows?.[0]?.confirmed_at || now`) — do not reintroduce an independently-generated timestamp for the completion receipt's `dueAt`, and do not thread anything into it other than the PATCH's own PostgREST-returned `confirmed_at`. Reopen only on a reproduced production regression (a fresh completion event showing 404 on `notification-receipt`, or a `dueAt`/`confirmed_at` mismatch in `reminder_delivery_events`).

### Synchronize automation runs on task confirmation

Status: COMPLETED. MERGED. DEPLOYED. PRODUCTION VERIFIED. PROTECTED.

PR #236, merge commit `ed34027daec7c66f1fc2a302a661457aeff4a781` (two commits: `d8cf352` initial sync, `358218c` "Require confirmation evidence for run repair" hardening). Lives at `api/_automation-run-confirmation-sync.js` + `api/task-confirm.js` (four call sites) + a companion fencing fix in `api/whatsapp-webhook.js`.

What it is: when a task is confirmed (`status='done'`, `confirmed_at` set) through any of `task-confirm.js`'s four confirmation call sites, `synchronizeAutomationRunFromConfirmedTask()` projects that confirmation onto the linked `automation_runs` row (matched by `task_id`+`user_id`) by setting `current_state='confirmed'` and `confirmed_at=task.confirmed_at`. The task remains sole authority — this only projects, never confirms a task itself. Fails closed (no write) when: zero or more than one `automation_runs` row is linked to the task (ambiguous linking, logged as an error), the run is already in a protected terminal state (`confirmed`/`completed`/`skipped`), or the run isn't in a confirmable pre-state (`task_created`/`sent`/`followup_sent`/`escalated`/`failed`). The PATCH itself re-filters by `id`+`task_id`+`user_id`+`current_state IN (confirmable states)` at write time (compare-and-swap), so a concurrent duplicate write cannot double-apply. The concurrent-loser reload path (`loadCanonicalConfirmedTask`) additionally requires a matching `confirmations` evidence row (exact `task_id`+`confirmed_at`) before treating a reloaded task as canonically confirmed. `current_state: 'confirmed'` is written nowhere else in the codebase, so finding that value on a live row is a unique fingerprint of this exact code path having executed.

Production verification evidence (2026-08-13, independently confirmed via direct read-only Supabase queries against project `ggarvhgqzpooloacjgcj`): Carson voice request created a one-time automation (`automation_id 340eb0a1-d24d-4876-a795-b752ca3b93fb`) → Christopher received the WhatsApp task at the scheduled time with confirmation link `task=c5a07eff-a624-4d03-8ea9-5c6bacb2a78b` → Christopher tapped Mark done → Sana received the owner confirmation push → the task left Waiting. `automation_runs` for that `automation_id` returns exactly one row (`76365830-00c7-48a6-8b26-576d1f03e08f`), `task_id = c5a07eff-a624-4d03-8ea9-5c6bacb2a78b` (matching the WhatsApp link exactly), `current_state = confirmed`, `confirmed_at = 2026-08-12 22:31:44.395+00` — byte-for-byte identical to `tasks.confirmed_at` on the same task, proving the PATCH's `confirmed_at: task.confirmed_at` assignment landed exactly as coded.

Not required for this closure, and still not exercised in production (covered by the existing focused unit test suite, not blocking): a duplicate/concurrent confirmation attempt (double-tap or WhatsApp webhook retry hitting the confirmation link twice) was not manually re-tested in production.

Protect: `synchronizeAutomationRunFromConfirmedTask`'s fail-closed ambiguous-run guard, the protected-terminal-state set, the `confirmations`-evidence requirement on the concurrent-loser reload path, and the `whatsapp-webhook.js` late-failure fencing (`current_state=in.(scheduled,task_created,sent,followup_sent,escalated,failed)`) that stops a late Meta delivery-failure webhook from clobbering an already-confirmed/completed/skipped run. Reopen only on a reproduced production regression.

### Explicit one-time automation routing (client-only) — superseded

Status: MERGED. SUPERSEDED/ABSORBED BY PR #241. Not independently production-verified — do not describe as protected on its own.

PR #239, merge commit `35c71db848741082766ae9b960c704764f71336d`. Purely client-side: added `one-time-automation-routing.ts`'s explicit-intent heuristic and wired it into `ElevenLabsAgentWidget.tsx` so a clearly-worded one-time automation request routes to `create_automation` instead of a reminder. No server-side (`api/`) file, no migration, no RLS.

Why it doesn't stand alone: being client-only, the routing decision lived entirely in JS shipped to the browser. An already-loaded, stale PWA session (old cached bundle) never runs this logic at all, so it could not protect against the exact misrouting it was built to fix — a purely client-side interception has no way to enforce anything against a client it doesn't control. PR #241 (below) closed that gap with a server/RLS-enforced boundary that holds regardless of client cache state.

Do not reopen or re-verify this PR in isolation — its behavior is carried forward and superseded by PR #241's authoritative routing + RLS enforcement, verified below.

### Authoritative one-time automation routing (server + RLS)

Status: COMPLETED. MERGED. DEPLOYED. PRODUCTION VERIFIED. PROTECTED.

PR #241, merge commit `d6348b3094d68a991fffc22d646bcd6164315226`. Supersedes and absorbs PR #239 (above) with a server-authoritative boundary that holds regardless of client cache/version.

What it is: `supabase/migrations/20260812190000_server_authoritative_reminder_inserts.sql` adds a restrictive RLS policy (`tasks: reminders require server creation`) — authenticated clients can no longer directly `INSERT` a task with `type='reminder'`; every other task type they could already create remains unaffected. Server routes (service role, RLS-bypassing) remain the only path that can create a reminder. `api/_one-time-routing-contract.js` + `src/lib/one-time-automation-routing.ts`'s `buildOneTimeRoutingEvidence`/`validateOneTimeRoutingEvidence` add a signed, versioned routing-evidence contract (`destination`, `decision_source: 'fresh_user_transcript'`, `client_build`, `operation_id`) that `api/automations.js`'s POST handler validates before insert (409 on a rejected/missing/malformed contract), and `operation_id` doubles as an idempotency key. `one-time-automation-routing.ts`'s routing decision recognizes a "scheduled delegation" shape (recipient-shaped utterance + known recipient + a non-immediate `time_text`/`due_at`, and no explicit "remind me" phrasing) and routes it to `automation` rather than `reminder` even without the word "automation" in the utterance.

Production verification evidence (2026-08-13, independently verified via direct read-only Supabase queries against project `ggarvhgqzpooloacjgcj`): the RLS migration content matches the reported behavior (restrictive policy, `type <> 'reminder'` check, authenticated role only — a direct authenticated insert of `type='reminder'` would fail with Postgres `42501`, consistent with what was reported). For the real scheduled-delegation test (same production event as the PR #236 entry above): `automations` row `340eb0a1-d24d-4876-a795-b752ca3b93fb` exists (`cadence_type='once'`); the linked `automation_runs` row's `tasks` row is `type = 'delegation'` (not `'reminder'`), `assigned_to = 'Christopher'`. Directly queried every `tasks` row created for this owner in the surrounding hour (`22:00`–`23:00` UTC): no `type='reminder'` row exists tied to this event — independently confirming Sana did not and could not have received an owner reminder for this delegated task.

Protect: the `tasks: reminders require server creation` restrictive RLS policy, the routing-evidence contract validation in `api/automations.js` (including its `operation_id` idempotency behavior), and the scheduled-delegation routing branch in `one-time-automation-routing.ts`. Reopen only on a reproduced production regression.

### Post-owner-decision worker WhatsApp identity gap — CLOSED, PRODUCTION VERIFIED, PROTECTED (PR #243)

Discovered during PR #237's controlled production verification (task `f51a864c-5625-4c39-8a37-bd6ea0fc3489`, 2026-08-12). Separate from PR #237's own scope — does not reopen or change PR #237's CLOSED verdict above.

**Confirmed finding:** when the owner approves/rejects/custom-instructs a `substitute_review`/`uncertain_proof` decision, the resulting worker-facing WhatsApp message (e.g. "Approved. You can go ahead.") is written via `reserve_custom_instruction`/`reserve_rejected_alternative` (`supabase/migrations/20260710_quality_substitute_review.sql`, `20260712_approve_alternative_message_first.sql`). Their `INSERT INTO messages (...)` / `INSERT INTO whatsapp_deliveries (...)` column lists do not include `person_id` — confirmed directly in production: both the `messages` row and `whatsapp_deliveries` row for this exact event have `person_id = NULL`, even though the original task-assignment message to the same person correctly carried it. This makes that specific communication unreachable through person-based Communication History (`get_communication_history`'s Wave 1 `messages` query is `.eq("person_id", personId)` with no fallback).

Continuation of the Communication History identity-completeness objective (same tables, same consumer as PR #235/#237) — not a new workstream, and not a defect in either closed PR.

**Correction (2026-08-13): this was already fixed and merged — the OPEN status above was stale documentation, not a real gap.** PR #243, merge commit `2cef83ff7137b0b5494c807254598428f63b4501` ("feat: post-owner-decision worker WhatsApp identity continuity"), migration `20260812_worker_notification_person_id.sql`: both `reserve_custom_instruction` and `reserve_rejected_alternative` gain an optional `p_person_id` (default `NULL`, backward compatible — old 7-argument signatures explicitly dropped first to avoid a PostgREST overload ambiguity), threaded into both their `messages` and `whatsapp_deliveries` `INSERT`s. `task-confirm.js`'s `findAssigneePerson()` now also resolves the canonical `people.id`, reusing the exact same exact-match/scoped-to-`user_id`/unambiguous-only discipline as `resolveAssigneePersonId` (`api/_escalation-notify.js`, PR #237) — not a new identity algorithm; ambiguous or zero matches leave `person_id` NULL, never guessed, and never block the send. A one-time guarded, idempotent backfill covered the one production row that qualified deterministically. This closure was independently re-verified (this review, 2026-08-13) by reading the migration SQL directly (confirms `person_id` is in both `INSERT` column lists) and by re-querying the exact motivating production row directly: `messages` row `fc871e44-4f98-4aad-80cd-5c3662d22c94` (task `f51a864c-5625-4c39-8a37-bd6ea0fc3489`, "Approved. You can go ahead.") now has `person_id = 0a854693-b873-4a36-b187-dbb161bcd7d6` — no longer `NULL`, exactly reversing the confirmed finding above.

Protect: `p_person_id`'s backward-compatible default and its exact-match/unambiguous-only resolution discipline in both RPCs; do not guess an ambiguous or unmatched person. Reopen only on a reproduced production regression (a new post-owner-decision worker message with `person_id = NULL` despite an unambiguous, resolvable assignee).

### Communication History event timestamps — CLOSED, PRODUCTION VERIFIED, PROTECTED (PR #250)

Clarified requirement (2026-08-12): each Communication History entry (`get_communication_history`'s spoken/typed answer) must visibly show when it happened, including a useful date **and clock time**, using the correct account/user timezone — not just a date. Prior state (confirmed by code trace, `formatCommunicationHistoryAnswer` in `carson-communication-history.ts`): rendered a per-event date only, no time, formatted via the executing device's local timezone rather than the stored account timezone (`profiles.morning_brief_timezone`).

**Implemented** (PR #250, merge commit `077730dc478e18429968c971be1ae48c418313cf`; test-assertion follow-up `abc573d7f1cafeeae0a6e26185f29a678400c528`): `formatCommunicationHistoryAnswer` now renders both calendar date and clock time, resolved via a new `resolveCommunicationHistoryTimezone()` precedence chain — `profiles.morning_brief_timezone` when valid (authoritative) → `Intl.DateTimeFormat().resolvedOptions().timeZone` (browser/device) only when the stored value is missing/invalid, never as a silent substitute for a merely-failed fetch → a deterministic `UTC` fallback only if neither yields a usable value. Current-year year-omission is computed in that same resolved timezone, not device-local. Confined to `carson-communication-history.ts` + its test file; `buildCommunicationHistory` (event fetching/ordering/dedup/attribution), PR #235/#237/#243 person-id durability, and every other Universal Timestamp System display untouched. No schema change — every source column was already `timestamp with time zone`.

Discovered and fixed in the same window, as a genuinely separate defect: **PR #251** (`ff71fb92f9fb8d03749d6bcb4465336bd264718d`) — a deterministic pre-LLM fast-path (`resolveHostingOperationRecall`) was swallowing confirmation-*timing* questions ("When exactly did X's confirmation come in?") into a yes/no-only hosting-recall branch before they could ever reach `get_communication_history`. Fixed by excluding when/what-time/what-date questions from that branch; the protected `"Has Christopher confirmed?"` yes/no phrasing is unaffected.

**Production verification (2026-08-13), independently re-verified this review via direct Supabase queries and by exercising an exact, unmodified copy of the real merged `formatCommunicationHistoryAnswer` against real production data:**

- **Persisted timestamps are correct**: every event-source column (`staff_messages.received_at`/`responded_at`, `personal_contact_replies.created_at`, `messages.created_at`, `whatsapp_deliveries.{accepted,sent,delivered,read,failed}_at`, `staff_escalation_owner_decisions.created_at`/`answered_at`) is `timestamp with time zone`, confirmed directly against `information_schema.columns`.
- **Account timezone conversion is correct**: `profiles.morning_brief_timezone = 'Europe/Istanbul'` (UTC+3) for the tested account, confirmed directly.
- **UTC/local day-boundary behavior is correct**: task `c4bcf311-49df-4c71-9763-46ab5df358bb` ("Buy a black pen," Christopher) has five real events between `2026-08-12T21:13:35.965Z` and `2026-08-12T21:14:07Z` — all genuinely cross the UTC/local day boundary (Aug 12 UTC → Aug 13 local).
- **`formatCommunicationHistoryAnswer` generates the correct calendar date and local clock time**: running the exact, unmodified formatting logic against those five real rows with `timezone="Europe/Istanbul"` produces exclusively `Aug 13, 12:13 AM` (four events) and `Aug 13, 12:14 AM` (the `delivery_read` event) — proven directly, not inferred.
- **Type to Carson independently confirmed an exact match** on a separate event: the kitchen-readiness task's read receipt (`2026-08-13 00:50:55 UTC` → `03:50:55 Europe/Istanbul`) was returned by Carson as *"3:50 AM today"* — exact to the minute.
- **Talk to Carson's "12:10 AM" wording for the black-pen event was not generated by the formatter.** No persisted event anywhere in the surrounding 40-minute window resolves to 12:10 AM (confirmed directly against the database); the real tool output for every candidate event is 12:13 or 12:14 AM. This is model-layer verbal imprecision when the ElevenLabs voice model paraphrased an already-correct absolute timestamp — not a defect in this repository's code, and not further investigated at the minute level per the accepted evidence standard.

Protect: `resolveCommunicationHistoryTimezone`'s precedence order (stored → device → deterministic `UTC`, never a hardcoded location standing in for a failed fetch) and the year-in-timezone current-year check. Reopen only on a reproduced production regression in the formatter itself (not model-layer paraphrasing).

Scope note for the Universal Timestamp System's rule 7 below ("always display timestamps in the owner's local device timezone unless an explicitly approved product change says otherwise"): Communication History is exactly that explicitly-approved exception, and only for Communication History — no other V1A/V2A display (Type to Carson message times, Needs You, Waiting, To-do, Notes, Automations, History) changed timezone source in this work.

### Automation-runner Communication History identity/linkage gap — CLOSED, PRODUCTION VERIFIED, PROTECTED

Discovered during PR #250's own production verification (2026-08-13), using the pre-existing PR #236 test event. Separate from PR #250 — does not reopen or change PR #250's CLOSED verdict above; the formatter is proven correct independent of this gap.

**Confirmed finding:** automation task `c5a07eff-a624-4d03-8ea9-5c6bacb2a78b` (a Carson-created one-time automation delegation to Christopher) had a real, valid `whatsapp_deliveries` row (`ec6900b3-0edf-4c2c-a5c1-8e21619fe969`, `read_at = 2026-08-12 22:20:14 UTC`) — but `person_id = NULL`, `message_id = NULL`, and **zero `messages` rows exist for that task at all**. Tracing `buildCommunicationHistory`'s exact wave-2 filter (`person_id.eq` OR `message_id.in(wave-1 ids)` OR `task_id.in(wave-1-derived ids)`) against this data: none of the three branches can match, since nothing in wave 1 (`staff_messages`/`messages`) ever references this task. **The event was structurally unreachable from Christopher's Communication History even though its timestamp was real and valid.**

Root cause confirmed in `process-delegation-escalations.js`: both `processAutomation` (automation_delegation) and `processMessageAutomation` (automation_message) already resolve the canonical assignee/person via `resolvePersonById` before sending, but never threaded that id into the WhatsApp send payload — so `beginWhatsappDelivery`/`resolveDeliveryContext` in `_whatsapp-delivery.js` had no identity source to write, since these sends create no `messages` row.

**Fix (smallest complete change, 3 production files):**
- `process-delegation-escalations.js` — threads the already-resolved `assignee.id` / `person.id` into the `send-whatsapp-task` payload as `personId`. No second lookup, no name matching.
- `send-whatsapp-task.js` — accepts optional `personId` in the request body, threads it into `beginWhatsappDelivery`. Meta payload/template behavior unchanged.
- `_whatsapp-delivery.js` — `resolveDeliveryContext` now accepts an `explicitPersonId` alongside the existing messages/staff_messages-derived identity. **Identity conflict rule (fail closed, never guess):** explicit-only or derived-only → use it; both present and matching → use the shared value; both present and conflicting → `person_id` stays `null`, with a structured `console.warn` (source kinds only, never message content).

**Tests added (11 total across 4 files, all passing):** `api/_whatsapp-delivery.test.js` (explicit-only, matching, conflicting/fail-closed with no-content-leak assertion, full automation-runner call shape), `api/process-delegation-escalations.test.js` (personId threaded for both automation types, exactly one person lookup), `api/send-whatsapp-task.test.js` (personId threaded into the insert), `src/lib/carson-communication-history.test.ts` (an automation delivery with `person_id` and no `messages` row is reachable via `person_id` alone, through the existing `person_id.eq` branch — `buildCommunicationHistory` itself was not modified). Full battery run: combined 8-file/296-test cross-cut, `npm run test:carson-protected` (55 files, 1095 passed), `tsc -b --noEmit` clean, production build clean.

**Historical backfill (production, 2026-08-13, project `ggarvhgqzpooloacjgcj`):** read-only audit of `whatsapp_deliveries WHERE person_id IS NULL AND automation_run_id IS NOT NULL` found exactly 6 rows, all deterministically attributable via `automation_runs → automations.assignee_id → people.id` UUID joins under matching `user_id` ownership (no name matching, no ambiguity — Category A, zero Category B/C). Applied the guarded, idempotent one-time repair (`supabase/data-repairs/20260813_automation_delivery_person_id_backfill.sql`, precondition `person_id IS NULL`): exactly 6 rows updated, matching the audit exactly, including the historical PR #236 event (`ec6900b3-0edf-4c2c-a5c1-8e21619fe969` → Christopher). Re-run confirmed idempotent (0 remaining eligible rows).

Protect: the identity-conflict fail-closed rule in `resolveDeliveryContext` — never silently prefer explicit over derived identity or vice versa. Protect the backfill's guard conditions (`person_id IS NULL`, ownership-scoped UUID joins only) if this migration is ever referenced again.

**Live production verification (2026-08-13, PR #253 merge `24a32d76a03086b39597bc02a5fe691f63d39f31`, deployment `dpl_LkkkrWPddichdCZS4ZSH3FToLSWJ`, live from 19:17:30 UTC):** Sana created one real one-time delegation automation to Christopher through Talk to Carson ("automation history linkage production verification"). Verified read-only, independently:

- Automation `fd331452-2463-4152-8ac2-b87f5c529d2e` → exactly one `automation_runs` row (`a51cc1de-f474-46ef-b2ef-f695dfccfbf1`, `current_state = sent`) → exactly one `tasks` row (`c13c4c29-3710-48ca-afcf-160446013839`) → exactly one `whatsapp_deliveries` row (`f1ab4526-0e74-4a6b-8a5f-80e8ba9bfb68`). No duplicates at any stage.
- `whatsapp_deliveries.person_id = 0a854693-b873-4a36-b187-dbb161bcd7d6`, confirmed to be Christopher's canonical `people.id` under Sana's `user_id` — the primary proof this fix was live and correct at send time, not backfilled after the fact.
- `automation_run_id` on the delivery links to the exact run above; `messages` rows for this task: 0 (confirms no synthetic `messages` row was needed, as designed).
- Full normal lifecycle observed: accepted 19:45:04.912 → sent 19:45:06 → delivered 19:45:09 → read 19:45:23 (UTC). Rendered in the account's stored `profiles.morning_brief_timezone` (`Europe/Istanbul`, UTC+3): 10:45:23 PM — consistent with Carson's own spoken acknowledgment ("10:45 PM tonight").
- **Communication History reachability proved by exercising `buildCommunicationHistory`'s exact wave-1 → wave-2 filter logic** (read verbatim from `src/lib/carson-communication-history.ts`, not reimplemented or guessed) directly against production for Christopher: both the new delivery (`f1ab4526...`) and the historical PR #236 delivery (`ec6900b3...`) are present in the result set, the latter reachable *only* through the `person_id.eq` branch (its task has no `messages`/`staff_messages` row to derive a `task_id.in(...)` match from) — proving the fix, not an unrelated fallback path, is what makes it reachable.
- Historical PR #236 delivery (`ec6900b3-0edf-4c2c-a5c1-8e21619fe969`) re-checked: `person_id` now Christopher's canonical id; `read_at`, `sent_at`, `delivery_status`, `task_id`, and `automation_run_id` all unchanged from before the backfill (the backfill UPDATE statement's `SET` clause touches only the `person_id` column, so no other field could have changed) — no message content existed to alter (this path creates no `messages` row).
- Backfill safety re-confirmed structurally: the applied `UPDATE ... SET person_id = ...` cannot alter timestamps, delivery state, task state, automation state, or message content by construction, and a re-run against production returns 0 remaining eligible rows (idempotent).

**Definition of Done met:** new `automation_delegation` deliveries preserve canonical person identity — proved live in production (this verification), not just backfilled; new `automation_message` deliveries preserve canonical person identity — verified by the same code path and test coverage (`api/process-delegation-escalations.test.js`), not independently live-tested with a real message-type automation; Communication History retrieves automation-created events without a synthetic `messages` row; identity contradictions fail closed (tested); historical affected rows safely repaired (6/6, idempotent); focused/protected tests pass; production verification passes; this file updated.

### Documentation workflow safeguard

Documentation-only changes to this file (and other repo docs) must go through the normal branch → PR → required-checks → merge workflow, the same as code changes, unless an explicit repository exception exists. A prior direct-to-main documentation push (commit `7c32124`, 2026-08-12) bypassed the required `carson-protected-behaviors` check — no corrective action was required for it since it changed no runtime behavior, and it is not treated as precedent for future documentation changes.

### Production launch control — CLOSED, PRODUCTION VERIFIED, PROTECTED

Status: fixed and production verified on 2026-08-10.

Exact exposure: Supabase email/password signup was publicly enabled while email auto-confirm was on. The public client called `supabase.auth.signUp()` directly, so a successful request immediately returned an authenticated session and the existing signed-in route guard granted product access. A direct Auth API call bypassed any frontend-only hiding. No Stripe, checkout, paid-plan, invoice, payment, or customer-subscription implementation exists in this production codebase; `subscription` references are Supabase session listeners or web-push subscriptions, not paid subscriptions.

Smallest safe fix: production Supabase Auth now has **Allow new users to sign up** disabled (`disable_signup: true`). This is the enforcement boundary: it blocks new identities at the server before a user or session can be created, preserves every existing owner/test account, changes no data, and can be reopened with the same setting. The Auth screen also defaults to invite-only unless `VITE_PUBLIC_SIGNUP_ENABLED` is explicitly `true`; this is defense in depth and user-facing clarity, not the security boundary.

Production verification with a fresh unapproved identity:

- Direct `POST /auth/v1/signup` returned HTTP 422, `Signups not allowed for this instance`.
- Response contained no user and no session: no account activation and no product access.
- Immediate password sign-in for the same identity returned HTTP 400, `Invalid login credentials`, with no access token.
- No charge and no active paid subscription: the application has no billing/payment path in this deployment, and the blocked signup created no identity or session.
- Existing owner/approved accounts were not modified; disabling signup does not disable sign-in or revoke sessions. The unchanged sign-in path and full protected regression suite verify that existing-account authentication remains available.
- Direct API bypass fails at the Supabase Auth server, independently of the deployed frontend.

Regression protection: `ra7etbal-v2/src/routes/Auth.launch-control.test.tsx` renders both flag states and proves that closed signup hides the signup tab/form, shows the invite-only notice, and leaves sign-in available; it also proves that deliberately enabling the flag restores the signup controls. The closed state now removes the entire auth mode selector and shows sign-in only. Sana manually reverified owner sign-out/sign-in and confirmed that a fresh Jewel signup is rejected. The Supabase server-side signup block, users, sessions, subscriptions, billing, and sign-in implementation were not changed. Before reopening public registration, deliberately enable both the Supabase server setting and the Vercel client flag, then repeat the full signup/payment/access review. Do not replace the server setting with a hidden button or client-only allowlist.

**Historical note (corrected 2026-08-10 — this section previously read as an open, unmerged task; it was stale):** PR #93 (`agent/server-backed-banner-dismissal`), persisting completed-confirmation banner dismissal on `tasks.dismissed_at`, merged as `62010060306b30c0896379fc66c763eca8c0b1be` on 2026-07-28. Confirmed live: `dismissed_at` is a real column read/written throughout the current codebase (`src/stores/tasks.ts`, `src/components/home/ConfirmationNotices.tsx`, `src/types/task.ts`), and its migration (`20260729_add_dismissed_at_to_tasks.sql`) is present in the repo. Treat as merged and protected, not pending.

### Owner WhatsApp decision message quality — COMPLETE, MERGED, PROTECTED

Status: **corrected 2026-08-10 — previously read as "production verification pending"; that was stale.** Merged as PR #101 (`78755d25204a103bcb11484b67d767177dc5c80f`, "Keep owner WhatsApp decision requests concise and source-faithful"), 2026-07-28. `ra7etbal-v2/api/owner-whatsapp-decision-message-quality.test.js` (referenced below) is present in the repo and wired into `test:carson-protected`. Treat as merged and protected. The confirmed defect was that the classifier's broadly
reasoned `escalation_reason` was copied into the owner notification, allowing
irrelevant household context and hypothetical decisions into a simple staff
permission request.

The existing stored field is now contracted as a concise, source-faithful,
owner-ready decision sentence. New values are single-line and length-bounded;
the buttonless notifier passes owner-ready sentences through and retains the
legacy wrapper for historical stored wording and retries. Transport, Meta
templates, owner reply matching, app resolution, leases, acknowledgements,
retry behavior, and duplicate suppression are unchanged.

Permanent focused contract:
`ra7etbal-v2/api/owner-whatsapp-decision-message-quality.test.js`. It covers
simple purchases, the bouquet regression, connected substitutions, material
and non-material ownership context, ambiguity, genuine multi-part decisions,
irrelevant rules, purchase limits, invention prevention, Meta-safe
normalization, direct-reply wording, legacy retry wording, and task-link/button
exclusion. It runs automatically before the existing curated suite whenever
`npm run test:carson-protected` executes.

## Owner WhatsApp safe routing Slice 1

Status: deployed at `cdededee7006c2af4c614006863487d08f258cf0`; production migration applied; routing enabled only for Sana. A controlled reminder test exposed two contained defects: equivalent PostgreSQL/ISO `timestamptz` strings were compared literally after the deterministic task insert, and retry processing resent an already accepted failure acknowledgement. Production receipt `2be3086c-910e-4f7f-9dc9-c22588223c45` was contained with `execution_status=terminal_failed`, `next_retry_at=NULL`, and its orphan task deleted; the receipt `status` remains `failed` because the production status constraint does not allow `terminal_failed`.

The owner command boundary now fails closed for ambiguous and compound commands; quoted Meta context remains the only escalation-answer authority. Direct messages and tracked delegations are classified separately, owner references use the shared canonical normalizer, reminders resolve in `profiles.morning_brief_timezone` and schedule QStash only after a non-null `due_at` is persisted, delegations preserve deterministic task/message/confirmation IDs and schedule escalation, and retry exhaustion records a durable terminal failure without promising more retries. Migration deployment order and the 20260727 history mismatch are documented in `ra7etbal-v2/docs/OWNER_WHATSAPP_SAFE_ROUTING_DEPLOYMENT.md`.

Protect: receipt lease/claim tokens, deterministic idempotency, accepted-send/acknowledgement fences, exact quoted-context correlation, default-off `OWNER_WHATSAPP_ROUTING_USER_IDS`, and the prohibition on open-escalation-count inference. Before any activation: reconcile migration history, apply and verify migrations separately, deploy with the flag disabled, then enable one account only after command tests pass.

Resolved and superseded (verified 2026-07-28): PR #96 fixed canonical-instant
comparison, accepted-acknowledgement preservation, terminal retry exclusion, and
truthful reminder delivery observability. Merge
`fdd9b78495926e283d83824b725db01e3c6634c6` deployed as
`dpl_4v33EpiicEDs5pKUtbznoyRW58EB`; migration
`20260730_reminder_delivery_observability.sql` is present on production
Supabase project `ggarvhgqzpooloacjgcj`.

### Owner WhatsApp one-time reminder — production verified and protected

#### Owner WhatsApp due-time delivery — CLOSED, PRODUCTION VERIFIED, PROTECTED

Status (2026-08-11): the isolated implementation is ready for review but is not
yet merged, deployed, or capability-complete. It adds one `owner_reminder`
WhatsApp delivery lifecycle to the existing canonical reminder task, guarded by
a partial unique index on `whatsapp_deliveries.task_id`. Both the primary QStash
callback and the safety net use the same atomic claim before any Meta request.

The implementation reuses `buildRoutineMessagePayload` and the approved
`ra7etbal_routine_message` template. It resolves exactly one Boss recipient
inside the task's household, uses the owner's configured timezone with
`Europe/Istanbul` fallback, and records Meta acceptance only as `accepted`.
Push delivery fields and task completion truth are unchanged; staff reminder
delivery and staff routing are untouched. Focused tests, typecheck, production
build, and the full Carson protected suite pass. Do not mark this capability
complete until a controlled Sana-only production reminder proves one push and
one owner WhatsApp reminder with no duplicates. Final Master Plan/state
closeout remains pending that production evidence.

Pre-merge correction (2026-08-11): the safety-net task SELECT now explicitly
includes `type`, while retaining the database `type=eq.reminder` filter and the
sender's fail-closed `task.type === 'reminder'` validation. Its test fixture is
projected from the real SELECT and asserts the sender receives
`type: 'reminder'`. Removing `type` from the production SELECT was
mutation-tested and caused the regression test to fail as intended.

Durable-claim correction (2026-08-11): the claim now uses a normal PostgREST
insert with `return=representation`. Only HTTP 409/PostgreSQL `23505` naming
the exact `whatsapp_deliveries_owner_reminder_task_uidx` index is treated as a
lost claim; unrelated database failures remain failures. A genuine PostgreSQL
lifecycle test proves the first owner-reminder insert succeeds, a duplicate is
rejected by that exact partial index, another source type may reference the
same task, and a different task may have its own owner-reminder lifecycle.
The losing claimant never sends to Meta.

Status: production verified and permanently protected. Rollout remains Sana-only
(`645ddb96-6e09-4d91-b650-cbc75bac9a5d`); staff WhatsApp routing is unchanged.

Controlled production evidence (sent exactly once):

- Command: `Remind me at 7:03 PM today to check the owner WhatsApp acknowledgement.`
- Local acknowledgement: `Done — I created one reminder for Tuesday, 7:03 PM.`
- Canonical UTC `due_at`: `2026-07-28T16:03:00.000Z`
- Result: one correctly worded Ra7etBal notification was visible on Sana's
  iPhone at 7:03 PM Europe/Istanbul, with no duplicate acknowledgement and no
  duplicate iPhone notification.

The production ledger contains one inbound receipt, one reminder task, one
QStash message ID, one callback, and one send attempt per each of five distinct
active push endpoints. One service worker recorded
`service_worker_received`, `show_notification_attempted`, and
`show_notification_resolved`. Provider acceptance and service-worker display
attempts do **not** prove visible delivery. Without a supported
`notification_clicked` receipt, the task truthfully remains `pending` with
`reminder_delivery_status=delivery_unconfirmed`; it is never marked done merely
because a provider accepted the push.

Permanent contract:
`ra7etbal-v2/api/owner-whatsapp-reminder-golden-contract.test.js`, together with
its focused execution, routing, QStash, push, receipt, and service-worker tests,
runs in `npm run test:carson-protected` under deterministic `TZ=UTC`. The
always-on Carson pull-request workflow deliberately has no path filter, so
changes to the critical owner-classification, acknowledgement, task, QStash,
callback, push, service-worker, completion, reconciliation, and migration files
cannot bypass the protected gate. Phase D, staff routing, reminder correction
replacement, and banner dismissal remain unchanged and retain their existing
protected tests.

Stable baseline tag:
`ra7etbal-stable-owner-whatsapp-reminder-2026-07-28`. Its target is the final
merged protection commit for this contract (the exact remote target is verified
and reported after merge).

### Owner decision replies through WhatsApp — production verified and protected

Status: production verified and permanently protected on 2026-07-28. Rollout
remains Sana-only; Phase B staff escalation, Phase C Needs You visibility, the
Phase D app controls, staff routing, and the owner reminder contract are
unchanged.

Controlled production evidence (one owner reply, with no additional test
decision created):

- Christopher decision: `87b539e7-c0a3-4f1a-aa99-bbc20253a975`
- Original request: `I need Sana’s permission to test a new dessert plate today. This is only a harmless test and nothing will be served to guests. Please ask Sana yes or no.`
- Exact Sana reply: `Decision 87b539e7-c0a3-4f1a-aa99-bbc20253a975: Yes, but do not serve it to guests`
- Exact Sana acknowledgement: `Got it — I sent your answer to Christopher.`
- Receipt: `4ce34678-7177-4bf2-b925-52529672b7af`, completed once with
  `match_method=explicit_identifier`, `normalized_decision=custom_instruction`,
  no error, and no eligible retry
- Final decision state: `delivered_to_staff`; the exact owner reply is stored
  with `owner_reply_channel=whatsapp`
- Christopher transport ID:
  `wamid.HBgLMTIwMjU2OTEzNzcVAgARGBI3OTA5NEE0MkI2RDNFQjAxQ0MA`
- Sana acknowledgement transport ID:
  `wamid.HBgMOTA1MDEwNTg5NjE0FQIAERgSOTE1RDA0NzFGQTQ1RjAzREYwAA==`
- Answered at `2026-07-28T17:35:31.729086Z`; delivered to Christopher at
  `2026-07-28T17:35:33.434857Z`
- The production Needs You count changed from three to two. The resolved card
  cannot be resolved or delivered again through either the app or WhatsApp.

The permanent contract is
`ra7etbal-v2/api/owner-whatsapp-decision-golden-contract.test.js`. It protects
quoted-message matching, explicit identifiers, the single-recent-decision
fallback, ambiguity clarification, supported natural replies, exact-reply
audit storage, the shared Phase D resolution state machine, staff-delivery and
owner-acknowledgement fences, transport IDs, retry behavior, cross-household
isolation, and duplicate app/WhatsApp attempts. It and its direct routing and
Phase D dependencies run in `npm run test:carson-protected`; the contract also
locks the existing protected-file boundary.

Release PR: #98. Implementation commit:
`f01f47a02fd3eeca9e1e9f806e9f7134ff2a59ce`. The controlled test ran on READY
production deployment `dpl_7hYkwXyCzPAoAC2nqYx3riFpvMWK` against Supabase
project `ggarvhgqzpooloacjgcj`. The immutable final baseline tag is
`ra7etbal-stable-owner-whatsapp-decision-replies-2026-07-28`; release records
and the remote tag resolve the final merge commit without requiring a
self-referential documentation commit.

## Stable and protected

Do not modify these areas without a reproduced regression or explicit product decision.

### Reminder correction replaces (not duplicates) the reminder — Talk to Carson only

Status: implemented. Merged to `main`.

Confirmed production regression: Talk to Carson created a 9:00 AM reminder; the owner said it should be 5:00 PM instead; Carson said "changed to 5:00 PM"; production showed BOTH reminders active — the original 9:00 AM task and its QStash push job were never cancelled. Root cause: `create_reminder` is the only reminder tool exposed to the voice model, so a correction necessarily arrives as another `create_reminder` call with the same description, not a distinct "update" call — nothing recognized this as a correction of the reminder just created.

Fix, in `createReminder` (`src/components/home/ElevenLabsAgentWidget.tsx`): a new session-scoped ref (`lastCreatedReminderRef`) tracks the last created one-time reminder's id, normalized description, and creation timestamp. A new `create_reminder` call is treated as a correction only when BOTH the normalized description exactly matches AND the prior creation happened within `REMINDER_CORRECTION_WINDOW_MS` (2 minutes) — description match alone was flagged in independent review as able to silently delete an active reminder the owner intentionally repeated later for something unrelated; the time window is what distinguishes a live correction from that case. On a match: the corrected reminder is created FIRST (via the existing, unmodified `createReminderTask` — same QStash scheduling), and only after that succeeds is the original cancelled via the existing, unmodified `useTasksStore.getState().remove()` (the same function `control_task`'s delete action already uses, which deletes the task and cancels its QStash push). Carson only says "I've changed that reminder..." after both steps verifiably succeed; if creating the new one fails, the original is left untouched (never zero active reminders); if creating succeeds but cancelling the old one fails, the reply reports both are active and does not claim success.

This is a voice-only behavior change (the only confirmed regression, and typed's `create_reminder` is already fully blocked by the advisory-only boundary below) — Talk to Carson's tool registration and every other reminder/calendar/delegation behavior is unmodified.

Tests: `src/components/home/ElevenLabsAgentWidget.reminder-replacement.test.ts` (13 tests) — mutation-spot-checked. Independent review (`review:bug-hunter`): confirmed no stale-QStash-job path, confirmed the ref is correctly reassigned on every creation (so a second correction targets the second reminder, not the first), confirmed voice-only, confirmed the description-only false-positive risk (now closed by the time window above).

Protect: the create-then-cancel ordering, the time-window gate, and the truthful mixed-state failure reporting. Do not weaken the time window or the description match without a new reproduced regression.

### Type to Carson redirects execution requests immediately, never fabricates a completion promise

Status: implemented. Merged to `main`. Tightens "Type to Carson is advisory-only" below — see that entry for the underlying tool-blocking boundary, which is unchanged by this fix.

Two further confirmed production regressions on top of the advisory-only boundary: (1) typed "I have a dinner for 4 people at home tomorrow. Handle it." asked for the time, asked about dietary restrictions, built a full hosting proposal, asked for approval, and only THEN mentioned Talk to Carson — instead of redirecting immediately with no clarification, no proposal, no approval flow; (2) typed "I need to make the UI of Ra7etBal better and pay the electricity bill." got the reply "For the electricity bill, I'll have Grace handle it." — no `send_delegation` tool was ever called; the free-form typed model fabricated the claim entirely in its own reply text, which no tool-call block can catch.

Fix, in two parts:
- **Immediate redirect** (`src/components/home/ElevenLabsAgentWidget.tsx`, `sendTypedMessage`): the hosting-clarification and fresh-hosting-request branches now redirect immediately instead of calling `handleOperationalHostingTurn` (gated behind `TYPED_MODE_IS_ADVISORY_ONLY`, with the prior "planning allowed" code preserved as a dormant, fully reversible path). A new pure classifier, `classifyTypedExecutionRequest` (`src/lib/typed-advisory-redirect.ts`), runs as a final gate immediately before the free-form model would otherwise run, catching reminder/calendar requests (no dedicated detector existed for these at all) plus edge cases the existing staff-message/delegation detectors correctly return null for — a bodyless staff address ("Tell Grace.") and bare imperative actions ("Take care of it.", "Pay the electricity bill."). The staff-address check validates the addressed word against the real People list (not a capitalization heuristic — independent review confirmed a naive `[A-Z]` check is silently defeated by the case-insensitive `/i` flag the rest of the module needs).
- **Truthfulness guard** (`src/lib/carson-direct-tool-override.ts`, `sanitizeTypedAdvisoryReply`): applied only when `requestedChannel === "text"`, immediately after the existing, byte-for-byte unchanged `resolveSanitizedCarsonDisplayMessage` call. Replaces the entire reply with a generic truthful fallback when it matches one of the 7 exact banned phrasings from the bug report ("I'll have Grace handle it", "I'll take care of it", "I'll remind you", "I'll send it", "I'll assign it", "I'll add it", "it's done") — unless the reply already mentions Talk to Carson, since the confirmed bug reply never did.

Independent review (`review:bug-hunter`, run twice): first pass found the `[A-Z]`/`/i` case-insensitivity bug above (fixed) and two bare-verb false positives ("Book club is...", "Pay attention to..." — fixed by narrowing those two patterns); confirmed no path reaches `handleOperationalHostingTurn`/`executeProposedPlan`/`executeDirectMessageFastPath`/`executeDelegationFastPath` for typed while advisory-only; confirmed voice is structurally unaffected (`resolveSanitizedCarsonDisplayMessage`'s call site/arguments unchanged); confirmed full reversibility via `TYPED_MODE_IS_ADVISORY_ONLY`.

Tests: `src/lib/typed-advisory-redirect.test.ts` (23), `src/lib/carson-direct-tool-override.test.ts` (new `sanitizeTypedAdvisoryReply` cases), and a new describe block in `src/components/home/ElevenLabsAgentWidget.typed-mode.test.ts` — mutation-spot-checked.

Protect: the immediate-redirect ordering (before any clarification/proposal/dispatch), the truthfulness guard's typed-only gating, and the People-list validation for staff-address detection. Do not reintroduce a capitalization-only name heuristic.

### Type to Carson is advisory-only — Talk to Carson remains the execution channel

Status: implemented. Merged to `main`. Deployment status and exact production evidence recorded at completion of this task below (see delivery notes at the end of this task's work, or the final task report).

Product decision (2026-07-25): Type to Carson may answer questions, help plan, accept brain dumps, draft content and messages, research information, and review existing information — it may help prepare an action before the user performs it through Talk to Carson. It must never create or claim a reminder, recurring reminder, push notification, calendar event/update/delete, staff WhatsApp message, hosting plan execution/approval, delegation/assignment, or any other task/operation state change. Talk to Carson (voice) is completely unchanged and remains the only execution channel for all of the above.

**Enforcement is code-level, not prompt-level** (`src/components/home/ElevenLabsAgentWidget.tsx`):
- A single constant, `TYPED_MODE_IS_ADVISORY_ONLY` (currently `true`), gates every new branch below. Flipping it to `false` fully restores prior typed execution behavior — every gated branch is additive (`if (...) {...} else { <original code, untouched> }` or an early return before the original code), so this is a one-line, fully reversible rollback if the product decision changes.
- `guardCurrentToolInvocation` — the single function every one of the 17 registered ElevenLabs clientTools calls first, for both channels — now returns a truthful advisory string for 16 of the 17 typed tool calls (`execute_instruction`, `send_followup`, `send_delegation`, `send_direct_whatsapp_message`, `create_reminder`, `create_automation`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event`, `create_todo`, `complete_todo`, `control_task`, `act_on_note`, `save_note`, `save_city`, `save_instruction`) before the real executor is ever called. `get_calendar_events` (read-only) is the sole, deliberate exclusion — typed research/planning can still check the calendar. Voice returns via the pre-existing, untouched `guardCurrentVoiceCapture(toolName)` on the very first line, structurally before this new check — voice cannot reach it.
- `sendTypedMessage` (the typed-only dispatch handler, entirely separate from the ElevenLabs model/tool path) has three new gated branches, each leaving the real executor unreachable rather than intercepting its result: a pending hosting plan's "confirm" decision is answered advisorily instead of calling `handlePendingPlanTurn` (the plan itself is left pending/untouched so Talk to Carson can still execute it — `executeProposedPlan`'s existing idempotency key prevents any theoretical double-execution regardless); a message matching `parseSimpleDirectMessage` is answered advisorily instead of calling `executeDirectMessageFastPath`; a message matching the pure parser `parseDelegationFastPath` (the same parser `executeDelegationFastPath` uses internally, so there is no separately-maintained matcher to drift out of sync) is answered advisorily instead of calling `executeDelegationFastPath`. Hosting **planning** (`handleOperationalHostingTurn` — building/persisting a draft or proposal, no send) is deliberately left unconditional in both its call sites, since planning must still work for typed.
- `channelInstructions` for the text channel gains one additive prompt string, `CARSON_TYPED_ADVISORY_POLICY` ("...never say or imply that an action was completed"), reinforcing but never substituting for the code-level block. Voice's instruction array is untouched.
- `src/components/home/CarsonTypedChat.tsx` empty-state copy updated from text that named now-false capabilities ("create a reminder, delegate, or manage a To-do") to "Type for questions and planning."

**Independent review** (separate agent, `review:bug-hunter`): no critical/high/medium findings. Confirmed: all 17 clientTools cross-checked against the blocked-tool map (16 blocked, 1 deliberate read-only exclusion); no other Supabase-write or WhatsApp-send path exists inside `sendTypedMessage`; voice's guard, tool executors, and instruction array are structurally unreachable by the new typed-only code and byte-for-byte unchanged; every gated branch is additive/reversible; the hosting-plan idempotency key (pre-existing, shared by both channels) prevents duplicate execution even in a hypothetical bypass. One low-priority product note, not a bug: blocking `save_instruction` (a lower-stakes preference-memory write, e.g. "remember I prefer tea not coffee") may be more conservative than necessary — kept blocked here as the correct literal reading of "any other state-changing tool"; revisit only on explicit product decision.

**Tests** (`src/components/home/ElevenLabsAgentWidget.typed-mode.test.ts`, part of `npm run test:carson-protected`): new `describe("Type to Carson — advisory-only, Talk to Carson unchanged")` — proves the shared tool guard blocks every required tool unconditionally before voice's own guard could ever apply; proves reminder/recurring-reminder/calendar/staff-message requests cannot reach their real executors (including that `createReminder` — which owns all push/automation scheduling — is never invoked); proves hosting planning stays unconditional while approval/execution is blocked with the plan left untouched; proves no advisory string claims a completed action; proves ordinary typed questions/planning/drafting still reach the free-form model unchanged; proves typed-history reconciliation is untouched by this change; proves Talk to Carson's guard ordering and executor wiring are unaffected; proves the updated entry copy. Mutation-spot-checked (temporarily disabled the new guard, confirmed the relevant tests fail, restored).

Protect: the code-level boundary above. Do not let it degrade into a prompt-only restriction. Do not remove the reversibility (the `TYPED_MODE_IS_ADVISORY_ONLY`-gated `if/else` structure). Reopen only on a reproduced production regression or an explicit product decision to restore typed execution.

### Verified hosting loop + typed-history reconciliation — LOCKED, PRODUCTION VERIFIED

Status: COMPLETED. PRODUCTION VERIFIED at commit `6c764873edbd26d5490b6a1408a207a50eacd8ae` (asset `assets/index-3DokSTsX.js`) on `https://www.ra7etbal.com`. Regression protection locked 2026-07-25 (test-only change, no runtime behavior touched).

Verified end-to-end flow (`src/lib/ops-intelligence.ts`, the canonical hosting engine): "I have afternoon tea at home tomorrow. Handle it." routes to the hosting engine (never ordinary staff delegation); Carson asks one combined clarification for time, guest count, and dietary restrictions; a single natural reply ("4:00pm for 6 people, no garlic", "4pm, 6 guests and no garlic", "4pm. 6 guests and no shellfish", "16:00, 8 people, allergic to peanuts") parses into clean independent fields — the dietary value never absorbs guest count, "guests"/"people", time, or connector fragments; Carson presents one complete proposal with correct worker responsibilities (Christopher: food/drinks; Nasira: setup/table/presentation; Grace/Bahan: coordination) and exactly one approval question; one "Yes" executes the one canonical stored operation exactly once (idempotent — a duplicate "Yes" sends nothing more); delivery results are truthful per recipient (a missing phone number is reported as NOT messaged, never implied as sent to everyone); "What did you ask Christopher?" is answered from the stored operation with no new WhatsApp send and no new operation created.

Typed-history reconciliation (`reconcileTypedHistory` in `src/components/home/ElevenLabsAgentWidget.tsx`): one shared in-flight promise (concurrent callers await the same promise, never issue duplicate loads); one monotonic request-generation guard so a stale response can never overwrite newer history; optimistic rows are matched and replaced by persisted rows on both server id and `client_message_id`; the merged transcript sorts deterministically by `created_at` with a stable `id` tie-breaker; reconciliation runs on auth restoration (with `markUnansweredTypedMessagesInterrupted`), on Carson-sheet open, and on window focus/`visibilitychange` — never on a bare re-render. Closing and reopening Carson preserves the newest conversation with no greeting when persisted history exists and no browser refresh required.

Regression protection added (test-only, no runtime file changed):
- `src/lib/ops-intelligence.test.ts` — new `describe("production baseline — verified afternoon-tea hosting loop")`: exact-phrase routing, the exact combined-clarification wording from the verified flow, one-proposal/worker-responsibility shape, truthful missing-phone delivery reporting, and two new `resolveHostingOperationRecall` behavioral tests (with a minimal chainable Supabase query stub) proving recall reads the stored operation and never calls `savePending`/`deliverTaskMessage`/`sendDirectMessageRecord`, and never issues an `insert`/`update`/`delete` against `carson_pending_operations` or `tasks`.
- `src/components/home/ElevenLabsAgentWidget.typed-mode.test.ts` — new source-shape assertions locking the shared in-flight promise, the stale-request guard, the persisted-replaces-optimistic id/client-id matching, the stable sort tie-breaker, the auth-restoration reset+reconcile, and the sheet-open reconciliation trigger.

Full pre-existing coverage (already extensive, confirmed still green, not modified): `src/lib/ops-intelligence.test.ts` (196 tests before this task, hosting recognition/clarification/proposal/approval/idempotency/worker-message/delivery-truthfulness/recall) and `src/components/home/ElevenLabsAgentWidget.typed-mode.test.ts` (typed dispatch, hosting gate wiring, typed-history restore-before-greeting). `npm run test:carson-protected` (13 files, protected-neighbor behavior) passes unchanged.

Known pre-existing gap (discovered, not caused by this task, not fixed — out of scope per this task's instructions): `src/components/home/ElevenLabsAgentWidget.todo-tools.test.ts` → `"uses the same shared planner and execution path as typed Carson"` fails on `main`/this branch's HEAD before this task's changes (confirmed via `git stash`) — it asserts the literal strings `"how many guests are coming"` and `"anything I should avoid serving"` exist directly in `ElevenLabsAgentWidget.tsx`, but those strings are generated inside `ops-intelligence.ts`'s `evaluateHostingPlanningGate` and are not hardcoded in the widget after the shared-engine refactor. Not part of `test:carson-protected`. Needs its own scoped fix — do not fold into future hosting work without a separate task.

Protect: everything above. Do not reintroduce a per-channel hosting parser, a second typed-history loader, or a second reconciliation path. Reopen only on a reproduced production regression against the verified behavior above.

### Hosting plan integrity guards (Guard C, Guard D) + verified multi-person dinner loop — LOCKED, PRODUCTION VERIFIED

Status: implemented and merged to `main` across three PRs, then locked with regression tests (this task, test-only, no runtime file changed).

Confirmed production incident (voice): Carson spoke a two-recipient hosting proposal (dinner, Christopher + Grace) without ever calling `execute_instruction` to persist it. The owner's approval reply ("Yes, and please coordinate the table setup...", later reproduced again as "Yes, send both.") didn't match the exact-match confirmation regex (`CONFIRMATION_RE` — "both" isn't covered by its own "send" alternative), so with no active plan the whole reply fell through to `handleOperationalHostingTurn` in `executeInstruction` and was misread as a brand-new hosting request — producing an orphaned clarification for one recipient while the other's clause got picked up by the ordinary single-recipient delegation path. Carson then claimed both recipients received instructions — false. Separately, even when a real persisted plan DID execute or get cancelled, `lastDirectToolSuccessRef` was never populated for that branch, so Carson's own spoken reply for that turn was never checked against the real tool outcome.

Three merged fixes, all in `src/lib/ops-intelligence.ts` / `src/components/home/ElevenLabsAgentWidget.tsx`:
- **Guard C** (PR #68, commit `4f4b4c8`): `hasLeadingConfirmationLanguage()` detects a reply that opens with confirmation language but keeps talking ("Yes, and...", "Okay, also..."). When there is no active plan (`!activePlan && !activeWeekPlan`), `executeInstruction` returns "I don't have a saved plan to confirm. Please tell me the hosting plan again." instead of routing the reply into `handleOperationalHostingTurn` as a fresh request. Placed after the pre-existing exact-match confirmation/rejection guard, before the fresh-request hosting turn call.
- **Guard D** (PR #69, commit `3f11f28`): the `activePlan` `"executed"`/`"cancelled"` branches in `executeInstruction` now populate `lastDirectToolSuccessRef.current` with the real `turn.summary` before returning it, mirroring the adjacent, already-correct Weekly Planning confirm branch — so a fabricated spoken claim can no longer diverge from what `execute_instruction` actually did.
- **Guard C regex widening** (PR #70, commit `0b104f6`): reproduced live again with "Yes, send both." — "send" wasn't in Guard C's continuation-word list (`and|also|please|then`), so this exact phrasing slipped past the guard. Added `send` to the continuation-word list.

Subsequent verified production retest (dinner for four, tomorrow, at home, 8:00 PM, no shellfish): Christopher received the food instruction; Grace received the coordination instruction; Nasira was assigned but not reached because her phone number was missing on file — Carson reported this truthfully and never claimed she was contacted; no duplicate execution occurred on repeated approval.

Regression protection added (test-only, no runtime file changed):
- `src/lib/ops-intelligence.test.ts` — new `describe("production baseline — verified dinner hosting loop (Christopher, Grace; missing Nasira number)")`: exact-phrase routing for the dinner trigger, the exact time+dietary-only combined clarification (guest count already known), clean field parsing, correct per-recipient role assignment (Christopher food, Nasira setup, Grace coordination) with one approval question, truthful missing-phone delivery (Christopher and Grace each delivered exactly once, Nasira's attempt made and truthfully reported as not messaged, never implied as contacted), idempotent no-duplicate-send on a repeated approval, and the exact reproduced "Yes, send both." phrasing protected via `hasLeadingConfirmationLanguage`.
- `src/components/home/ElevenLabsAgentWidget.hosting-plan-integrity.test.ts` (pre-existing from PRs #68/#69, confirmed still green, not modified): Guard C placement/scope (9 tests) and Guard D ref-population (4 of those 9 tests).

Full pre-existing coverage confirmed still green, not modified: `src/lib/ops-intelligence.test.ts` (216 tests total after this task), `src/components/home/ElevenLabsAgentWidget.typed-mode.test.ts` (54 tests — hosting recognition, clarification parsing, one approval, recall, reopen, typed synchronization), `src/components/home/ElevenLabsAgentWidget.weekly-planning.test.ts` (13 tests). `npm run test:carson-protected` (13 files) passes unchanged.

Protect: Guard C's placement (after the exact-match confirmation guard, before the fresh-request `handleOperationalHostingTurn` call) and its `!activePlan && !activeWeekPlan` condition; Guard D's ref-population in both the `"executed"` and `"cancelled"` branches; the deterministic missing-phone truthful-delivery behavior in `executeProposedPlan`/`buildDeterministicGuestPreparationTasks`. Do not weaken Guard C's continuation-word list without a reproduced regression showing a specific new phrasing. Reopen only on a reproduced production regression against the verified behavior above.

### Reminder day-only clarification, weekday parsing, and creation-time display (PRs #72, #73, #74) — LOCKED

Status: implemented and merged across PRs #72–#74, locked with regression tests (this task, test-only, no runtime file changed).

Verified behavior: "I must pay the electricity bill Monday." asks for the missing time (`parsed.dayOnly`) and creates nothing; a time-only follow-up ("5:00 PM") is combined with the previously named Monday, never `now` (`pendingReminderTimeClarificationRef`); an explicit single-turn phrase ("Monday at 5:00 PM", "next Monday at 5:00 PM", "Monday at 17:00", "Monday at 5") resolves and creates immediately with no clarification (`src/lib/parse-voice-time.ts`'s weekday branch, `"next"` optional, generic-branch clock grammar reused). Reminder cards show both the due date and a `created_at`-derived "Created today at ..." / "Created \<date\> at ..." line (`formatReminderCreatedTime`, `src/lib/reminder-time.ts`), pure display over an already-stored value with no import of Supabase, the tasks store, or `parseVoiceTime`.

Regression protection added (test-only, no runtime file changed): a new widget-level test proving the explicit-phrase path skips both the dayOnly-ask branch and the pending-clarification merge, creating exactly one reminder (`ElevenLabsAgentWidget.reminder-replacement.test.ts`); a new `reminder-time.test.ts` test proving `reminder-time.ts` has no imports at all, so display formatting cannot read or write scheduling data. All four supported weekday+time formats were already covered by `parse-voice-time.test.ts` (PR #73).

Protect: `parsed.dayOnly` gating create_reminder's ask-vs-create decision; `pendingReminderTimeClarificationRef`'s day-preserving merge; the weekday regex's optional `"next"` and shared clock grammar; `reminder-time.ts` staying import-free. Reopen only on a reproduced production regression.

### Reminder Lock — protected-gate promotion (branch `test/reminder-lock-protected-gate`) — LOCKED

Status: test-only stabilization, no runtime file changed. Maps 10 protected one-off-reminder behaviors (clear-creation, day-only ask + day preservation, follow-up completes the same request, correction replaces without duplicating, bare-weekday parsing, stored-vs-displayed due time agreement, creation timestamp integrity, scheduling-failure truthfulness, and structural separation from the recurring-automation runner) to existing or newly added tests. Existing coverage (unchanged): `ElevenLabsAgentWidget.reminder-replacement.test.ts`, `parse-voice-time.test.ts`, `reminder-time.test.ts`, `reminders.test.ts`, `canonical-paths.test.ts`.

Gap-fill added this task: `reminder-time.test.ts` — `formatReminderDue` round-tripped against `parseVoiceTime` output, proving no stored-vs-displayed drift. `reminders.test.ts` — proves `createReminderTask` never sets `created_at` on the outgoing draft and returns it unaltered. `api/qstash-reminder.test.js` — new `describe("qstash-reminder default handler — 'schedule' action")`: a QStash publish failure returns `success:false` and never persists a `qstash_message_id` (mutation-spot-checked: inverted the `!response.ok` check, confirmed the success-path test fails with 500 instead of 200, reverted, confirmed green again). `src/lib/qstash-reminder.test.ts` (new file) — proves the browser-side `scheduleReminderPush`/`cancelReminderPush`/`rescheduleReminderPush` fire-and-log contract never throws on API or network failure. `canonical-paths.test.ts` — new test proving the recurring-automation runner (`api/process-delegation-escalations.js`'s `runAutomationsCore`/`processAutomation`) never imports or calls `createReminderTask`, using its own local `createTask()` REST helper instead.

Protect: `formatReminderDue`'s direct `new Date(value)` read with no re-derivation; `createReminderTask` never touching `created_at`; the qstash-reminder handler's `schedule` action never persisting a message ID on a failed/incomplete QStash publish; the recurring runner staying structurally separate from `createReminderTask`. Files to add to `package.json`'s `test:carson-protected` script (not edited here — applied once during integration): `src/lib/reminder-time.test.ts`, `src/lib/reminders.test.ts`, `src/lib/qstash-reminder.test.ts`, `src/lib/canonical-paths.test.ts`, `api/qstash-reminder.test.js`, `src/components/home/ElevenLabsAgentWidget.reminder-replacement.test.ts`, `src/lib/parse-voice-time.test.ts`. Reopen only on a reproduced production regression.

### Workstream 1 — canonical inbound evidence correlation recovery — FORMALLY CLOSED, PRODUCTION VERIFIED

Status: FORMALLY CLOSED. Merged via PR #180/#181 (`fix/canonical-inbound-evidence`).

Production verification proved that ambiguous, unquoted staff evidence fails closed — without task/thread binding, attachment, confirmation, Quality Intelligence execution, or a task transition — while a genuine WhatsApp Reply context binds the resent evidence to the exact originating task, persists its media exactly once, creates exactly one attachment, runs Quality Intelligence exactly once, and enters the existing `substitute_review` pipeline with no duplicate side effects.

Protect: unquoted staff evidence continuing to fail closed rather than guessing a task; WhatsApp Reply context remaining the sole correlation authority for resent evidence; single-attachment/single-QI-execution idempotency on resend. Reopen only on a reproduced production regression.

### Workstream 2 — recipient-bound owner decisions — FORMALLY CLOSED, PRODUCTION VERIFIED

Status: FORMALLY CLOSED. Final production deployment SHA `717251b78252c7c5b12c4cb0f41f87ff633f19e4` (PR #184, `fix/recipient-bound-owner-decisions`, following PR #182/#183 in the same series).

Production verification proved: a successful-delivery-state allowlist for quoted owner-review correlation (`SUCCESSFUL_OWNER_DELIVERY_STATUSES` = `accepted`/`sent`/`delivered`/`read`, previously only `accepted`, in `ra7etbal-v2/api/_owner-whatsapp-routing.js`'s `findQuotedEscalation`); exact-WAMID + recipient-phone + business-number-id binding on that same lookup, so a quoted reply from the wrong owner phone or a different business number fails closed; database-persisted first-write-winner semantics on the owner's actual decision, via the atomic `claim_escalation_answer_delivery` lease in `ra7etbal-v2/api/task-confirm.js` (`resolveAndDeliverEscalationAnswer`) — the losing side of a race always reports the persisted winning decision and never sends a duplicate WhatsApp message; a new atomic retry/reconciliation lease for owner-review notifications (`ra7etbal-v2/supabase/migrations/20260806_task_review_owner_notification_lease.sql`) that fails closed to `reconciliation_required` on an expired, outcome-unknown send rather than silently retrying; a new append-only `whatsapp_inbound_evidence` table (`ra7etbal-v2/supabase/migrations/20260806_owner_inbound_observability.sql`) that persists only WAMID, context ids, sender, business-number, and receive-timestamp — no message body, no raw webhook payload — enforced immutable via a `BEFORE UPDATE OR DELETE` trigger, with first-write-wins conflict detection on `(business_number_id, inbound_meta_message_id)`; and a self-guarded, idempotent, one-off historical data repair for the Drinking Glass substitute-review task (`ra7etbal-v2/supabase/data-repairs/20260806_glass_owner_review_deliveries.sql`).

The remaining staff-facing wording defect — an owner-approval message that reached the correct recipient but exposed internal Quality Intelligence reasoning instead of plain operational language — is deferred to Workstream 3. It does not invalidate Workstream 2: the decision itself was correctly bound, delivered once, and recorded.

Regression protection: `ra7etbal-v2/api/_owner-whatsapp-routing.test.js` (delivery-state allowlist positive/negative cases, recipient-binding and business-number-binding fail-closed cases), `ra7etbal-v2/api/_whatsapp-inbound-observability.test.js` and `whatsapp-inbound-observability-migration.test.js` (exact field allowlist, explicit negative assertion against leaking message text), `ra7etbal-v2/api/task-based-escalation-owner-decisions.test.js` (notification-lease claim/concurrency/reconciliation cases), `ra7etbal-v2/api/task-confirm.test.js` (claim-lease race-loser idempotency, plus a new test proving first-write-wins at the `answer_escalation_owner_decision` RPC itself — a losing caller's own submitted decision is discarded in favor of the persisted winner), `ra7etbal-v2/api/recipient-bound-owner-decisions.test.js`, `task-owner-whatsapp-substitute-review.test.js`, and `task-review-proof-photo-notification.test.js`. All of the above are now included in `npm run test:carson-protected` (`ra7etbal-v2/package.json`) — six of these files were merged with WS2 but omitted from the protected gate until this baseline-hardening pass; they are gated now.

**Workstream 2 Regression Hardening** — PR #185 (`chore/ws2-baseline-hardening`, merge commit `eda6ef1e786bc67b95a4b986d2bc25b1e96abd57`), merged 2026-08-06, all checks green (CodeRabbit, both Vercel previews, `carson-protected-behaviors`). This is regression hardening only — it is not part of the Workstream 2 implementation, which was already complete and production-verified at PR #184 (SHA `717251b7`) before this PR existed. PR #185 changed no runtime behavior; it added the missing concurrent-write-race test above and closed the CI-gate gap so `npm run test:carson-protected` actually covers what this baseline freezes. Do not record this PR as "Workstream 2 completion" — the completion event is PR #184's production verification; PR #185 only increases confidence that future changes cannot regress it.

Known gap (discovered during baseline review, deliberately left unfixed): business-number-id binding was added to the new `notifyOwnerOfTaskReview` delivery path but not to the older, general `notifyOwnerOfEscalation` (`staff_escalation`) path — `ra7etbal-v2/api/_escalation-notify.js`'s `notifyOwnerOfEscalation` never sets `owner_phone_number_id` in delivery metadata, so `findQuotedEscalation`'s business-number check silently no-ops for that sibling path only. This is a runtime behavior change, not a protection gap — it requires its own design review and production verification before it may be touched. Do not fold into any future work without a separate, explicitly approved task.

Protect: the delivery-state allowlist and its fail-closed negative cases; exact-WAMID + recipient + business-number binding in `findQuotedEscalation`; first-write-winner semantics in `claim_escalation_answer_delivery` and `answer_escalation_owner_decision`; the inbound-evidence field allowlist and its immutability trigger; the task-review notification lease's fail-closed reconciliation behavior; the Drinking Glass data repair's idempotency guards. Reopen only on a reproduced production regression against the verified behavior above.

**Workstream 2 Frozen Baseline: PERMANENT as of 2026-08-06.** Everything verified above is locked. Workstream 3 begins next, design/planning only.

### Workstream 3 — canonical staff-facing communication — FORMALLY CLOSED, PRODUCTION VERIFIED

Status: FORMALLY CLOSED. Final production deployment SHA `5d10be85b17250c3a6bb6ac2ac1dbc5c3ccc57c5` (PR #187, `feat/ws3-staff-communication`, merged 2026-08-06).

Root cause closed: `uncertain_proof`/`correction_limit` owner decisions fell through to a "quote genuine staff words" builder whose safety assumption was silently violated by `_owner-whatsapp-routing.js`'s `fetchTaskDecisionContext`, which synthesizes that "quoted" text from `task.quality_review_note` for task-based escalations. `substitute_review` already had its own sanitizing builder; the other two review types didn't.

Fix: `ra7etbal-v2/api/_staff-decision-message.js`'s `buildCanonicalStaffDecisionMessage({decision, instructionText, confirmationUrl})` — a pure function with no parameter capable of carrying Quality Intelligence reasoning, a review note, or any synthesized context. Wired into both delivery pipelines (`handleOwnerDecision` / Alternative Review UI, and `resolveAndDeliverEscalationAnswer` / WhatsApp quoted-reply) for every task-based decision — one canonical pipeline, not two. Canonical copy: approved → `"Approved. You can go ahead."`; rejected → `"Please wait. The owner did not approve this. You will receive further instructions shortly."`; custom → `"From the owner: {exact owner text}"`. Confirmation link included unconditionally for task-based decisions — no per-decision suppression.

Deliberately not touched, confirmed by diff review: Workstream 2 routing, correlation, observability, persistence, RPCs, leases, first-write-winner, business-number validation.

Production verification (fixture 1, task `f0a594dc-5964-47c6-9ce3-d0e26b5991a6`, "buy Coca-Cola Zero" with no fallback clause, forcing a genuine `substitute_review`): owner approved via the Alternative Review UI on the PR #187 preview deployment (`dpl_6DnxcFg4NVrmNZLakyKXMy4SnyPn`). Confirmed via production runtime logs and `whatsapp_deliveries` metadata fingerprint (`{decision:'approved_alternative', send_mode:'direct_message'}`, unique to `handleOwnerDecision`) that: the canonical builder executed; the correct code path executed; the generated message was exactly `"Approved. You can go ahead."`; no Quality Intelligence reasoning, review note, or synthesized context reached the output; no legacy formatter (`buildApprovalMessageText`/`buildRejectionMessageText`/the old `buildSubstituteDecisionMessageForStaff`) generated the outgoing text — those were removed by this PR. Fixtures 2 (`uncertain_proof`) and 3 (custom instruction) were not run live; closed instead on fixture 1's live evidence plus `api/staff-decision-golden-contract.test.js`'s exhaustive automated coverage of exactly those cases (mutation-style: a deliberately egregious `quality_review_note` proven absent from the outbound message for every review type and decision type) — an explicit, agreed substitution for live verification, not an oversight.

Regression protection: `ra7etbal-v2/api/_staff-decision-message.test.js` (exact canonical copy per decision type, mutation-style leak proof against every parameter the function accepts), `ra7etbal-v2/api/staff-decision-golden-contract.test.js` (closes the confirmed blind spot — `uncertain_proof`/`correction_limit` had zero prior coverage through `resolveAndDeliverEscalationAnswer`; cross-pipeline parity; Pipeline A mutation test), plus updated assertions in `task-owner-whatsapp-substitute-review.test.js`, `task-confirm.test.js`, and `alternative-review-golden-contract.test.js`. All of the above were included in `npm run test:carson-protected` from this PR's first commit — no follow-up hardening PR was needed the way WS2 needed PR #185, since the golden-contract suite was written alongside the implementation rather than discovered missing afterward.

**Separate reliability issue found during production verification, explicitly out of scope for this workstream:** the fixture-1 approval message was Meta-accepted (200 OK, wamid issued) then rejected by Meta's own delivery pipeline via an async status callback — `"In order to maintain a healthy ecosystem engagement, the message failed to be delivered."` on template `ra7etbal_routine_message`. Confirmed via `whatsapp_deliveries` history: this exact failure has recurred **8 times on this account since 2026-07-15**, three weeks before PR #187 existed — it is not caused by, and was not introduced by, this workstream. Because the resulting approval message never reached the worker, and no retry/reconciliation exists for staff-facing sends (unlike Workstream 2's owner-notification lease, which does have this), the worker completed the task via the stale confirmation link from the original 12:26 delegation message instead — a different, pre-existing, generic code path (`Confirm.tsx`) unrelated to the owner-decision flow. Full forensic trace preserved in session history. **Do not fold a fix for this into Workstream 3 — see Workstream 5 — Staff-facing Outbound Delivery Reliability, below.**

Protect: the canonical builder's closed input surface (decision/instructionText/confirmationUrl only — no QI/review-note parameter); both pipelines routing every task-based decision through it; the unconditional confirmation-link rule. Reopen only on a reproduced production regression against the verified behavior above.

**Workstream 3 Frozen Baseline: PERMANENT as of 2026-08-06.**

### Workstream 5 — Staff-facing Outbound Delivery Reliability — CLOSED / IMPLEMENTED / DEPLOYED / REGRESSION VERIFIED

Status (2026-08-14):
- Implementation: COMPLETE
- Tests: VERIFIED
- Production deployment: VERIFIED
- Smoke verification: VERIFIED
- Functional production verification: not organically exercised — see qualification below (not a blocker)

**Reconciliation (2026-08-14):** re-verified `notifyOwnerOfDirectMessageDeliveryFailure` (`ra7etbal-v2/api/whatsapp-webhook.js`) and the `staff_delivery_failed` push variant (`ra7etbal-v2/api/task-confirm.js`) are unchanged on `main` since the PR #191 merge; regression tests (`api/whatsapp-webhook.test.js`, `api/task-confirm.test.js`) remain part of `npm run test:carson-protected` and green. Traced the exact runtime mechanics: `updateWhatsappDeliveryStatus` (the function this handler is wired into) looks a delivery up by `meta_message_id` and only ever runs from Meta's asynchronous status-webhook callback — it is structurally unreachable from a synchronous send-time API rejection (those are written directly by `markWhatsappDeliveryFailed()` in `send-whatsapp-task.js`, a separate code path Workstream 5 does not touch). Of all historical `source_type='message'` failures, only the async ones (`failure_code 131049`/`131026` — Meta accepts synchronously with a WAMID, then rejects asynchronously) can exercise this handler; the synchronous ones (`132018`/`132000`/`132001`, template/param errors) cannot, by design of the existing architecture. Confirmed zero qualifying async `source_type='message'` failures have occurred since the PR #191 deploy (`2026-08-07T12:22:22Z`) through today, despite continued unthrottled traffic to the number that produced the historical 131049s (19 sends in the trailing 14 days, zero failures) — the underlying Meta "ecosystem engagement" pacing signal that caused the historical failures is not currently active and cannot be safely or deterministically forced on demand; it is Meta-internal and opaque, not something this codebase controls or can query in advance. No controlled test was run.

**Permanent qualification:** the async-webhook failure-notification path `notifyOwnerOfDirectMessageDeliveryFailure` has not yet been organically exercised by a post-deployment production `source_type='message'` async failure. This is **not an implementation blocker** — the relevant Meta failure condition is non-deterministic and cannot be safely forced on demand. When a genuine async `source_type='message'` failure occurs in production in the future: verify `metadata.delivery_failure_notice`, verify the owner push attempt, verify exactly-once behavior, and record that production evidence here. Do not reopen engineering or redesign this path solely because that organic event has not happened yet.

Reopen only if: a genuine production async failure occurs and the handler does not behave correctly, or production evidence reveals a real regression.

Merged via PR #191 (`ws5/staff-outbound-delivery-reliability`), merge commit `951f38d5b54a7d80c71e40dd20b2860b2c15ee70`, merged 2026-08-07T12:22:22Z. `carson-protected-behaviors` CI was blocked for several hours by a confirmed GitHub Actions platform-wide outage (per GitHub's own status page) — not a code issue; two attempts on the original run failed at "Set up job" with infrastructure errors ("job was not acquired by Runner," "Failed to resolve action download info") before ever reaching the test step. A fresh run, triggered by closing/reopening the PR (no commit, no workflow change, original orphaned run `31121769662` left untouched for the record) after GitHub's status returned to `operational`, completed in 18s with `Test Files 54 passed (54)` — the real protected suite, not an infra artifact.

Production deployment: `dpl_HJgWZc17yomuGT2YUhXnhqHWC2iX` (project `ra7etbal-v2`), `state`/`readyState: READY`, `target: production`, `meta.githubCommitSha` matches the merge commit exactly, `alias` includes both `www.ra7etbal.com` and `ra7etbal.com` with `aliasError: null`. Canonical `https://www.ra7etbal.com` returns HTTP 200. Smoke check via Vercel runtime logs/errors (1h window post-deploy): zero errors from `whatsapp-webhook.js` or `task-confirm.js`; the only error-group present is a pre-existing, unrelated Node `url.parse()` deprecation warning on `/api/process-delegation-escalations` and `/api/send-due-reminder-pushes`, first seen 2026-06-16 (long before this PR).

This is the canonical roadmap name and numbering — use it exactly, everywhere; do not refer to this workstream by any other name.

**Investigation preceded design.** Before any code was written, the original spec's "recurred 8 times... since 2026-07-15" claim was checked directly against live production `whatsapp_deliveries` (project `ggarvhgqzpooloacjgcj`) rather than trusted from the handover doc. Real count: 57 failures with `failure_code = '131049'`, dating back to 2026-06-30. Breakdown by `source_type`: `delegation` (301 sends) — 0 failures; `followup` (174 sends) — 0 failures; `message` (193 sends) — 90 failures, 57 of them code 131049. Of those 57: 6 already fully handled by the existing `reopen_substitute_decision_on_delivery_failure` RPC (rejected_alternative/custom_instruction); the remaining 51 are plain direct communications (48) or decision sends the reopen RPC didn't claim (3, all `approved_alternative`). Recipient breakdown on the uncovered 51: **46 to `+905010589614` (Sana, role "Boss": 44 plain communications + 2 approved_alternative), 4 plain communications to `+18624066061` (Loulya, family), and 1 approved_alternative to `+12025691377` (Christopher, real staff)** — i.e. overwhelmingly development/test traffic to the owner's and her daughter's own numbers, not real staff. Christopher's total across all `message`-type sends (35, not just the 131049 subset) had only 1 failure on the same template.

**Decision (Sana, 2026-08-06): do not build engineering around 131049 itself.** It is Meta's own per-recipient "ecosystem engagement" pacing, self-inflicted by concentrated dev/test traffic to the owner's own number, not a template-quality or account-tier defect, and not a real-staff-delivery problem in the data. Treated as an operational testing-practice issue outside Carson engineering, not fixed in code. Retry was explicitly rejected — resending to an already-throttled recipient would compound the pacing penalty, not fix it.

**Schema decision (Sana, 2026-08-06): no new persistence.** Every originally-proposed addition (a `reconciliation_status`/lease pair on `whatsapp_deliveries` mirroring Workstream 2's owner-notification lease, and a `pending_worker_notice` column on `tasks` to block stale-link completion) was checked against the live schema and failure data and dropped:
- A new lease/claim RPC was unnecessary — `updateWhatsappDeliveryStatus`'s existing compare-and-swap already guarantees a `failed` transition fires its handlers exactly once (the same guarantee WS2's lease exists to provide for a different problem: duplicate *sends* across cron retries, which staff-facing sends don't have).
- The existing `whatsapp_deliveries.metadata` `jsonb` column (already used by `recordSmsFallbackOutcome` for identical bookkeeping) is sufficient to record the notification outcome.
- The `tasks`-side blocking mechanism for the stale-confirmation-link scenario was not built: `followup` sends have **zero** production failures ever (0/174) — there is no verified evidence the scenario occurs outside the already-protected owner-decision flow. Per Sana's explicit instruction, protection was not built for a hypothetical problem; revisit only if a real `followup`-driven incident is confirmed, as its own workstream.

**What was implemented:** one new function, `notifyOwnerOfDirectMessageDeliveryFailure()` (`ra7etbal-v2/api/whatsapp-webhook.js`), wired into the existing `updated && status === 'failed'` gate in `updateWhatsappDeliveryStatus`, immediately after `reopenSubstituteReviewIfApplicable` (which was changed to return `true`/`false` so this new step can tell whether the failure was already claimed). Fires only for `source_type === 'message'` deliveries the reopen RPC did not claim — covering plain direct communications and any decision-send edge case the RPC's own SQL doesn't reopen. Sends `sendOwnerPush(..., variant: 'staff_delivery_failed')` (new branch in `buildOwnerPushBody`, `ra7etbal-v2/api/task-confirm.js`) and records `metadata.delivery_failure_notice` on the delivery row for idempotency/audit — no retry. Zero new tables, columns, RPCs, or leases. Zero changes to Workstream 1–3 files (`_owner-whatsapp-routing.js`, `_staff-decision-message.js`, the WS2 lease migration/RPCs, the WS3 canonical message builder).

**Tests:** `api/whatsapp-webhook.test.js` — 4 new cases (notifies once for an unclaimed plain-message failure and records the notice; stays silent when the reopen RPC already claimed it; never fires for non-`message` source types; idempotent against a pre-existing `delivery_failure_notice`). `api/task-confirm.test.js` — 1 new case for the `staff_delivery_failed` push-copy variant. Full targeted run: 170/170 passing (2 files). Full `npm run test:carson-protected`: 988/988 passing, 4 skipped, 3 todo (54 files) — pre-existing skips/todos unaffected. `npm run typecheck`: clean. Production build: passing (see PR for exact log).

**Functional verification status: pending, by design — not skipped.** Deployment health is confirmed (above); the new logic itself has not yet been exercised by a real failure. This repo's standing "Engineering Verification Rule for Webhook-Driven Features" (locked, see above) requires either Meta's webhook pointed at a preview deployment or verification after merge — a Vercel preview alone cannot exercise the real signed-webhook path. This session did not have `META_APP_SECRET` to construct a validly-signed synthetic callback, and did not repoint Meta's live webhook configuration (an external, hard-to-reverse production-config change) to work around that. Checked `whatsapp_deliveries` immediately post-deploy: no new rows since merge, so no organic `source_type='message'` failure has occurred yet to exercise `notifyOwnerOfDirectMessageDeliveryFailure`. Verification path: confirm via a `whatsapp_deliveries` query after the next real `source_type = 'message'` failure post-merge that `metadata.delivery_failure_notice` was written and an owner push was attempted — do not mark this workstream frozen before that direct evidence exists.

Protect: the single-fire `updated` gate this reuses; the `reopenSubstituteReviewIfApplicable` return-value contract (`false` means "not my concern, let WS5's hook decide"); the metadata-only, no-new-schema shape of `notifyOwnerOfDirectMessageDeliveryFailure`. Do not add a retry path for `source_type = 'message'` failures without new evidence the pacing root cause has changed. Do not build `tasks`-side stale-link blocking without a reproduced `followup`-failure incident.

### Personal Contact Reply Relay — COMPLETE, PRODUCTION VERIFIED

Status: COMPLETE. Not a numbered workstream (deliberately, per explicit instruction) — a narrowly-scoped capability adjacent to, but not part of, Workstream 3 (which is staff-facing only; see PR #187's own title). Merged and deployed as two PRs against `main`:

- **PR #195** (`fix/owner-whatsapp-direct-message-classification`, merge commit `f419d80df8d0787536ccb0f516a14c92cf384540`): repaired `classifyOwnerCommand` (`ra7etbal-v2/api/_owner-command-executor.js`) so personal questions, plain statements, and non-tell/ask phrasings ("Ask X if...", "Text X...", "Can you ask X...") to a person correctly resolve to `direct_message` instead of falling to "this WhatsApp command type is not supported yet." Grammar-based delegation signal (infinitive "to `<verb>`"), a bounded personal-response verb set with post-resolution role upgrade for confirmed staff (`is_family === false`), politeness-prefix stripping. Full design/reconciliation history and regression matrix preserved in session transcript.
- **PR #196** (`feat/personal-contact-reply-relay`, final merge commit **`32bd780c446669fa80029c24ea6196d7a9782ac9`**): closes the companion defect — owner → personal contact WhatsApp worked, but personal contact → owner was silently discarded (`handleInboundStaffMessage`'s `if (person.is_family) return {handled:false, reason:'family_sender'}` dead-end, pre-existing before either PR).

**Scope:** owner sends a direct personal WhatsApp through Carson → known family/personal contact replies → Carson safely correlates the reply → Carson relays it to the owner. Explicitly not a staff/task/escalation/QI capability.

**Architecture:** new `ra7etbal-v2/api/_personal-contact-reply.js`, invoked from exactly one production entry point — the `is_family` branch inside `handleInboundStaffMessage` (`ra7etbal-v2/api/whatsapp-webhook.js`), structurally isolated from every staff/task/escalation/QI code path (verified: the new module imports only `sendMetaMessage`; touches only `people`, `whatsapp_deliveries` (read-only), and the new `personal_contact_replies` table — never `tasks`, `staff_messages`, or `staff_escalation_owner_decisions`).

**Correlation** (deterministic, atomic, never guesses): decided inside `record_personal_contact_reply` (migrations `20260808_personal_contact_reply_relay.sql` + `20260808_personal_contact_reply_retry_and_atomicity.sql`), serialized per `(user_id, sender_phone)` via `pg_advisory_xact_lock`. Priority: (1) exact quoted Meta WAMID against a `direct_message` delivery, (2) exactly one eligible recent (7-day) delivery not yet referenced by any `personal_contact_replies.correlated_delivery_id`, (3) otherwise `unmatched` — persisted and disclosed to the owner honestly (`"X replied: 'Y' I couldn't safely match this to a recent message."`), never silently discarded, never a false correlation claim. Eligibility deliberately never uses `whatsapp_deliveries.delivery_status` (transport state, not conversational state).

**Consent-collision fix (release blocker, found and fixed pre-merge):** an opt-in-shaped short reply ("yes"/"ok"/"sure") from a family member with an active direct conversation was being consumed by the global `handleInboundConsentReply` before ever reaching the relay. Fixed by reusing `correlateReply` (read-only heuristic) to defer to the relay only when an active conversation exists; a genuinely new family contact's first opt-in reply is unaffected; opt-out is never deferred; staff consent behavior is untouched (`is_family` gate).

**Reliability (found and fixed pre-merge, reusing existing infrastructure, not new mechanisms):** owner-notification retry reuses the same `next_retry_at`/`retry_count` pattern as `owner_whatsapp_reply_receipts`, piggybacked onto the same already-scheduled 10-minute QStash sweep in `process-delegation-escalations.js` that already runs `reconcileOwnerWhatsappMessages`.

**Production deployment verified:** `dpl_CWMbzUJUs2Ep82owuwFSW7Y8rZkB`, `READY`, `target: production`, `githubCommitSha` matches merge SHA `32bd780c` exactly, aliases (`www.ra7etbal.com`/`ra7etbal.com`) healthy, `aliasError: null`, HTTP 200, zero new runtime errors attributable to the deploy.

**Live production verification — Loulya (2026-08-08), full backend evidence, not just the visible Carson reply:**
- Outbound: "Ask Loulya if she likes avocado." → `whatsapp_deliveries.id = db4a3c7c-c706-4049-b845-2e36964b2159`, `metadata.direct_message: true`, WAMID `wamid.HBgLMTg2MjQwNjYwNjEVAgARGBIyRkMzM0IxOUM0RjIyRjE1OUMA`, `delivery_status: read`, zero `tasks` rows for Loulya, `messages.task_id: null`. Preflight confirmed this was the *only* eligible candidate (Loulya's five older deliveries, 2026-07-15–07-21, had already aged out of the 7-day window).
- Inbound: Loulya replied "Yes." → `whatsapp_inbound_evidence` WAMID `wamid.HBgLMTg2MjQwNjYwNjEVAgASGBQzQUVCNzYyQzYxNkIzQ0ZENDgwRAA=`, received `2026-08-08 13:27:34+00`, `context_present: false`. Correctly **not** consumed by consent handling (opt-in-shaped "yes" deferred to the relay per the fix above, since Loulya had exactly one active conversation).
- `personal_contact_replies` row `6123b2b8-843c-4b0d-a9cf-041cf2ab2a55`: `correlation_method: single_recent`, `correlated_delivery_id: db4a3c7c-c706-4049-b845-2e36964b2159` (exact match to the avocado delivery), `owner_notification_status: sent`, `owner_notification_transport_message_id: wamid.HBgMOTA1MDEwNTg5NjE0FQIAERgSNUU5OTcwREUzMEMxRDM2NjE4AA==`, `owner_notification_retry_count: 0` (no retry needed), `owner_notification_next_retry_at: null`. Exactly one row for this WAMID (idempotency confirmed — no duplicate lifecycle record). Zero `staff_messages` rows, zero new `tasks`, zero `staff_escalation_owner_decisions` rows for this event.
- Known observability gap (not a defect): the owner-relay send (`sendOwnerRelay` in `_personal-contact-reply.js`) uses the bare `sendMetaMessage` helper directly, the same pattern as `sendOwnerAcknowledgement`/`sendOwnerReply` elsewhere — it does not create a `whatsapp_deliveries` audit row, so the relay's own delivered/read progression is not independently observable in that table. Meta's synchronous acceptance (the transport WAMID above) is the available evidence.

**Known historical artifact — Eren, time-bounded, not an active defect.** An earlier real test ("Tell Eren I'm on my way" → Eren replied "Tell her im waiting" on 2026-08-07, before this capability existed) was discarded by the old `family_sender` dead-end and never recorded in `personal_contact_replies`. A later avocado test to Eren correctly failed closed to `unmatched` because that old, forever-uncorrelated delivery remained technically "eligible" alongside the new one (`candidate_count = 2`). Investigated and confirmed deterministically from production evidence (not inferred). Two designs were explicitly rejected as unsafe: (1) "any later inbound evidence supersedes an older delivery" — breaks on an unrelated interleaved message; (2) "a new outbound delivery supersedes an older unresolved one" — breaks genuine concurrent-conversation ambiguity (would become newest-wins guessing). No code or schema change was made. The existing 7-day lookback window is itself the bounding mechanism — Eren's stale candidate ages out of eligibility on **2026-08-14** with zero intervention. Historical data was deliberately left untouched (no backfill, no manual resolution) per explicit instruction. Loulya's clean verification is unaffected and independent — different contact, different phone, no shared candidate set.

**Regression protection:** `ra7etbal-v2/api/_personal-contact-reply.test.js` (correlation priority incl. the eligibility-not-delivery_status case, atomicity via advisory lock, idempotency, retry sweep, both notification-text variants, empty-reply guard), `ra7etbal-v2/api/whatsapp-webhook.test.js` (dispatch isolation from staff paths; consent-collision deferral, non-regression for a fresh family contact, and staff-sender non-effect — 3 dedicated cases). Full suite 2860/2861 passing (one pre-existing, unrelated `ElevenLabsAgentWidget.sdk-config.test.ts` dependency-file issue). Protected suite 54/54, 1018 tests. Typecheck and build clean.

Protect: the structural isolation of `_personal-contact-reply.js` from all staff/task/escalation/QI code; the atomic, advisory-locked correlation RPC; the consent-collision `is_family` + active-conversation gate; the first-write-wins idempotency constraint on `(user_id, external_message_id)`; the retry sweep's reuse of the existing cron piggyback pattern. Reopen only on a reproduced production regression against the verified behavior above.

**Not fixed here, tracked separately, do not describe as resolved:** `send-whatsapp-task.js`'s shared Meta-request logging includes `payload.to` and `payload.text.body` in plaintext logs — pre-existing, codebase-wide (affects every capability that sends WhatsApp messages, not specific to this one), flagged during PR #196 review, deliberately left out of scope.

### Canonical Staff Identity Cleanup — COMPLETE, PRODUCTION VERIFIED

Status: COMPLETE. Merged as PR #198 (`chore/canonical-staff-identity-cleanup`), squash-merged twice — initial commit `ceeae5f`, then a CodeRabbit-review-fix commit `c904221` — final production merge SHA **`3951d8251a2409f98ecb3830ab78393135cc7ac5`**.

**Root cause:** `Christopher`, `Ghulam`, and `Nasira` each had one real production `people` row plus one empty "Test staff" duplicate (`role: 'Test staff'`, no phone, no notes, no consent), all three created in a single 7-second window on 2026-07-13T21:12:59–21:13:06Z. Christopher's duplicate caused every command naming him to fail with `recipient_not_unique` (discovered during PR #195 verification). Traced to origin: never created through the app's only production write path (`createPerson()` in `ra7etbal-v2/src/lib/people.ts`, a plain `.insert(draft)` called from `PersonForm`) — the shape (no phone/notes/consent, batch-created seconds apart) is inconsistent with anything that flow produces. Written directly via privileged/service-role database access during an earlier engineering/testing session, bypassing the application entirely.

**Read-only audit (performed before any change):** traced every person-identity-bearing column across all 30 tables in the schema (`automations.assignee_id`, `carson_tool_diagnostics.recipient_person_id`, `messages.person_id`, `personal_contact_replies.person_id`, `staff_messages.person_id`, `tasks.assigned_person_id`, `whatsapp_consent_log.person_id`, plus every text-based `assigned_to`/`recipient`/`recipient_name`/`staff_name` column). Zero references anywhere to any of the three duplicate rows; all 54 UUID-based references for these three names point exclusively to the real rows (12 `carson_tool_diagnostics`, 39 `staff_messages`, 3 `tasks.assigned_person_id` — all Christopher). Confirmed unused, not inferred.

**Removed** (production, pre-verified zero-reference immediately before deletion, identical to the audit): `Christopher` (`cc5e9f65-52eb-43ff-9af0-78816a7c1d5f`), `Ghulam` (`4f5c5a16-f75a-4e33-8708-74fc5c305fa9`), `Nasira` (`155c9a0a-f288-4e9c-a5a6-6788bec9595f`).

**Post-deletion production verification:** exactly one row remains per name (`christopher_count/ghulam_count/nasira_count = 1/1/1`), all three canonical IDs unchanged (`0a854693…`/`c6f13345…`/`916700b9…`), historical reference counts unchanged (12/39/3 for Christopher), total `people` row count dropped by exactly 3 (15→12), no unrelated rows touched. Christopher now resolves uniquely via the exact `name ilike` query recipient resolution uses.

**Prevention** (`ra7etbal-v2/supabase/migrations/20260808_people_reject_test_fixture_rows.sql`): a `CHECK` constraint (`people_role_not_test_fixture_check`) rejecting obvious test/fixture role markers (`'test staff'`, `'test'`, `'fixture'`, `'test fixture'`, `'seed'`, `'dummy'`). Deliberately **not** a unique-name constraint — legitimate distinct people (e.g. two staff both named "Ahmed") can share a first name, and the codebase has no existing disambiguation flow beyond name matching to fall back on (`recipient_not_unique` in `_owner-command-executor.js` has no follow-up clarification UI — a separate, out-of-scope gap). Enforced at the database level specifically because that's the actual vector that caused the incident (direct/service-role SQL bypassing `createPerson()` entirely) — no application-layer guard can reach that vector. Added with `NOT VALID` then `VALIDATE CONSTRAINT` in the same migration (CodeRabbit finding, fixed pre-merge) to avoid an `ACCESS EXCLUSIVE` lock during a full-table scan — immaterial at 12 rows today, but the correct pattern regardless of table size.

**Live-verified pre-merge** via rollback-wrapped transactions against production: an insert with `role='Test staff'` is rejected (`23514` check violation, confirmed no residual row); a legitimate second "Christopher" with a real role (`'Gardener'`) still succeeds (confirmed no residual row either way, both wrapped in `BEGIN; ... ROLLBACK;`) — proves the guard targets the fixture-role signature only, not name collisions.

`ra7etbal-v2/src/lib/people.ts`: one additive branch in the existing `friendly()` error mapper surfacing a clear message for this specific constraint violation, matching its existing RLS/network-error pattern.

**Regression protection:** `ra7etbal-v2/src/lib/people.test.ts` — 2 new tests (constraint-violation error mapping; legitimate same-name insert unaffected), using a properly typed `PersonDraft` fixture (CodeRabbit nitpick on the first commit, fixed pre-merge — no `as never` casts). `npm run test:carson-protected`: 54 files, 1018 tests, all green. Typecheck and build clean.

Protect: the `people_role_not_test_fixture_check` constraint and its bounded marker list; the `NOT VALID`/`VALIDATE CONSTRAINT` migration pattern for any future constraint on this or other tables. Do not add a blanket unique-name constraint on `people` without a separate, explicit product decision — same-name legitimate people must keep working.

### Inbox Review V1

Status: complete and stable.

Protect:

- Safe Inbox processing
- Duplicate To-do protection
- Blocked items remaining visible
- Reminder creation
- Delegation through the proper path
- Confirmation links
- Removal of delegated items from Inbox
- Manual delete

### Quality Intelligence V1

Status: complete and stable.

Protect:

- Invalid proof rejection
- Reference-image and wrong-object rejection
- Correction loop
- Task remaining open during correction
- Valid proof approval
- Stale-race protection
- Proof replacement
- Owner completion notification
- Scheduler stopping generic follow-ups after proof
- Exact product text preservation

Routine invalid proof should return to the worker for correction. The owner should only be interrupted for repeated invalid proof, uncertainty, or a real decision.

### Alternative review (substitute_review) — golden regression contract (LOCKED, branch `test/alternative-review-golden-contract`)

Status: test-only stabilization, no runtime file changed. Protects the Approve Alternative / Reject Alternative / Custom Instruction decision lifecycle: `quality_review_status: "substitute_review"` as the correct trigger state; the Needs You decision surface (`isQualitySubstituteReviewStatus`/`resolveQualityLifecycle` → `needs_owner_decision`); Approve using `reserve_rejected_alternative`/`complete_custom_instruction`-style approval RPCs distinct from Reject's own `reserve_rejected_alternative`/`complete_rejected_alternative` pair; Custom Instruction text reaching the outbound WhatsApp payload verbatim; no cross-task bleed between simultaneous `substitute_review` tasks; exactly-once execution via the claim RPC's `status: 'completed'` short-circuit; no duplicate WhatsApp send on retry; failure paths (missing auth, wrong owner, Meta rejection, network error) never reporting success; and the correct final task state per decision (`completed` / `waiting_for_confirmation` / `proof_submitted`).

New files: `src/lib/alternative-review-golden-contract.test.ts` (client, 11 tests) and `api/alternative-review-golden-contract.test.js` (server, 11 tests) — real calls into `api/task-confirm.js`'s `handlePost`/`handleOwnerDecision`, `src/lib/quality-lifecycle.ts`, and `src/lib/quality-substitute-decision.ts`, with only Supabase REST, the Meta Graph API, and the Anthropic API mocked. Deliberate-failure proof: inverted the Reject/Approve RPC branch mapping in `task-confirm.js`, confirmed the Reject-path test failed precisely, reverted, confirmed green again. Part of `npm run test:carson-protected`.

Protect: the RPC-pair separation between Approve/Reject/Custom Instruction; the exactly-once claim short-circuit; the failure-never-claims-success contract on both the client helper and the server handler. Reopen only on a reproduced production regression.

### Protected photo workflow — golden regression contract (LOCKED, baseline 447a685)

Status: complete and stable. Production baseline commit: `447a685`.

Why this exists: the same class of production incident recurred repeatedly in one day — a private handwritten note's photo leaked to staff (PR #78), then a legitimate visual-reference photo was silently dropped (PR #79), then real WhatsApp media never sent for 2+ photos and proof photos nearly leaked back to the assignee (PRs #80/#81), then a second reference photo was silently dropped from Quality Intelligence review (PR #82). Each fix was correct in isolation; the whole photo journey had no single permanent test contract tying it together.

**Protected photo journey**:
1. Owner attaches a photo (1 or many) to a delegation. A private note or screenshot is read by Carson but never forwarded to staff unless explicitly authorized or genuinely visually required (`src/lib/image-forwarding-guard.ts`).
2. An authorized image is persisted (`tasks.image_path` for the first photo; `task_attachments` with `file_name IS NULL` for every reference photo) and reaches the real WhatsApp send — single photo via the `ra7etbal_task_image` header template, 2+ photos via the primary text template plus one real freeform image message per photo (`api/send-whatsapp-task.js`).
3. The assignee submits proof photos, stored in the same `task_attachments` table but discriminated by `file_name = 'proof'` — never mixed with, and never re-sent as, reference photos.
4. Quality Intelligence loads **every** reference photo (not just the first) and **every** proof photo, and judges the two sets together with no assumed positional pairing (`api/task-confirm.js`, `api/_quality-review.js`). A fresh proof submission always clears prior review state before the new review runs.
5. A photo authorized for one delegation recipient never leaks to a different recipient in the same turn.

**Golden test command** (also the mandatory CI gate — `.github/workflows/carson-protected-behaviors.yml` runs `npm run test:carson-protected` on every PR to `main`, unconditionally, no path filter):
```
npm run test:carson-protected
```
or to run just the golden contract in isolation:
```
npx vitest run src/lib/photo-workflow-golden-contract.test.ts api/photo-workflow-golden-contract.test.js
```

**Critical files covered**: `src/lib/image-forwarding-guard.ts`, `src/lib/text-carson.ts`, `src/components/home/ElevenLabsAgentWidget.tsx` (image/delegation paths), `api/send-whatsapp-task.js`, `api/task-confirm.js`, `api/_quality-review.js`, plus their existing detailed test files (`image-forwarding-guard.test.ts`, `text-carson-image.test.ts`, `send-whatsapp-task.test.js`, `task-confirm.test.js`, `_quality-review.test.js`) which the golden contract complements rather than replaces.

**Rule**: this workflow must not be changed without running the golden contract (`npm run test:carson-protected`) before and after the change, and the change must not weaken, skip, or remove any golden scenario. Do not reopen without a reproduced regression.

### Recurring owner reminders

Status: completed and production verified.

Do not reopen without a reproduced regression.

Personal recurring reminders must not be converted into staff WhatsApp delegations when the owner's name also exists in the people table.

### Type to Carson V1

Status: implemented and tested. **Superseded in part by "Type to Carson is advisory-only" above (2026-07-25)** — see that entry for the current, authoritative rule. "To-do creation" and "Tool authority and deterministic operational actions" below are historical: typed chat can no longer create a to-do or reach any state-changing tool/deterministic send path. Everything else in this list (same production agent, persistence/history restore, Clear Chat, image attachment/understanding, preview allowlisting) is unaffected and still protected.

Protect:

- Same production Carson agent as voice
- Persistence and history restore
- Clear Chat
- Image attachment and image understanding
- Preview allowlisting

### Typed-image delegation race fix

Status: merged and deployed.

Protect separation between restored typed history, newly selected image context, and tool execution. Never allow an old task or old recipient to inherit a newly selected image.

### Universal Timestamp System (V1A + V2A)

Status: COMPLETED. PRODUCTION VERIFIED. STABLE. PROTECTED.

Production verification date: 2026-07-19. Verified by Sana on canonical production at `https://www.ra7etbal.com`.

Releases:
- V1A — PR #31, merge commit `a32f8f40a0eb345669cec67c938cac439bf3a29b`
- V2A — PR #34, merge commit `7a6349a2a64f498f2cdebe141e412fae73cbd6af`

Do not reopen this work because of an idea, cleanup proposal, consistency preference, refactor, or best-practice suggestion. Reopen only when Sana explicitly approves a product change, or a reproduced production regression is documented with screenshots and exact steps.

**Production-verified behavior:**

1. Type to Carson — every stored chat message shows its time; messages crossing calendar days show date dividers; history restoration and Clear Chat remain working.
2. Needs You — every card shows a truthful available timestamp, using the most relevant real timestamp available; never invents a "Needs You since" timestamp. Valid labels: Reviewed, Escalated, Due, Overdue, Created.
3. Waiting — delegation cards show their sent date and time.
4. To-do — to-do cards show their creation date and time.
5. Notes — notes show their creation date and time.
6. Automations — automation cards show the relevant run event and time (e.g. Reminder sent, confirmation, escalation, completion, next run).
7. History — completed task cards show their existing stored sent date and time.

**Permanent rules:**

1. Do not remove these timestamp displays.
2. Do not hide, rename, replace, or simplify them without Sana's explicit approval.
3. Do not change their meaning.
4. Do not substitute one event timestamp for another event.
5. Do not invent missing timestamps.
6. Do not infer a lifecycle event time when the event was not persisted.
7. Always display timestamps in the owner's local device timezone unless an explicitly approved product change says otherwise.
8. Preserve date dividers in Type to Carson.
9. Preserve per-message times in Type to Carson.
10. Preserve truthful fallback labels such as "Created" when no more specific lifecycle timestamp exists.
11. Future work may add missing lifecycle timestamps, but it must be additive.
12. Future timestamp work must not break or rewrite the production-verified V1A or V2A displays.
13. Do not touch protected systems while working on timestamps, including: Talk to Carson, Type to Carson session architecture, typed history restoration, Clear Chat, Morning Brief, Night Sweep, reminders, Automations execution, WhatsApp, delegations, owner decisions, Quality Intelligence, proof upload, hosting, calendar, Notes, To-do.
14. Do not reopen this work because of an idea, cleanup proposal, consistency preference, refactor, or best-practice suggestion.
15. Reopen only when Sana explicitly approves a product change, or a reproduced production regression is documented with screenshots and exact steps.

Implementation detail (unchanged from the original entries, kept for reference): live typed messages, restored typed history, Clear Chat, and message order read `created_at` off objects already flowing through `typedMessages` state; legacy Routines' `last_run_at` display and automation execution/scheduling are untouched (read-only widening of an existing Supabase select); Needs You timestamps come from `src/lib/needs-you-timestamp.ts` (`getNeedsYouTimestampLabel`), which mirrors but never reads or modifies `isNeedsYouTask()`'s classification in `daily-brief.ts`. No database migration, no API/serverless change, for either release.

### Owner escalation visibility in Waiting cards

Status: COMPLETED. MERGED. DEPLOYED. PRODUCTION VERIFIED. PROTECTED.

PR #55, merge commit `8cd6a544a068708b4e796e65a385c5ac6c523fda`.

What it is: a small "Escalated" badge on `TaskCard.tsx`, shown only on a waiting delegation or waiting follow-up whose `tasks.escalated_at` is already set by the existing, unrelated `process-delegation-escalations.js` escalation job. Before this, the only owner-facing signal that a delegation/follow-up had been escalated was a single mention inside Carson's spoken morning/evening brief — the Waiting tab itself gave no visual signal. Reuses the existing rose badge visual language already used for "Overdue"/"Needs your review"; no new component, no new design system, no schema change, no change to escalation timing, escalation automation, task classification, or task state.

Production verification evidence: deployment `dpl_DciDpx3CHdzaHbQEJwstqfFJ8eoy` (project `ra7etbal-v2`), `state: READY`, `readyState: READY`, `meta.githubCommitSha` matches the merge commit exactly, `alias` includes both `www.ra7etbal.com` and `ra7etbal.com`, `aliasError: null`. Canonical `https://www.ra7etbal.com` returned HTTP 200.

Visual verification evidence: Sana visually verified the live Escalated badge on production. Confirmed: the badge appears only on waiting delegations or follow-ups with `escalated_at` set; the existing "Waiting for confirmation" wording is unchanged; existing card layout and actions are unchanged.

CI/test evidence: `carson-protected-behaviors` CI passed. CodeRabbit finished with no remaining actionable comments (one valid finding — a test-assertion matching the word "Escalated" generically instead of the exact badge JSX — was fixed; two out-of-scope suggestions, a new component-render test harness and an unrelated flex-wrap styling change, were explicitly skipped as out of scope). Focused `TaskCard.test.ts` + `TaskCard.quality.test.ts`: 19/19 passing. Typecheck passed. Production build passed.

Protect: do not change escalation timing, escalation automation (`process-delegation-escalations.js`), task classification, or task state to maintain this badge — it only reads the existing `escalated_at` field for display. Reopen only on a reproduced production regression.

### Needs You is a decision queue, not an ownership queue

Status: COMPLETED. MERGED. DEPLOYED. TECHNICALLY VERIFIED. VISUALLY VERIFIED. PROTECTED.

PR #59, implementation commit `61fc5ab`, merge commit `679aaeb5a6c43d93493678ef4b057b69fd5c6ab9`, production deployment `dpl_FJoeNAzEU8gdmU7gUi8nMmCrd8Ug`.

Root cause: `isNeedsYouTask()` in `src/lib/daily-brief.ts` treated mere self-assignment ("assigned to me", assignee empty) as sufficient for Needs You — on any non-reminder task type via its owner-task fallback, and on any reminder due today or overdue via a separate branch. This put ordinary self-assigned actions, errands, and personal reminders (including automation-generated test reminders) into Needs You as if they required an owner decision, when Carson could already continue without interrupting the owner.

Final authoritative rule: the self-owned fallback now requires `task.type === "decision"` — the extraction pipeline's own existing, authoritative signal for "a choice the user must make" (`extract-prompt.ts`). No title or description keyword matching is used anywhere in the fix.

Preserved, untouched: cancelled tasks still always surface (`task.status === "cancelled"`); the existing quality-review intervention path (`isWaitingInterventionTask()` — delegations/follow-ups needing owner review via `quality_review_status`) is unchanged.

Excluded actions, errands, and reminders are not deleted, migrated, or rewritten — they remain fully reachable via the existing "Upcoming reminders" and "Later" sections inside the What's Happening → Needs You tab (`getUpcomingReminderTasks`, `brief.later`), both pre-existing and unmodified.

Home, What's Happening, and the bottom-navigation badge all read the same `buildDailyBrief().needsAttention` array — this one shared classifier fix corrected all three surfaces at once, with no risk of drift between them.

Technical verification: deployment `dpl_FJoeNAzEU8gdmU7gUi8nMmCrd8Ug` (project `ra7etbal-v2`), `state`/`readyState: READY`, `meta.githubCommitSha` matches the merge commit exactly, `alias` includes both `www.ra7etbal.com` and `ra7etbal.com`, `aliasError: null`. Canonical `https://www.ra7etbal.com` returned HTTP 200.

Visual verification: Sana confirmed on production — Home shows "Nothing needs you right now." with correct Waiting · 3 / Handled · 2 counts and no false Needs You count; the What's Happening nav badge carries no false attention count; What's Happening → Needs You shows "Nothing needs your attention right now." with Later · 16; expanding Later confirms the 16 excluded records (e.g. "test this exact reminder", "This is a recurring automation test that I should see, receive.", "Update the Rahet Bal master plan.") remain accessible and are no longer presented as owner decisions; Automations, Waiting, To-do, Notes, Staff, and History remain intact; Waiting delegation cards and Escalated labels remain intact.

Protect: this classifier gate (`task.type === "decision"` on the self-owned fallback) — do not reintroduce a broader self-assignment check or any title/description keyword matching. Reopen only on a reproduced production regression.

### Phase B — staff-to-owner escalation loop

Status: FULLY VERIFIED AND CLOSED. PRODUCTION VERIFIED. PROTECTED.

Production baseline: commit `4d71fc4f409acf973898f33a49e0b586bdc54695`, deployment `dpl_7eqkMzJ4va9S794QbcnrtAXA9hP4`, verified 2026-07-27.

What it is: when a non-family, WhatsApp-opted-in staff member sends Carson an explicit permission/approval/authorization request (e.g. "Can I buy X instead?"), Carson must escalate to the owner rather than deciding itself, unless the exact action is already pre-approved in supplied task/household-rule context. The chain: `api/_staff-comms-engine.js` classifies and, for a genuine escalation, sets `owner_attention_required=true`/`next_action_owner=owner`/`user_facing_state=Needs You` → `api/whatsapp-webhook.js`'s `handleInboundStaffMessage` calls `api/_escalation-notify.js`'s `notifyOwnerOfEscalation` → an atomic lease (`claim/complete/fail_owner_escalation_notification`, migration `20260727_staff_escalation_owner_notification_lease.sql`) guarantees at most one real Meta send per escalation → one `staff_escalation_owner_decisions` row is created (Phase A, `20260726_staff_escalation_owner_decisions.sql`) → one `ra7etbal_owner_decision` WhatsApp template message is sent to the owner → one `whatsapp_deliveries` audit row is created and linked via `metadata.staff_message_id` (never via `message_id`, whose FK targets `public.messages`, a different table) → the staff member receives exactly one truthful holding reply, the literal string `"I'm checking with the owner. I'll come back to you."`, sent only after Meta genuinely accepted the owner send.

Delivered across 4 PRs, each independently reviewed and production-verified before the next started:
- PR #85/#86 (merge `c87d167`/`c7b32b0`) — Phase A schema + Phase B wiring into the real inbound path.
- PR #87 (merge `1200f4e581be8fbc6b665daec3cf714aa2520ea1`) — closed a confirmed live failure where Carson self-authorized a staff substitution request ("go ahead... that's a standard kitchen swap") with no stored approval. Added a `HARD RULE` to `_staff-comms-engine.js`'s `SYSTEM_PROMPT`: explicit staff permission requests must escalate unless the exact action is pre-approved in context; Carson must never invent approval wording.
- PR #88 (merge `4d71fc4f409acf973898f33a49e0b586bdc54695`) — closed a confirmed live gap where the real Meta send succeeded but no `whatsapp_deliveries` audit row was ever created, because `beginWhatsappDelivery` had no trusted-context lookup for a staff-message-originated, often taskless send. Added a `staffMessageId` → `public.staff_messages` lookup to `api/_whatsapp-delivery.js`, mirroring the existing `messages`/`tasks`/`routines`/`automation_runs` pattern.

Both fixes were proven against real production traffic, not just tests: a controlled live test (Christopher, non-family opted-in staff; Sana, the household's only Boss/owner) sent an explicit permission request and the full chain was independently confirmed end-to-end from real Supabase rows and Sana's own WhatsApp inbox.

**Two test escalations exist in production as of the verification date below — they are test data, not real owner decisions, and must never be treated as answered or resolved:**
- `staff_messages.id 8a90931f-cd03-4638-824d-1493a9a2d61a` / `staff_escalation_owner_decisions.id 8740ed2f-a81d-47ff-bb3e-8f2610b5aacd` ("regular olive oil... extra virgin olive oil", 2026-07-26) — predates PR #88, so it has no `whatsapp_deliveries` audit row; this is expected and not a regression.
- `staff_messages.id e02938bb-5a04-401b-8b60-79967b5a89fa` / `staff_escalation_owner_decisions.id dedcff26-dad5-4f87-afa8-4cf9f00aa0d8` / `whatsapp_deliveries.id 55ddae6a-644c-4e51-a0f9-0f2456dc12d0` ("regular balsamic vinegar... red wine vinegar", 2026-07-27) — the first live proof the audit row now exists and is correctly linked.

Both remain `status: open`, `owner_reply_text: null`, `answered_at: null` by design — this is correct Phase B behavior, not an incomplete task.

**Exact Phase B/C/D boundary:** Phase B's job ends the moment the owner has been notified and the staff member has a truthful holding reply. It never resolves the escalation, never writes an owner decision, and never routes anything back to staff. **Phase C** (the owner answering) and **Phase D** (relaying that answer back to the staff member) were both later implemented and merged — see the "Phase C" and "Phase D" entries below; **corrected 2026-08-10**, this line previously read "both not implemented," which is stale.

**Separate, explicitly out-of-scope backlog item:** `_staff-comms-engine.js`'s `loadStaffContext` still loads zero prior `staff_messages` conversation turns — each inbound message (including a direct follow-up to Carson's own prior question) is classified with no awareness of what was said moments before. Tracked as a Carson Reliability Engineering item, not fixed by PR #87 or #88.

Protect: the four-PR contract above in full — classification/escalation fields, the atomic notification lease as the sole idempotency/resend guard, the `staff_messages`-linked delivery audit row (never via `message_id`), the exact deterministic staff holding reply and its Meta-acceptance gating, and the unresolved-by-design escalation state. The full regression suite for this contract (`api/_staff-comms-engine.test.js`, `api/staff-escalation-phase-b-golden-contract.test.js`, `api/_whatsapp-delivery.test.js`) runs under `TZ=UTC npm run test:carson-protected`. Reopen only on a reproduced production regression — do not redesign this flow to add Phase C/D behavior without a separate task. Phase B remains protected by its existing stable state above; a separate stable tag (`ra7etbal-stable-owner-escalation-phase-b-2026-07-27`) marks this exact baseline.

### Phase C — Needs You visibility + read-only owner-decision page

Status: **corrected 2026-08-10 — previously read "PR #91 open... not yet merged, not yet closed"; stale.** PR #91 (`b386d75`, "owner-decision page copy no longer tells owner to bypass Carson") merged 2026-07-27T04:23:58Z. IMPLEMENTED, MERGED, PRODUCTION-VERIFIED (owner-page load, read-only), PROTECTED. The "Phase D remains not implemented" language further below in this section is also now stale — see the new Phase D entry immediately after this one.

What it is: the open staff escalations Phase B already creates are now surfaced two ways, both read-only: (1) inside the *existing* Needs You list/counts on Home, Updates → Needs You, and the bottom-nav badge — no Staff tab restored, no new navigation surface; (2) via a dedicated, authenticated, read-only owner-decision page (`OwnerEscalationDecision.tsx`) reached through the same `/confirm?task={{1}}` WhatsApp template URL already approved for worker task-confirmation links, discriminated from a real task link purely by probing the existing, unmodified `/api/task-confirm` endpoint (`ConfirmRouter.tsx`'s `resolveConfirmLinkKind`) — a genuine 404 routes to the owner page, anything else routes to the unmodified `Confirm.tsx`.

`filterVisibleStaffEscalations` (`src/lib/needs-you-staff-escalations.ts`) performs no deduplication: a staff escalation is never hidden because its `task_id` happens to match a task shown in Needs You for an unrelated reason (quality review, cancellation, a self-owned decision task) — there is no reliable shared-decision identifier in the current schema, so visibility always wins over cosmetic duplicate suppression.

Production verification (2026-07-27): both open test escalations (balsamic-vinegar `staff_messages.id e02938bb-5a04-401b-8b60-79967b5a89fa` and the olive-oil escalation `8a90931f-cd03-4638-824d-1493a9a2d61a`) appeared in Needs You; the What's Happening badge showed a count of 2 for them; the balsamic-vinegar "Review decision" WhatsApp link routed to the correct owner page, displaying the correct Christopher request; opening the page caused zero database mutation (`staff_escalation_owner_decisions.status` remained `open`, `owner_reply_text`/`answered_at` remained `null`, `staff_messages.escalation_resolved_at` remained `null`, before and after, confirmed by direct query). Neither escalation was clicked through or answered.

Read-only by design: no form, button, write, insert, update, or RPC exists anywhere in this slice. Opening the owner page, or any Needs You surface showing an escalation card, can never itself resolve or answer an escalation — that is exclusively Phase D's job, not yet built. The owner-page copy reflects this truthfully: open escalations show "Decision controls are coming next. This request will remain in Needs You until you respond through Carson."; an already-answered decision (not yet reachable in production, since Phase D doesn't exist) shows only "You already responded to this request." — the open-state copy is suppressed, never both at once. No copy anywhere on this page instructs the owner to bypass Carson (reply/message/text/contact/call/WhatsApp the staff member directly, or "outside Carson"/"manually") — enforced by a dedicated regression test in `OwnerEscalationDecision.test.tsx` that also positively proves it cannot false-positive on a staff member's own quoted request text.

**Exact Phase B/C/D boundary (unchanged from the Phase B entry above):** Phase C never persists an owner answer, never calls `answer_escalation_owner_decision` or any other RPC, never sends a staff message, and never resolves an escalation. Phase D (relaying the owner's answer back to staff) remains not implemented — do not build it into a task scoped to Phase C.

**Separate, deferred, out-of-scope item:** dismissed Home notifications reappearing is a known, separate regression, unrelated to and not fixed by Phase C — do not conflate the two or attempt to fix it inside Phase C's scope.

Protect: `filterVisibleStaffEscalations`'s no-deduplication behavior — do not reintroduce `task_id`-based suppression or any text/category/timing heuristic. `ConfirmRouter`'s discriminator — do not change the Meta template URL shape or make `Confirm.tsx`/`api/task-confirm.js` aware of owner escalations. The owner page's read-only contract — no write/RPC/message-send may be added without a separate, explicitly-scoped Phase D task. The full regression suite for this contract (`src/lib/staff-messages.test.ts`, `src/lib/needs-you-staff-escalations.test.ts`, `src/routes/Home.test.ts`, `src/routes/Updates.test.ts`, `src/components/nav/BottomNav.staff-escalation-badge.test.ts`, `src/routes/ConfirmRouter.test.tsx`, `src/routes/OwnerEscalationDecision.test.tsx`) runs under `TZ=UTC npm run test:carson-protected`. Do not claim this section "CLOSED" until PR #91 is merged, deployed, and the live copy fix is production-verified — at that point, tag the merge commit `ra7etbal-stable-owner-escalation-phase-c-2026-07-27`.

### Phase D — owner answer delivery to staff — MERGED, PROTECTED (newly documented 2026-08-10)

Status: **added 2026-08-10 — this phase was merged and live in production but had no entry anywhere in this file; the Phase B/C entries above still say "Phase D remains not implemented."** Merged as PR #92 (`657fdf7a1ce7f15a080e9394b3a62c916f45f22f`, "feat: Phase D — owner answer persistence and staff-delivery routing"), 2026-07-27T15:03:49Z. Confirmed live in `api/task-confirm.js` and `api/_owner-whatsapp-routing.js`.

What it is: closes the loop Phase B/C left open — the owner's answer to an open staff escalation (approve / reject / custom instruction) is persisted and delivered back to the staff member who asked, as a plain-text WhatsApp message (never a template, since the staff member messaged first and this send is inside Meta's customer-service window — same convention as Carson's own auto-reply to staff in `whatsapp-webhook.js`'s `handleInboundStaffMessage`).

Two entry points, one shared core: (1) `handleEscalationAnswer` (`api/task-confirm.js`, PATCH route reached via `deepLinkToken` from the Phase C owner-decision page) and (2) the authoritative owner WhatsApp quoted-reply path (`api/_owner-whatsapp-routing.js`). Both call the same extracted core, `resolveAndDeliverEscalationAnswer` (`api/task-confirm.js`, exported) — deliberately no second, independently maintained Phase D implementation. Reuses the Phase A state machine and RPCs unchanged: `answer_escalation_owner_decision` (saves the answer exactly once — a resubmit on an already-answered escalation ignores the newly submitted decision and returns what's already stored, making duplicate submits/second-tab/resubmit-after-refresh all safe) plus `claim_escalation_answer_delivery`/`complete_escalation_answer_delivery`/`fail_escalation_answer_delivery` (delivery lease, same pattern as every other at-most-once send in this codebase). Schema: `20260727_phase_d_escalation_answer_delivery_message_id.sql` (widens `delivery_transport_message_id` on the existing Phase A table — no new table).

`handleEscalationAnswer` adds its own explicit ownership check before any write (the token lookup's `user_id` must match the authenticated session) even though `answer_escalation_owner_decision` itself authorizes by token possession alone (necessary because Phase C's read-only page has no session to check against) — a mismatched or nonexistent token gets the identical generic "invalid link" response either way, never a response that would disclose whether the token exists for a different household.

Regression coverage: exercised across `task-confirm.test.js`, `_owner-whatsapp-routing.test.js`, `owner-whatsapp-decision-golden-contract.test.js`, `staff-decision-golden-contract.test.js`, `staff-escalation-phase-b-golden-contract.test.js`, `task-owner-whatsapp-substitute-review.test.js`, `staff-escalation-owner-decisions-migration.test.js`, `owner-whatsapp-safe-routing-migration.test.js` — all part of `test:carson-protected`.

Protect: `resolveAndDeliverEscalationAnswer` as the single shared core — do not build a second delivery path for either entry point. The exactly-once-answer contract (an already-answered escalation never re-saves a resubmitted decision). The explicit ownership re-check in `handleEscalationAnswer` despite the RPC's own token-only authorization. The generic, non-disclosing "invalid link" response shape. Reopen only on a reproduced production regression.

### Escalation-notify business-number binding parity — COMPLETE, PRODUCTION VERIFIED

Status: FIXED. MERGED. DEPLOYED. PRODUCTION VERIFIED. PROTECTED.

PR #205, merge commit `adbf0b5e7376b16c55112e0d274d5ffe19086679`.

Root cause: `findQuotedEscalation` (`api/_owner-whatsapp-routing.js`) matches an inbound owner WhatsApp reply that quotes an earlier notification back to the correct `staff_escalation_owner_decisions` row via `whatsapp_deliveries.metadata`, and rejects the match if `metadata.owner_phone_number_id` doesn't equal the Meta business `phone_number_id` the reply arrived on — added by an earlier "bind owner decisions to exact recipients" fix so a reply can never be bound to an escalation notification sent from a different business number. That fix updated `notifyOwnerOfTaskReview` (the task-confirm.js proof/substitute-review path) to record `owner_phone_number_id` in its delivery metadata, but never updated its sibling `notifyOwnerOfEscalation` (the staff-message escalation path, called from `whatsapp-webhook.js`'s `handleInboundStaffMessage`). Because the check is `if (boundPhoneNumberId && boundPhoneNumberId !== phoneNumberId)`, the absent field silently disabled the guard rather than failing closed — every staff-escalation quoted reply matched regardless of which business number it arrived on, while the equivalent task-review path already enforced the match.

Fix: added `owner_phone_number_id: phoneNumberId` to `notifyOwnerOfEscalation`'s existing delivery-metadata object literal in `api/_escalation-notify.js` — the only production-code line changed. `findQuotedEscalation`, both notification leases, the decision RPCs, and `notifyOwnerOfTaskReview` are all untouched.

Regression protection: `staff-escalation-phase-b-golden-contract.test.js` now asserts `notifyOwnerOfEscalation` persists `owner_phone_number_id` in `beginWhatsappDelivery`'s metadata; `_owner-whatsapp-routing.test.js` gained dedicated matching-business-number-succeeds and mismatched-business-number-fails-closed tests for a staff-escalation-shaped delivery, alongside the pre-existing task-review-shaped coverage of the same guard.

Verification: focused suite (119 tests) + full `npm run test:carson-protected` (54 files, 1025 passed, 4 skipped, 3 todo) + typecheck + production build all clean. Before merge, confirmed zero currently-open `staff_escalation_owner_decisions` rows in production (Supabase project `ggarvhgqzpooloacjgcj`), so no in-flight notification was affected by the newly-enforced binding. Production deployment `dpl_76aoQy1xjnhJYabwzt1mXzMU7kPf`, `readyState: READY`, `githubCommitSha` matches the merge commit exactly, `alias` includes both `www.ra7etbal.com` and `ra7etbal.com`, `aliasError: null`. Canonical `https://www.ra7etbal.com` loads correctly. `get_runtime_errors` shows zero new error groups attributable to this deployment — the only group present (`DEP0169` Node `url.parse()` deprecation warning) predates this change (first seen 2026-06-16) and is unrelated.

Protect: keep `notifyOwnerOfEscalation` and `notifyOwnerOfTaskReview` recording the same delivery-metadata shape (`owner_phone_number_id` included in both) going forward — any future field added to one for `findQuotedEscalation`'s binding checks must be added to the other in the same change, or this exact asymmetry can reopen silently.

## Current product rules

### Carson communication

- Act first when the request is clear.
- Ask only for information required to execute safely.
- Do not send vague staff instructions.
- Gather complete operational details before delegation when hosting, travel, events, or multi-person coordination requires them.
- After success, confirm briefly and truthfully.
- Never say an action succeeded when the tool failed.

### Owner and staff model

The long-term direction is that the owner communicates with Carson, staff communicate with Carson, and Carson manages the operational loop.

Carson should surface outcomes, delays, exceptions, and decisions rather than forcing the owner to manage every message.

### Automations

Trusted:

- Owner recurring reminders using push notifications
- One-time delegations
- One-time direct WhatsApp messages

Not trusted and currently excluded:

- Recurring WhatsApp delegations
- Recurring WhatsApp direct-message automations

### WhatsApp owner decision template — CLOSED, PRODUCTION VERIFIED, PROTECTED

**Correction (2026-08-14, Stage 1 Item 3 reconciliation): this status was stale.** "Pending Meta approval or final live validation" predates the template going live. The `ra7etbal_owner_decision` template is approved and has been in continuous production use: 24 real sends between 2026-07-13 and 2026-08-12 (confirmed directly against `whatsapp_deliveries`), including live-tested Approve Alternative, Reject Alternative, and Custom Instruction decisions (see "Alternative review (substitute_review) — golden regression contract," "Owner WhatsApp decision message quality," and Phase B/C/D above). Dynamic task URL (`https://www.ra7etbal.com/confirm?task={{1}}`) confirmed live and in use.

Protect: normal delegations, proof upload, worker replies, routine templates, and Quality Intelligence — unaffected by this correction.

## Known current issues and near-term priorities

### Historical Lookup — Phase 1, Q4 Commitment History

Status: **PERMANENTLY CLOSED (2026-08-04) — reference implementation for
future Carson tool investigations.** Final closure package (architecture
diagram, full safeguard/test/file inventory, Definition of Done checklist)
delivered in chat and archived in Claude memory,
`carson_master_plan.md` → "Appendix: Blue Pen Incident." Also fixed as part
of closure: PR #171 corrected
`docs/elevenlabs-prompt-patches/2026-08-03-commitment-history.md` and its
README entry, which still read as an unapplied "paste this" instruction
after the patch had already gone live — a stale-documentation finding, not a
functional defect.

**ElevenLabs Knowledge Base — per Sana's direct confirmation (2026-08-04, not
independently verified via API by this agent — no ElevenLabs key was present
in that session to pull the Knowledge Base contents):** a "Carson
Constitution" document set (COS 06–22: Reliability Engineering & Protected
Behaviors, Tool Selection Rules, Evidence Before Answer, Production Safety
Rules, Regression Prevention, Historical Lookup Standards, Memory Governance,
Tool Registration Integrity, Production Verification Standards, Engineering
Learning Loop, Open Loop Management, Owner Experience, Autonomy and Decision
Authority, Continuous Improvement, Architectural Integrity, System Evolution,
Truth and Epistemic Governance) has been added to the live ElevenLabs
Knowledge Base. This agent has not seen the Carson Constitution document
itself (no prior record of it in this repo or in Claude memory) and cannot
independently confirm its contents match the safeguards recorded here — this
status reflects Sana's report, not this agent's verification. See
[[carson_constitution]] in Claude memory for the pointer record.

Prior status: **CLOSED — PRODUCTION VERIFIED (2026-08-04).** Three independent root
causes were found and fixed in sequence (see full detail below and the
permanent regression record in Claude memory,
`carson_master_plan.md` → "Appendix: Blue Pen Incident"): (1) `ra7etbal_state`
leaking answerable task descriptions/timestamps, fixed by data minimization
in `carson-context.ts` (Option B); (2) `recent_memory` independently leaking
the same class of unverified operational narrative via saved session recaps,
fixed by a new gate in `carson-epistemic-gate.ts`/`carson-summarize.ts`, plus
13 poisoned `carson_memory` rows identified and deleted; (3) the true final
root cause — `get_commitment_history` was never actually registered as a
callable tool on the live ElevenLabs agent, despite extensive prompt work in
this project's saved backup — fixed by registering the tool via the
ElevenLabs API (`POST /v1/convai/tools`) and patching the live agent's
`tool_ids` and prompt text directly, diffed against the agent's actual live
prompt (not the stale local backup) to avoid disturbing unrelated
independent prompt changes already live there.

**Closing production evidence** (conversation `conv_2401kz4qx1s4errtchfz1afns3gh`,
2026-08-04): `tool_calls` shows `get_commitment_history` invoked twice —
first with `keyword: "blue pen"` (3 candidates, correct disambiguation ask),
then `keyword: "Buy a blue pen"` (correctly resolved to the one real task).
The tool's returned evidence was independently verified against a full
chronological audit of `tasks`/`confirmations`/`staff_escalation_owner_decisions`
for task `d20a48db-1101-4d78-8203-a9d303ba5924` — every event genuinely
belongs to that one task, nothing merged from another candidate. Carson's
spoken answer matched the tool's evidence exactly.

**Final Hardening and Safeguard pass (2026-08-04) — this incident is now the
reference implementation for future Carson tool investigations.** A
regression-coverage audit against the 17 failure scenarios exposed across
this investigation found 14 already covered by existing suites
(`carson-commitment-history.test.ts`: no match, single match, multiple/
ambiguous match, completed task, open/pending task, substitute approval,
proof-photo evidence via the automated quality-review timeline event, owner
decision, delivery-failure and open-escalation caveats; `carson-context.test.ts`:
prompt/`ra7etbal_state` contamination; `carson-epistemic-gate.test.ts` /
`carson-summarize.test.ts`: memory contamination). The remaining 3 — tool
registration missing, tool schema/prompt mismatch, runtime tool
unavailability — had no coverage at all, because they can only be observed
against the live ElevenLabs agent, which is exactly the blind spot that let
root cause #3 reach production undetected. Closed that gap with a new,
additive `audit` subcommand on the existing diagnostic script:
`scripts/carson-diagnose.mjs audit` compares the widget's actual
`clientTools` (parsed from source, not a hand-maintained list), the live
agent's registered `tool_ids`, and the live prompt text, and fails loudly on
any missing, orphaned, or prompt-blind tool. The new
`scripts/carson-diagnose.test.mjs` (4 tests) unit-covers only the
source-extraction half of this (`expectedClientTools()` — deterministic, no
network) since `audit()`'s own comparison/exit-code logic requires a live
ElevenLabs API key and is exercised by running it for real, not mocked. Run by hand — `npm run
carson:diagnose -- audit` with `ELEVENLABS_API_KEY` set — whenever a client
tool changes or Carson's behavior is under investigation again; it is not
wired into CI because no ElevenLabs key is stored anywhere as a project
secret (unchanged from the standing direction below). Full
`npm run test:carson-protected` (46 files) plus the 6 targeted Commitment
History/reliability files re-run clean: 821 passed, 4 skipped, 3 todo,
0 regressions; typecheck passed. No product behavior, prompt, or unrelated
code changed in this pass — regression tests and diagnostic tooling only.
Procedure and decision tree preserved as-is in
`docs/commitment-history-routing-investigation-runbook.md`, now with a
"Permanent reliability monitoring" section documenting the audit command.

**Original investigation detail below, preserved for the record:**

Prior status: **FIX IMPLEMENTED, PR OPEN — NOT YET MERGED OR DEPLOYED** (2026-08-03).
Backend implemented, tested, and merged (PRs #163, #164, #165, #166). Widget
registration and ElevenLabs Tool registration were verified correct; four
rounds of prompt strengthening did not change the observed behavior.

Root cause was proven directly, not inferred: with a read-only
(`convai_read`-scoped) ElevenLabs API key, `scripts/carson-diagnose.mjs`
pulled the actual ElevenLabs conversation record for two independent
"What happened with the blue pen?" test conversations. Both showed **zero
`tool_calls` entries** for the turn in question — the LLM (confirmed
configured model: `claude-sonnet-4-6`, a capable model, ruling out "weak
model" as the explanation) never attempted to call `get_commitment_history`
at all. This is Stage 1 of `docs/commitment-history-routing-investigation-runbook.md`.

Fix (PR #167, branch `fix/carson-context-colocated-commitment-history-warning`):
the `COMPLETED (recent, treat as history only)` header built by
`buildCarsonContext()` in `src/lib/carson-context.ts` now carries the
"never answer from this list, always call get_commitment_history" warning
co-located directly on the data itself — the exact point the model encounters
the tempting match — instead of relying on the separate `COMMITMENT HISTORY`
prompt section (elsewhere in a 500+ line system prompt) to be recalled.
Regression test added in `src/lib/carson-context.test.ts` (line-scoped
assertion that the warning appears on the same line as the COMPLETED header).
Targeted test, full `test:carson-protected` suite (46 files, 821 passed, no
regressions), typecheck, and production build all pass.

**Standing engineering direction (approved 2026-08-03): Carson Reliability
Engineering — permanent ElevenLabs diagnostic access.** This investigation
exposed a permanent gap: backend/Supabase evidence alone cannot always
explain Carson's behavior, because the decision of whether to call a client
tool happens entirely inside ElevenLabs. Going forward, any production
investigation into unexpected Carson behavior should compare all of: what the
owner said, what ElevenLabs heard, what Carson interpreted, what tool was
called, what reached the backend, what was returned, and what Carson finally
said — not reason from backend data alone when ElevenLabs conversation
evidence exists. `scripts/carson-diagnose.mjs` (run via
`npm run carson:diagnose -- list ...` / `... inspect ...`) implements this,
and has now been used successfully with a real `convai_read` key to find this
exact root cause. The key used was provided ad hoc in chat, not stored
anywhere in the repo or as a project secret — a future investigation will
need a new one provisioned the same way.

Remaining: merge PR #167, deploy, then re-pull the ElevenLabs conversation
record for a fresh live "blue pen" test via `carson-diagnose.mjs` to confirm
`tool_calls` is now populated (Stage 1 passes) before closing this out.

What it is: the first capability slice of the frozen Historical Lookup Architecture (Carson's Memory Retrieval Engine) — a read-only voice/typed Carson tool answering "did this commitment ever happen / what's its full story," distinct from the existing Operations Center V1's delivery-status-only question ("did it deliver"). Given a keyword (task description or assigned person's name), resolves the one matching commitment across every task status and archived state (never restricted to active work), then reconstructs its evidence-based lifecycle by merging rows from `tasks`, `confirmations`, `whatsapp_deliveries`, `quality_substitute_decisions`, `reminder_delivery_events` (reminder-type tasks only), and `staff_escalation_owner_decisions` into one chronological timeline.

Ambiguity handling mirrors the existing `act_on_note` convention exactly: zero matches asks the user to clarify, more than one match reads back up to 4 short snippets and asks which one, exactly one match proceeds straight to the answer. Never guesses between plausible candidates.

Conflict resolution: `tasks.status`/`confirmed_at` is the terminal, authoritative record of "is it done" and is never overridden by a downstream event — but a contradicting event is never silently dropped either. Two concrete conflict checks ship in this phase: a task marked done whose most recent WhatsApp delivery attempt failed, and a task marked done with an unanswered owner escalation still open (`staff_escalation_owner_decisions.answered_at IS NULL`). Both surface as an explicit "worth noting" caveat alongside the outcome, never resolved one way or the other by Carson.

Files: `src/lib/carson-commitment-history.ts` (new — resolution, timeline merge, conflict detection, pure answer formatting), `src/lib/carson-commitment-history.test.ts` (new, 17 tests), `src/components/home/ElevenLabsAgentWidget.tsx` (new `get_commitment_history` client tool, wired with the same `guardCurrentToolInvocation`/`runDirectToolWithDiagnostic` pattern as the existing `search_calendar_history`/`get_task_delivery_status`/`get_operations_summary` tools), `src/components/home/ElevenLabsAgentWidget.commitment-history.test.ts` (new, 3 source-text wiring tests matching the existing `.calendar-history.test.ts` convention), `docs/elevenlabs-prompt-patches/2026-08-03-commitment-history.md` (new prompt patch — not yet pasted into the live ElevenLabs dashboard).

Tests: 20 new tests, all passing. Full `npm run test:carson-protected` suite (46 files) re-run clean: 821 passed, 4 skipped, 3 todo — no regressions. Typecheck and production build both pass.

Protect: keep this tool distinct from `get_task_delivery_status` — they answer different question shapes (full lifecycle with outcome/conflict resolution vs. delivery status only) and the prompt patch explicitly routes between them; do not merge them into one tool or let their routing rules blur.

Not done in this phase (deliberately out of scope — see the frozen Historical Lookup Architecture for Q1–Q3, Q5–Q7): person history, topic/keyword recall across free text, time-anchored recall, communication recall, calendar-past recall (already separately shipped as `search_calendar_history`), and aggregate/pattern recall. Each is its own future phase.

**Correction (2026-08-14, Stage 1 Item 3 reconciliation):** the paragraph that previously followed this one ("Remaining before this can move to Stable and protected: prompt patch pasted...") was stale — a leftover from before this section's own PERMANENTLY CLOSED status (above) was reached. All of that was completed and independently production-verified; see the closure evidence at the top of this section.

### Reliability Engineering Incident — Tool Registration Drift (2026-08-04) — FORMALLY CLOSED, PRODUCTION VERIFIED (2026-08-10)

Status: **COMPLETE. PRODUCTION VERIFIED. PROTECTED.** Treated as its own incident, separate from Blue Pen,
surfaced by the same `carson:diagnose -- audit` tool while registering
Historical Lookup Phase 2.

**What was found:** `get_task_delivery_status` and `get_operations_summary`
(Operations Center V1, PR #151, prompt-patched 2026-08-01) were **not
attached** to the live agent's `tool_ids` — both existed as real,
correctly-schemed tool resources with **zero calls, ever**, meaning they
were never actually reachable in production despite the prompt referencing
them and despite `RA7ETBAL_STATE.md` having previously recorded (2026-08-03)
that Sana confirmed them "registered" via the dashboard's Tools tab. That
tab lists every tool resource ever created in the workspace, not what's
attached to this specific agent — the same distinction whose absence caused
the Blue Pen incident. Also found: `list_inbox_items`, `act_on_inbox_item`,
`act_on_update` were attached but orphaned (leftovers from the removed
Clear My Head Inbox feature — confirmed via `ElevenLabsAgentWidget.no-internal-inbox.test.ts`,
which explicitly asserts these must not appear in the widget source). A
fourth widget tool, `control_task`, is also unregistered, but its logic is
reachable through the already-working `execute_instruction` → `resolveVoiceTaskControl()`
path — determined **superseded, not broken**, and left untouched per
explicit decision (separate architectural cleanup, not part of this
incident).

**Fix applied (2026-08-04, via `PATCH /v1/convai/agents/{id}` on `tool_ids`
only — no prompt text touched, since the prompt already correctly
referenced both restored tools):** re-attached the two existing tool
resources (`tool_3501kz43z9q6e2ja2ezygk1v0xg0` for `get_task_delivery_status`,
`tool_4801kz444rpkfpra2wcz1ahb86t6` for `get_operations_summary`) — reused,
not recreated — and detached (not deleted) the three orphaned Inbox tool
IDs. Verified: prompt text byte-for-byte unchanged; all three orphaned tool
resources confirmed to still exist (detached only, not deleted).

**Audit result:** `npm run carson:diagnose -- audit` now reports zero
missing/orphaned tools other than `control_task`, which is expected and
intentional (left unchanged per decision above) — clean for everything in
this incident's actual scope. Full `test:carson-protected` suite re-run
clean: 821 passed, 4 skipped, 3 todo, no regressions (no code changed — this
was an ElevenLabs-side registration fix only).

**Live production verification, round 1 (2026-08-10) — registration confirmed working, but exposed a separate new finding:** Sana asked "Did Christopher get the message?" via Talk to Carson. First attempt: `get_task_delivery_status` was genuinely invoked (confirming the registration fix itself worked) but the tool_result came back `is_error: true`, `error_type: "client_timeout"`, `tool_latency_secs: 1.002` — an ElevenLabs platform-side client-tool response-timeout, not a registration failure. A second, identical attempt seconds later in the same session succeeded and returned real, verified production data. Investigated read-only (see the "Slow task-delivery lookup" entry immediately below) and root-caused to a genuine, always-present inefficiency in `fetchTaskDeliveryStatus` — not a registration problem, so this incident was correctly *not* reopened at the time; the timeout was tracked and fixed as its own separate, narrower item.

**Live production verification, round 2 (2026-08-10, after the fix below) — clean, first call, no retry:** fresh Talk-to-Carson session (`conv_7301kznpz48zfckvgfjtwqmqz08e`, 2026-08-10 11:29:47 UTC), Sana asked "Did Christopher get the message?" as the very first question. Verified via raw ElevenLabs conversation inspection (not the diagnose script's opinionated stage classifier, which isn't built for this exact comparison — the raw transcript was pulled directly): the conversation's only turns before this were a `contextual_update` system call and the greeting — confirming this was genuinely the first `get_task_delivery_status` invocation of the session. Result: `is_error: false`, `error_type` empty, `tool_latency_secs: 0.586` — comfortably under whatever boundary tripped the round-1 failure. Parameters identical both times (`{"keyword": "Christopher"}`). No retry needed. The tool's returned evidence (2 "Coke" tasks read, 1 "buy Coca-Cola Zero" task with a `FAILED — ecosystem engagement` WhatsApp delivery alongside other read deliveries for the same task, 2 more Coca-Cola Zero tasks read) was independently cross-checked against live `tasks`/`whatsapp_deliveries` rows and matched exactly — nothing fabricated. Carson's spoken reply ("the Coke tasks are all showing as read") is truthful for the two literal "Coke" tasks; it didn't verbalize the one FAILED Coca-Cola Zero delivery present in the raw tool result — a conversational-summarization nuance, not a tool/registration defect, not investigated further as out of scope for this incident.

### `get_task_delivery_status` first-call `client_timeout` — FIXED, MERGED, DEPLOYED, PRODUCTION VERIFIED (2026-08-10)

Status: COMPLETE. MERGED. DEPLOYED. PRODUCTION VERIFIED. PROTECTED.

PR #217, merge commit `18ffdb74af15e3625753c5546816bfc6b82819b1`. Found during Tool Registration Drift's own live verification (round 1, above) — a genuinely new, narrower reliability finding, not a reopening of the registration incident.

**Root cause, traced by full execution-path inspection before any code changed:** `fetchTaskDeliveryStatus` (`src/lib/carson-operations-center.ts`) fetched each keyword-matched task's `whatsapp_deliveries` timeline **sequentially inside a `for` loop** — one query awaited at a time, up to 5 extra sequential network round trips on top of the auth check and task query, every single call, first or fiftieth. Confirmed via code inspection: no first-call-specific lazy init, no self-inflicted timeout anywhere in this repo's own code (`guardCurrentToolInvocation`, `runDirectToolWithDiagnostic`, and the function itself are all clean) — the `client_timeout`/empty `raw_error_message` shape on the failing call pointed at an externally-enforced ElevenLabs client-tool response window being exceeded, most plausibly because ordinary cold-connection latency on the first call of a fresh session was enough to tip an already-marginal, unparallelized round-trip count over that boundary. Full investigation, including what was ruled out and why, preserved in the 2026-08-10 session transcript.

**Fix, scoped exactly as approved — nothing broader:** the per-task delivery lookups now run concurrently via `Promise.all` instead of one at a time. Same query per task (identical filter/order/limit), same output text, same task iteration order, same ambiguity/failure handling — only the network round trips changed from sequential to concurrent. Explicitly **not** touched, per scope: `supabase.auth.getUser()` (still called once per invocation, unchanged — a systemic pattern shared by other tools, deliberately left for its own separate review), `get_operations_summary`, Historical Lookup tools (`get_commitment_history`/`get_person_history` — already parallelize their multi-table fetch via `Promise.all`, confirmed lower-risk during the investigation), the shared client-tool wrappers, ElevenLabs configuration, schema/migrations/RPCs.

**Tests:** one new regression test proves task order and per-task delivery matching survive even when the underlying queries resolve out of order (deliberately scrambled resolution timing in the test, since `Promise.all` preserves index correspondence regardless of completion order) — mutation-tested by temporarily breaking the index mapping and confirming the test failed, then reverting. 16/16 tests in `carson-operations-center.test.ts`, full `test:carson-protected` (54 files, 1028 passed), typecheck, and build all clean. Zero CodeRabbit findings.

**Production deployment:** SHA-matched to the merge commit for both `ra7etbal-v2` and `ra7etbal-work` Vercel projects, `www.ra7etbal.com` HTTP 200, `ra7etbal.com` redirects correctly, zero new runtime error groups.

**Live production verification (round 2 of the Tool Registration Drift entry above, 2026-08-10):** a fresh Talk-to-Carson session's first `get_task_delivery_status` call succeeded in `0.586s` with no error and no retry, verified against the raw ElevenLabs conversation record and cross-checked against real production delivery data — see that entry for the full evidence.

**Known limitation, honestly recorded, not fixed here:** this class of defect (a first-call platform response-timeout) fundamentally cannot be regression-tested under this codebase's existing mock-based unit tests, which resolve Supabase calls instantly — only a real live conversation can confirm it. `get_operations_summary` shares the same uncached `auth.getUser()` pattern (3 sequential round trips, lower risk than this tool's prior up-to-7) and was **not** fixed here — explicitly out of this task's approved scope, tracked as a possible future item, not started.

Protect: the `Promise.all`-based concurrent per-task delivery lookup — do not reintroduce a sequential loop here. Do not extend this fix to `auth.getUser()` or any other tool without a separate, explicitly-scoped task.

### `get_operations_summary` first-call reliability — FIXED, MERGED, DEPLOYED, PRODUCTION VERIFIED (2026-08-11)

Status: COMPLETE. MERGED. DEPLOYED. PRODUCTION VERIFIED. PROTECTED.

PR #223, merge commit `d19ee6e293dee9d1a8a02745e468f38a129fcf8c`. Closes the gap explicitly left open by the `get_task_delivery_status` fix above: `get_operations_summary` shared the same at-risk shape (`auth.getUser()` → a WhatsApp-failures query → a reminder-issues query, three sequential round trips) that caused that tool's confirmed first-call `client_timeout`.

**Duplicate-effort note:** a second, independent implementation of the same fix (`fix/operations-summary-concurrent-queries`, PR #224) was built in a separate session in parallel and reconciled against #223 before either merged. #223 was found to be a strict superset — it additionally captures `auth.getUser()`'s own `error` field (not just a null-user check) and wraps the whole function in a `try/catch` so a thrown/rejected query, not just an `{error}`-shaped result, still returns a truthful message — and was already wired into `test:carson-protected`. PR #224 was closed without merging; no part of it shipped.

**Fix:** the two independent post-auth reads (WhatsApp-failures, reminder-issues) now run concurrently via `Promise.all`, mirroring PR #217's proven pattern. Preserved unchanged: the reminder-issues query's `user_id` ownership filter; the WhatsApp-failures query's reliance on `whatsapp_deliveries`' existing RLS policy (`auth.uid() = user_id`, confirmed live via `pg_policies` before this work started) for cross-household isolation; `fetchTaskDeliveryStatus` (same file, untouched); the `get_operations_summary` ElevenLabs tool wiring and prompt (untouched, not required). Truthfulness hardened beyond the pre-existing code: neither query previously captured Supabase's `error` field at all, so a genuine query failure silently rendered as a false-healthy "No WhatsApp delivery failures..."/"No reminder delivery issues..." line — now every failure path (auth error, either query erroring, or an unexpected exception) returns a truthful "couldn't load the operations summary" message instead, only on what was previously a silent failure path; no successful-call output changed.

**Tests:** `src/lib/carson-operations-summary-reliability.test.ts` (new, 5 tests) — concurrent-not-sequential execution (both reads start before either resolves), auth gating and the ownership filter preserved, a query failure never produces a false-healthy summary, auth/rejected-query failures reported truthfully, successful summary meaning preserved with exactly one call per source (no duplicate/retry). Wired into `npm run test:carson-protected`. Full suite re-run on current `origin/main` post-merge: 55 files, 1033 passed, 4 skipped, 3 todo — clean, no regressions.

**Production deployment:** `dpl_ACUULoMFrdPGsYDBxXKjcvnPzxQp` (project `ra7etbal-v2`), `state`/`readyState: READY`, `target: production`, `meta.githubCommitSha` matches the merge commit exactly.

**Live production verification (2026-08-11, ~01:50 Europe/Istanbul):** Sana asked Talk to Carson "Is everything working, Carson?" — conversation `conv_7901kzpxybe9esjbrfv5csfw3msh`. Verified directly from the ElevenLabs dashboard transcript (screenshots; the API-based `carson-diagnose.mjs` path was unavailable this session — no `ELEVENLABS_API_KEY` provisioned, and the dashboard's own conversation-detail view was separately confirmed stuck/unusable before the transcript became viewable): exactly one `get_operations_summary` tool-call chip, status `Succeeded`, tool latency `684 ms` — comfortably first-call-successful, no `client_timeout`, no visible retry or second invocation for this turn. Carson's reply: *"WhatsApp is clean — no delivery failures. Two reminders are unconfirmed: the push notification test and the PWA notification test."* Cross-checked directly against authoritative production Supabase data (project `ggarvhgqzpooloacjgcj`) for the same 48-hour window: zero `whatsapp_deliveries` rows with `delivery_status = 'failed'`; exactly two `tasks` rows with `type = 'reminder'` and `reminder_delivery_status = 'delivery_unconfirmed'` ("Check the push notification test", "check the PWA notification test"), both on Sana's account (`645ddb96-6e09-4d91-b650-cbc75bac9a5d`) — an exact match, nothing invented, nothing omitted.

**Evidence honestly scoped:** the tool's literal raw return string (the exact `"OPERATIONS SUMMARY (live):\n..."` text) was not directly viewed in an expanded raw-output panel — the dashboard screenshots show the succeeded status, latency, and Carson's spoken/rendered synthesis of it, not the raw string itself. Its content is inferred with high confidence from `fetchOperationsSummary`'s deterministic, already-reviewed formatting logic combined with the exact-match Supabase cross-check above, not from direct observation of the raw payload. This is recorded as an inference, not claimed as a literal observation.

Protect: the `Promise.all` concurrent-read shape; the `auth.getUser()` error check and the outer `try/catch`; the reminder-issues query's `user_id` filter; reliance on `whatsapp_deliveries`' RLS policy rather than an app-code filter for that query. Do not reintroduce a sequential-await version. Do not build a second implementation of this fix — reuse this one.

### Historical Lookup — Phase 2, Person History — FORMALLY CLOSED, PRODUCTION VERIFIED (2026-08-10)

Status: **COMPLETE. PRODUCTION VERIFIED. PROTECTED.** Second capability slice of the frozen Historical Lookup Architecture,
directly extending Phase 1 (Commitment History) rather than redesigning it.

**Closure required three rounds of live production verification, not one — a real correctness defect was found and fixed along the way. Full sequence:**

**Round 1 (2026-08-10):** Sana asked "What has Christopher been working on?" via a fresh Talk-to-Carson session. `get_person_history` was genuinely invoked, succeeded, no timeout — but the returned answer was **"6 commitments for Christopher: 6 done."** Cross-checked against unrestricted production data: Christopher genuinely has 40+ tasks at that time, not 6. Every individual fact in the tool's output was real and correctly summarized, but the aggregate was a truncated sample presented as a total — a confirmed Phase 2 correctness defect, not a registration or reliability problem. **Root cause:** `lookupPersonHistory` computed its outcome-count summary from the same `candidates` array `findCommitmentCandidates()` returns for Phase 1's task-keyword disambiguation, which is deliberately capped at `.limit(6)` — correct for "which one do you mean" (Phase 1), silently wrong for a person-overview total (Phase 2), since the two use cases were sharing one capped array.

**Fix, PR #219 (merge `2dcd77b260f91d794aae2319ca060b1a94daf16a`), scoped exactly to `lookupPersonHistory`:** `findCommitmentCandidates()` and its `.limit(6)` are completely untouched — still used for the single-match check and the bounded recent-items list, exactly as before, and Phase 1's own test suite required zero changes. A new, separate, unbounded `fetchPersonOutcomeCounts()` (same person/user filter, but selecting only `status`/`dismissed_at`, not full task rows — checked against production: `tasks` has no supporting index and already does an unindexed scan for the existing capped query at 233 total rows platform-wide, so a second unlimited query with the same shape is a negligible marginal cost at this scale) computes the true aggregate. Output text now explicitly separates total from recent: `"<name> total: N commitments (...). M most recent: ..."`. A CodeRabbit review round caught one further real issue pre-merge — the new unbounded query returning `[]` on a genuine error was indistinguishable from a real empty result, which could have produced a false "0 commitments" claim sitting directly next to a real, non-empty recent-items list; fixed by returning `null` on error and having the caller state a truthful "couldn't get an accurate total" message instead, with a dedicated regression test. 3 new tests total (>6-task total correctness, exactly-6-task total via the new path not the old cap, query-failure truthfulness), mutation-tested. No schema/RPC/ElevenLabs config change — the live prompt patch already said "report exactly as returned" with no hardcoded format dependency, so no dashboard re-patch was needed.

**Round 2 (2026-08-10, after the fix deployed):** fresh Talk-to-Carson session, same question about Christopher. Result: `is_error: false`, no retry, and the raw tool result already showed the new format live: `"Christopher total: 51 commitments (49 done, 2 pending). 3 most recent: ..."`. Cross-checked against unrestricted production data — exact match: 51 total / 49 done / 2 pending, the 3 recent examples genuinely the 3 most-recently-created matching rows, all three genuinely confirmed August 6. Carson's spoken answer ("51 commitments total, 49 done... Two tasks are still pending") was fully grounded, correctly distinguishing total from recent examples, no fabrication, no material misstatement found.

Both live conversations independently verified via raw ElevenLabs conversation inspection (not just the diagnose script's opinionated stage classifier — the raw transcript was pulled directly both times) and cross-checked against production Supabase, not trusted at face value.

What it is: given a person's name, summarizes their overall commitment
history — outcome counts plus the most recent items — instead of resolving
one specific commitment. `findCommitmentCandidates()` (Phase 1) already
matches on `assigned_to`, so a bare person-name query already returned their
tasks before this phase; the actual gap was that Phase 1's multi-match
behavior ("which one do you mean") is the wrong shape for a person query,
which naturally returns many results. A single match still gets Phase 1's
identical full evidence-based answer — reused, not reimplemented.

Files: `src/lib/carson-commitment-history.ts` (new `lookupPersonHistory()` +
`summarizePersonOutcomes()`, appended — zero modification to any existing
Phase 1 function), `src/lib/carson-commitment-history.test.ts` (6 new
tests), `src/components/home/ElevenLabsAgentWidget.tsx` (new
`get_person_history` client tool, wired identically to
`get_commitment_history`), `src/components/home/ElevenLabsAgentWidget.person-history.test.ts`
(new, 3 wiring tests), `docs/elevenlabs-prompt-patches/2026-08-04-person-history.md`
(new prompt patch — **PENDING**, not yet applied).

Tests: 9 new tests, all passing. Full `npm run test:carson-protected` suite
(46 files) re-run clean: 821 passed, 4 skipped, 3 todo — no regression to
Commitment History, tool registration, memory governance, the epistemic
gate, or any other protected behavior. Typecheck and production build both
pass. Deployed to production via PR #174 (squash commit
`22507ad6d02ade83692c1bc068b2719422605c5c`).

**Completion checklist (per Sana's 2026-08-04 "Production Completion"
directive) — all 6 steps done:** tool registered on the live ElevenLabs
agent (2026-08-04); prompt patch applied and diffed byte-for-byte against
the live prompt; `carson:diagnose -- audit` clean for `get_person_history`
specifically; step 5 (one real production conversation) completed
2026-08-10 — see the round 1/2 verification above; step 6 (this closure)
complete.

**Unrelated finding surfaced by an earlier audit run — SUPERSEDED, now
resolved as its own separate incident.** This originally reported
`control_task`, `get_task_delivery_status`, and `get_operations_summary` as
all unregistered, plus 3 orphaned Inbox tools, all left untouched pending
investigation. That investigation is now complete and the fix applied — see
"Reliability Engineering Incident — Tool Registration Drift (2026-08-04)"
above. Current state: `get_task_delivery_status` and `get_operations_summary`
are re-attached (reusing their existing tool resources) and the 3 orphaned
Inbox tools are detached. `control_task` remains intentionally unregistered
— determined superseded by the working `execute_instruction` path, not
broken, and left as its own separate future cleanup item. None of this
touched Person History's own code or registration.

**Also fixed as part of this work:** `scripts/carson-diagnose.mjs`'s own
`audit` command had a real bug — it tried to match the live agent's inline
`prompt.tools` array back to `tool_ids` by an `.id`/`.tool_id` field that
doesn't exist on inline entries, silently failed to match anything, and
resolved every tool twice (a live run reported 42 registered tools instead
of the actual 21/22, with every orphan listed twice). Fixed by zipping the
two parallel arrays by index instead (PR #177); 4 new regression tests
added.

Protect: keep `get_person_history` distinct from `get_commitment_history` —
same convention as `get_commitment_history` vs. `get_task_delivery_status` —
do not merge them or let their routing rules blur. `findCommitmentCandidates()`'s
`.limit(6)` — shared with Phase 1, do not reuse its capped result for any
future aggregate/total computation. `fetchPersonOutcomeCounts()`'s
null-on-error contract — never let a query failure produce a false zero
count next to a real recent-items list.

### Transport-independent staff communication engine (Issue #46)

Status: implemented, merged (PR #47, merge commit `e7a8e56c59b27f6f3857d68c0a2ec3b825ac5353`), deployed to production (`www.ra7etbal.com`). No live production UI testing performed (per task scope — this was a backend engine with a focused test harness, not a UI change).

What it is: a canonical, transport-independent pipeline that lets a staff member's message be classified, answered directly or escalated, and persisted — without ElevenLabs or WhatsApp, both currently blocked/unavailable transports. There is still only one Carson: this is the first place Carson's staff-facing reasoning runs as a direct Claude call rather than only inside the ElevenLabs dashboard-configured agent (see `api/_carson-agent-turn.js`, an existing read-only PoC that tunnels into ElevenLabs — untouched, not reused, since it depends on the currently-blocked transport). Any future transport (WhatsApp inbound, a rebuilt ElevenLabs bridge) must call through this same module.

Schema: new table `public.staff_messages` (migration `supabase/migrations/20260720_create_staff_messages.sql`), with four `SECURITY DEFINER` functions as the only insert/update path: `claim_staff_message` (atomically verifies person_id/task_id belong to the caller's user_id and that the sender is not `is_family`, idempotent on `(user_id, source, external_message_id)`), `complete_staff_message` (claimed → completed, idempotent no-op if already completed), `fail_staff_message` (claimed → failed), `retry_staff_message` (failed → claimed, explicit recovery only, returns `is_retried` so callers can't double-process a losing race). RLS: owner-only `SELECT`; `EXECUTE` on all four functions revoked from `PUBLIC`/`anon`/`authenticated`, granted only to `service_role`. Applied to the live Supabase project (`ggarvhgqzpooloacjgcj`) and verified with temporary fixtures (cross-household rejection, family exclusion, idempotency including source-scoping, full claimed/completed/failed/retried state machine, person-deletion history preservation) — all fixtures fully cleaned up, zero residue, confirmed by count query.

Application layer: `api/_staff-comms-engine.js` (`processStaffMessage`), underscore-prefixed so it doesn't count against the Hobby 12-function cap. Loads person/task/household-rules/recent-memory context scoped by `user_id`, calls Claude directly (`claude-sonnet-4-6`, same pattern as `api/_quality-review.js`) with a narrow staff-reply system prompt, strictly re-validates the model's JSON output against the DB's own enums before trusting it, and never writes to `public.tasks` — a `completion_confirmation` classification only marks the staff *message* `Completed`, never the underlying task (that stays exclusively inside the protected `api/task-confirm.js` proof/confirmation pipeline).

Test interface: `api/_staff-comms-engine.test.js`, 12 focused Vitest tests (all passing) covering the 8 scenarios from issue #46 plus Claude-failure handling and pure-function edge cases — the preferred "focused test harness" option per the issue, so no new API route or Hobby-cap slot was used.

Independent review (separate agent, `review:bug-hunter`): 0 critical/high/medium findings across second-Carson risk, cross-household leakage, idempotency, false completion, accidental ElevenLabs/WhatsApp changes, and test-meaningfulness (2 findings mutation-tested to confirm the tests actually fail without the implementation). One Low/nit, not a blocker: if `fail_staff_message` itself throws inside the outer catch block's nested try/catch, the row is left silently stuck in `claimed` with no distinguishing signal — logged at the same level as normal errors. Left as a documented follow-up, not fixed in this task (narrow, pre-existing-shape gap, not a regression risk to protected behavior).

Remaining for issue #46 at the time this section was written: wiring an actual transport to call `processStaffMessage`, and owner-facing UI surfacing of escalations. **Update:** the WhatsApp inbound transport is now wired — see "Phase B — staff-to-owner escalation loop" below, PROTECTED and CLOSED. Owner-facing UI surfacing of escalations (Phase C) and routing that answer back to staff (Phase D) were both later implemented and merged — see those sections below (**corrected 2026-08-10** — this line previously said they "remain not implemented," which is stale).

Protect: this table/module design must not be duplicated by a future transport integration — reuse `processStaffMessage`, do not build a second reasoning path.

### Owner visibility for staff communications V1 — SUPERSEDED, REMOVED FROM NAVIGATION (historical record)

Status: **corrected 2026-08-10 — this section previously read as "implemented, not yet merged" and described the Staff tab as current behavior; both were stale.** Ground truth: merged as PR #48 (`524ac6c76240a4d31e5a4e04f8fece31abb3c7c5`, "Add read-only owner visibility for staff communications (V1)") on 2026-07-20, then the Staff tab itself was **explicitly removed from owner-facing navigation** by PR #76 (`8906ffa89b5627037423ad73dd82db89dc4789dc`, "feat: remove Staff tab from owner-facing navigation") on 2026-07-25. Confirmed against current code: `src/routes/Updates.tsx` has no Staff tab, no `tab=staff` route, and no reference to `StaffUpdates`. `src/routes/StaffUpdates.tsx` and `src/lib/staff-messages.ts`'s `listStaffMessages()`/`getStaffMessageDisplayState()` still exist in the repo but `StaffUpdates.tsx` is not imported by any route — dead code, not reachable from the app UI. **Do not describe the Staff tab as live or reachable.** Owner-facing visibility into staff escalations now happens exclusively through the Needs You surfaces built by Phase B/C (see "Phase B — staff-to-owner escalation loop" and "Phase C — Needs You visibility + read-only owner-decision page" above) — `staff-messages.ts`'s other exports (`listOpenStaffEscalationsForNeedsYou`, `getOwnerEscalationByToken`) remain live and in use there, only the standalone tab UI was removed.

**Historical implementation record, preserved as-is (describes the removed tab as it existed 2026-07-20–07-25, not current behavior):**

What it was: a read-only "Staff" tab added to the existing Updates screen (`src/routes/Updates.tsx`, the same tab bar that already hosts Needs You / Waiting / To-do / Notes / Automations / History), showing every `staff_messages` row the owner is allowed to see: staff name, their message, Carson's response (when present), the current state (Waiting / Needs You / Completed / In Progress), who owns the next action, the exact decision needed (when `owner_attention_required` is true), when the message arrived, and linked task context when available. No reply, approve/reject, or outbound-messaging controls — display only.

UI location (historical, no longer reachable): `/updates?tab=staff`.

Files: `src/types/staff-message.ts` (new type), `src/lib/staff-messages.ts` (new — `listStaffMessages()`, RLS-only, no manual `user_id` filter, same anon-key `supabase` client as `messages.ts`/`people.ts`/`tasks.ts`; `getStaffMessageDisplayState()` implementing the exact Needs-You-if-either-signal-is-true rule from the spec, nothing invented), `src/routes/StaffUpdates.tsx` (new — a stateful data-fetching wrapper plus pure, hook-free `StaffUpdatesView`/`StaffMessageCard` exports so rendering logic is unit-testable without a DOM/testing-library dependency), `src/routes/Updates.tsx` (edited — one new tab entry + one new conditional render block, mirroring how To-do/Notes/Automations already render as self-contained `headerless` components). Card styling reuses `TaskCard.tsx`'s existing badge language (`rounded-full border ... text-[10px] font-medium uppercase tracking-wide`, rose/amber/sky/emerald semantics) rather than inventing new visual language. No schema change, no new dependency, no new state-management layer (plain `useState`/`useEffect`, matching `Inbox.tsx`'s existing pattern for a self-contained tab).

Internal fields (`processing_status`, `processing_error`, `external_message_id`, `user_id`, `person_id`, `thread_id`, `source`, raw row `id`) are never selected by the query and never rendered — `id` is used only as a React list key.

Tests: `src/lib/staff-messages.test.ts` (6) + `src/routes/StaffUpdates.test.tsx` (14) — the 10 scenarios required by this task (empty state, Needs You with escalation reason, Waiting with next-action-owner, Completed label, Carson response shown/omitted safely, linked task context shown/omitted safely, internal fields never rendered, fetch error contained without breaking the parent screen, no cross-household filter surface). Plus `src/routes/Updates.test.ts`'s pre-existing 6-tab regression guard updated to 7 tabs (this branch's own change legitimately added the 7th; the guard now protects against an 8th being silently added). 34/34 passing. Typecheck and production build both clean.

Independent review (separate agent, `review:bug-hunter`, mutation-tested): zero write paths, zero service_role reference, zero cross-household exposure surface, zero duplication of `daily-brief.ts`/`needs-you-timestamp.ts` logic, zero internal-field leakage — all confirmed via mutation testing (introducing each failure mode and confirming the relevant test catches it, then reverting). One High finding (the stale 6-tab regression-guard test) — fixed before delivery.

Known limitation (historical, at the time this was live): no live transport (WhatsApp/ElevenLabs) calls `processStaffMessage()` yet, so this tab was expected to show its empty state ("No staff messages need your attention.") until a transport was wired.

Historical protect note (no longer applicable now that the tab is removed): this was a read-only view; no write/reply/approve controls were ever added.

### Typed Carson delegation execution regression fix — MERGED, PROTECTED

Status: **corrected 2026-08-10 — previously read "implemented. Not yet merged"; stale.** Merged as PR #30 (`0f43b823dac4dc9909d9fc9ef88c51ea62523cca`, "Fix Type to Carson silently skipping simple delegations"), 2026-07-18. Confirmed live: `executeDelegationFastPath` is imported and called from `ElevenLabsAgentWidget.tsx`'s typed-turn path exactly as described below. Treat as merged and protected.

Confirmed production regression: Talk to Carson (voice) executes both direct messages and delegations correctly. Type to Carson executed direct messages correctly but silently failed simple delegations — "Ask Ghulam to bring the car out." made Carson reply "Ghulam has it" with no real delegation row and no WhatsApp task sent.

Root cause: Type to Carson's tool-calling path depends entirely on the ElevenLabs text model choosing to invoke `send_delegation`/`execute_instruction`. For simple single-person delegation wording, the model could return a natural-language reply without calling any tool, so `executeDelegationFastPath` (already used for voice) never ran. The deterministic direct-message path had no equivalent gap because typed direct-message wording reliably triggers a tool call; delegation wording did not.

Fix: `sendTypedMessage` in `ElevenLabsAgentWidget.tsx` now runs the existing, unmodified `executeDelegationFastPath` + `sendDelegation` deterministically for a fresh typed owner turn, immediately before the instruction would otherwise be sent to ElevenLabs — same executor, same task creation, same `ra7etbal_task_v3` WhatsApp delivery and confirmation-link path as voice. Excluded (falls through to the existing model-driven flow unchanged): pending photo, recurring language, instructions matching the protected direct-message grammar (`parseSimpleDirectMessage`), and multi-person/personal-note/ambiguous wording (already excluded by `parseDelegationFastPath` itself). No second delegation implementation was created.

Focused tests passed: 9 new (`ElevenLabsAgentWidget.typed-delegation-execution.test.ts`) + 25 existing `delegation-fast-path.test.ts` + 18 existing `ElevenLabsAgentWidget.typed-mode.test.ts` + 3 existing `ElevenLabsAgentWidget.direct-message-parity.test.ts` + 27 existing `direct-message-fast-path.test.ts` = 82/82. Typecheck passed. Build passed. Full suite not re-run per this task's narrow scope.

Protect: Talk to Carson / voice tool routing (untouched), the protected direct-message baseline from PR #29 (`ra7etbal_direct_operational_message`, two-parameter payload, `en` language — untouched), `ra7etbal_task_v3` and all WhatsApp template mappings (untouched), typed owner-reference normalization from PR #25 (untouched).

### Direct-message WhatsApp template routing fix — MERGED, PROTECTED

Status: **corrected 2026-08-10 — previously read "implemented (third attempt). Not yet merged"; stale.** Merged as PR #29 (`c0486e5ebcd26595a794ffeef55f42f72ca9e98f`, "Fix direct-message WhatsApp template to send the required two body parameters"), 2026-07-17 — after the #26/#27/#28 attempts described below. Confirmed live: `buildDirectMessagePayload` exists and is called in `send-whatsapp-task.js` exactly as described below. The "before merging, confirm the template is approved" caveat below is now historical — this has been live in production for weeks. Treat as merged and protected.

History: PR #26 first split direct messages onto `ra7etbal_direct_operational_message` but sent only one body parameter, causing Meta error 132000 (wrong parameter count) — messages were accepted then asynchronously marked failed. PR #27 tried an `en_US` → `en` language fix; Meta still rejected with error 132001 because the payload shape was still wrong. PR #28 fully reverted #26 and #27 back to the shared routine-template path (`ra7etbal_routine_message` for both routine and direct messages) to restore delivery, at the cost of reintroducing the original template-mismatch bug for direct messages.

Root cause, confirmed against the approved Meta Utility template preview: the direct-message template body is `Operational update from {{1}}:\n\n{{2}}\n\nThank you.` — it requires **two** body parameters (`ownerName`, `messageText`), not one. `send-whatsapp-task.js` now gives `direct_message` a fully isolated branch (separate from `routine_message`, no shared code path) with its own template name (`WHATSAPP_DIRECT_MESSAGE_TEMPLATE || 'ra7etbal_direct_operational_message'`), own language (`WHATSAPP_DIRECT_MESSAGE_TEMPLATE_LANGUAGE || 'en'`), and a dedicated `buildDirectMessagePayload` builder sending exactly `[{ type: 'text', text: ownerName }, { type: 'text', text: messageText }]`. Routine messages are untouched — same template, same language default (`en_US`), same one-parameter payload via `buildRoutineMessagePayload`.

Focused tests passed (`send-whatsapp-task.test.js` 21/21, relevant direct-message/escalation/webhook tests 201/201). Typecheck passed. Build passed. Full suite not re-run for this narrow fix per task scope — no shared infrastructure changed beyond the isolated direct-message branch.

Protect: task/delegation templates, owner-decision template, reminder/automation delivery, typed message normalization (PR #25), and the routine-message template/payload (byte-for-byte unchanged).

**Before merging, confirm with Sana / Meta Business Manager that `ra7etbal_direct_operational_message` is approved and live with exactly this two-parameter body** — a correct payload shape still fails if the template itself isn't approved yet.

### Typed direct-message owner-reference normalization — MERGED, PROTECTED

Status: **corrected 2026-08-10 — previously read "implemented. Not yet merged"; stale.** Merged as PR #25 (`d90aa2aada1d08a94df18bbe35466a1dfcbe7999`, "Add typed/voice direct-message owner-reference normalization"), 2026-07-17. Confirmed live: `normalizeFirstPersonForOwner` exists in `src/lib/direct-message-owner-normalization.ts` and is referenced by name as an already-protected, untouched dependency in several later entries in this file (e.g. the "Typed Carson delegation execution regression fix" and "Direct-message WhatsApp template routing fix" entries above). Treat as merged and protected.

Focused tests passed. Typecheck passed. Build passed. Full suite: 1509/1510, with one confirmed pre-existing unrelated failure in `canonical-paths.test.ts` (hardcoded `CANONICAL_CONFIRMATION_ORIGIN`, not caused by this change).

Output does not invent a gendered pronoun: "Tell Grace I'm on my way." sends "Sana is on the way."

Typed Carson's direct-message fast path (`direct-message-fast-path.ts`) now rewrites a leading first-person subject in the message body to the owner's display name before sending, via a new `normalizeFirstPersonForOwner` utility (`direct-message-owner-normalization.ts`), so "Tell Grace I have no Wi-Fi." sends "Sana has no Wi-Fi." to the worker — matching voice Carson's natural third-person phrasing. Gated by a new opt-in `normalizeOwnerReference` flag on `executeDirectMessageFastPath`'s context, set only from the typed call site in `ElevenLabsAgentWidget.tsx` (`activeChannelRef.current === "text"`). Voice's own `send_direct_whatsapp_message` tool composes its own text and is untouched.

Protect: voice behavior, delegation routing, the parser's (`parseSimpleDirectMessage`) unnormalized output contract.

### Meta rejection may still report success — reclassified UNVERIFIED / NOT CURRENTLY REPRODUCIBLE (2026-08-09)

Status: **downgraded from "confirmed" — no supporting trace, date, or reproduction was ever attached to the original entry. A full investigation found no code defect, and found the correct global truthfulness rule already present in the last synced live-prompt backup (freshness of that backup against the current live dashboard is unconfirmed — see below).** Do not describe this as a confirmed active defect. Do not fold a fix into unrelated work.

**End-to-end trace performed** (voice `send_direct_whatsapp_message` tool, voice/typed `execute_instruction` → `executeDirectMessageFastPath`, and the separate inbound-owner-WhatsApp-command channel `_owner-command-executor.js`'s `executePersonCommand`/`persistAndExecuteOwnerCommand`, which is **not** gated by the frontend `TYPED_MODE_IS_ADVISORY_ONLY` constant and was missed in the first pass of this investigation): every path correctly propagates a truthful failure string on a Meta synchronous rejection. `send-whatsapp-task.js`'s `sendMetaMessage` requires both HTTP success and a real message id (`ok: response.ok && Boolean(messageId)`); `whatsapp_deliveries`/`messages` are never marked accepted/sent outside the success branch.

**Effective runtime voice prompt traced**, correcting an initial wrong conclusion: `CARSON_STATUS_POLICY` + `CARSON_VOICE_SESSION_GUARD` + `hostingToolPolicy` (repo constants, `ElevenLabsAgentWidget.tsx:5641-5647`) are joined and injected into the live ElevenLabs session via `dynamicVariables.persistent_instructions`, landing in the dashboard prompt's own `{{persistent_instructions}}` placeholder — they supplement the dashboard prompt, they don't replace or compete with it. Per the maintained live-prompt backup (memory `carson-live-prompt`, last synced 2026-08-03 — **not independently re-verified against the live ElevenLabs dashboard this session; no `ELEVENLABS_API_KEY` available**), the dashboard prompt already contains a global `TOOL TRUTHFULNESS` section applying to "any action tool," including the exact sentence "Speak the tool's returned text as the reply for any action tool — do not add commentary beyond it," plus explicit failure-language instructions. **Prompt freshness (whether the live dashboard still matches this backup) is unconfirmed, not assumed current.**

**Controlled production verification performed (2026-08-09), zero database footprint:** `POST /api/send-whatsapp-task` with a synthetically malformed-but-locally-valid phone number (`10000000000`), no `messageRecordId`/`taskId`/`routineId`/`automationRunId`/`sourceType`/`sendMode`/`imagePath` — no People record created or modified, no real recipient contacted. Meta rejected synchronously: `(#131009) Parameter value is not valid: The phone number is malformed`. Server response: HTTP 400, `success: false`, `delivery_id: null`, full truthful `metaError`/`metaResponse` echoed back — no success-shaped field anywhere. Confirmed via direct query that zero rows were written to `whatsapp_deliveries` or `messages` in the test window — by design: `beginWhatsappDelivery` requires a trusted owner context resolved from a real `messageRecordId`/`taskId`/`routineId`/`automationRunId`/`staffMessageId`; with none supplied, it logs `"skipped: no trusted owner context"` and returns `null` rather than ever writing a row, and every downstream `markWhatsappDeliveryFailed` call safely no-ops on a `null` deliveryId (`patchDeliveryFailOpen`). This test only exercises the deterministic server-side boundary — it does not and cannot verify voice/model behavior, which requires a real ElevenLabs conversation.

**Current findings:**
- Deterministic server-side code is truthful for the no-trusted-owner-context path (now directly verified against production, not just read): synchronous Meta rejection returned `success:false`, and no message was marked sent anywhere.
- Database semantics were verified only for the no-trusted-owner-context skip path exercised by this test — `beginWhatsappDelivery` returned `null` and no row was written or updated. The trusted-owner-context branch (a real `deliveryId` transitioning to `failed` via `markWhatsappDeliveryFailed`'s PATCH) was read in code during the earlier investigation but not exercised by this live test — do not claim database semantics are generally verified until a controlled request with a trusted owner context is run and its persisted failure state is directly asserted.
- Inbound-owner-WhatsApp acknowledgements are deterministic text, not LLM-paraphrased — no model-adherence risk on that channel.
- Per the 2026-08-03 `carson-live-prompt` memory backup only — not independently re-verified against the live ElevenLabs dashboard — that backup contains a global `TOOL TRUTHFULNESS` rule covering this exact case. This is not a claim about the live prompt's current behavior; live prompt freshness remains unconfirmed.
- **No current reproduction of the alleged false-success behavior exists.** The only remaining theoretical risk is ordinary LLM non-adherence to an already-correct instruction (per the backup) — not a confirmed code or prompt gap.
- There is no present evidence justifying another prompt patch. Do not add a `send_direct_whatsapp_message`-specific rule to `CARSON_VOICE_SESSION_GUARD` — it would be redundant against the backup's existing global rule.

**If this is reopened:** requires either a fresh, independently-verified live-prompt pull (needs `ELEVENLABS_API_KEY`) confirming divergence from the 2026-08-03 backup, or a reproduced real voice conversation where the tool result was a failure string and Carson's spoken reply was success-shaped, inspected via `carson-diagnose.mjs inspect`.

### WhatsApp production log redaction — COMPLETE, PRODUCTION VERIFIED (2026-08-09)

Status: COMPLETE. Merged as PR #201, final merge commit `e5919a28ae8bfcb92efd056ca47467a51de7fadc`. Follow-up to the plaintext-logging gap flagged during PR #196 review (`send-whatsapp-task.js`'s shared Meta-request logging included `payload.to`/`payload.text.body` in plaintext) and left out of scope there.

**Scope:** audited every production-reachable WhatsApp send/webhook console log for plaintext phone numbers, message text, or raw payloads. Fixed:
- `send-whatsapp-task.js`: `sendMetaMessage`'s request/accepted logs dumped the full Meta payload. `logSendAttempt` already computed redacted `bodyParameterCount`/`buttonParameterCount` but then also logged the full raw payload underneath, undoing its own redaction. New `redactMetaPayloadForLog()` strips `to` and body/button parameter text down to counts (logging only — the real payload sent to Meta is untouched); the redundant raw-payload field in `logSendAttempt` was removed.
- `task-confirm.js`: `logOwnerDecisionMetaPayloadAudit` already redacted `to` but logged the owner-decision message and confirmation-link button text twice in full (once as `bodyParameter.text`, again inside the nominally "sanitized" payload's unredacted components). Both reduced to `textLength`/`parameterCount`.
- `whatsapp-webhook.js`: four inbound-consent-reply logs included the sender's real phone number in plaintext (one also a 50-char raw body preview).

**Deliberately not touched:** `recipientName`/`ownerName` fields (household member/staff display names, not phone numbers or message content — already visible throughout the app UI to the account owner who reads these logs, and load-bearing for matching a delivery complaint to a specific recipient during debugging); `_owner-command-executor.js`, `_staff-decision-message.js`, `_personal-contact-reply.js`, `_owner-whatsapp-routing.js`, `_escalation-notify.js` (audited, no phone/message-body logging found); Meta's own response body in `sendMetaMessage` (echoes message IDs/status, not sent content); WhatsApp delivery behavior, routing, retries, or correlation — logging only.

**Tests:** targeted (`send-whatsapp-task.test.js`, `whatsapp-webhook.test.js`, `task-confirm.test.js`) 198/198 passing — one existing assertion updated to match the new redacted log shape, plus new negative assertions that the raw owner-decision message text never appears in the log line. Full `npm run test:carson-protected`: 54/54 files, 1018/1018 tests, zero regressions. Typecheck and production build both clean.

**Production verification:** deployment `dpl_2BLj6E7sZC6KmM8Ajqh3dkdmb9bn`, `READY`, `target: production`, `githubCommitSha` matches the merge commit exactly, aliased to `www.ra7etbal.com`/`ra7etbal.com` with `aliasError: null`, canonical URL returns HTTP 200, zero new runtime errors in the post-deploy window. No organic WhatsApp traffic occurred in the immediate post-deploy window to independently observe the redaction firing on real production data — correctness rests on the passing test suite (which directly asserts the redacted shape and the absence of raw message text) plus the deploy-health check above, not on a forced live send.

Protect: `redactMetaPayloadForLog()` and the `logSendAttempt`/`logOwnerDecisionMetaPayloadAudit` redaction shape — do not reintroduce a raw `payload`/`bodyParameter.text`/`buttonParameter.text` field to these specific logs. Reopen only if a new production-reachable WhatsApp log is found leaking phone numbers or message content.

### "make" verb delegation misclassification — FIXED, ROOT CAUSE, PRODUCTION VERIFIED (2026-08-09)

Status: COMPLETE. Merged as PR #203, merge commit `3df0a486166e53a4e7d71233c8311b9066703fe1`.

**Correction to this entry's prior claim**: this previously stated that "Tell Christopher to wait for me in the kitchen. I'm on my way." was *required* to route to delegation. That was wrong — confirmed the opposite: "wait for me" targets the owner, so it is simple communication, not trackable delegated work. The `it.fails` test for that phrase in `direct-message-fast-path.test.ts` was corrected to a normal passing test asserting it stays a direct message (unaffected by this fix — "wait" is not a delegation verb).

**Root cause was broader than originally scoped.** The confirmed defect ("Tell Christopher to make lunch." misrouted as a direct message) traced back to two issues, not one: "make" was genuinely missing from `DELEGATION_BODY_START`'s verb whitelist in `direct-message-fast-path.ts`, **and** separately, that whitelist's optional `to` prefix (`(?:to|please\s+)?`) never consumed its own trailing whitespace — unlike the adjacent `please\s+` branch — so the whole alternation could never match a body shaped `to <verb>`, which is exactly how `extractMessageBody` leaves every "tell X to \<verb\>" body. Adding "make" alone (the originally-scoped fix) was verified as a no-op against the real regression phrase for this reason; a narrow "make-only" patch was implemented, tested, found not to fix the confirmed phrase, and reverted before the root-cause fix below was implemented instead.

**Impact review performed before the broader fix** (per explicit instruction, since it touches every verb already in the whitelist, not just "make"): searched the full test suite for every "Tell/Ask X to \<verb\>" assertion. Found dozens across `delegation-fast-path.test.ts`, `carson-router.test.ts`, `carson-planner.test.ts`, `api/_owner-command-executor.test.js`, and `api/_carson-intent-classifier.test.js` universally expecting delegation for these exact verb+"to" patterns via other classifiers (`parseDelegationFastPath`, `classifyOwnerCommand`, `carson-router.ts`). Found exactly one test asserting the opposite — `direct-message-fast-path.test.ts`'s "Tell Christopher to clean the kitchen." case — and it explicitly self-documented itself in its own comments as encoding this known parser bug, not intentional product behavior. `carson-protected-behaviors.test.ts`'s own "Ask Christopher to clean the kitchen." test is unaffected either way: "Ask" was never recognized by this parser's `COMMAND_PREFIX` (only send/message/tell/text/whatsapp), so it never reaches this code path regardless of the fix.

**Fix:** `(?:to|please\s+)?` → `(?:to\s+|please\s+)?` in `DELEGATION_BODY_START`, plus "make" added to the verb list. No new delegation verbs added beyond "make" — the whitespace fix only changes *when* already-whitelisted verbs match, not *which* verbs are whitelisted. Downstream delegation handling (`executeDelegationFastPath`/`parseDelegationFastPath`) has no verb exclusion of its own — confirmed it already correctly handles every affected verb once the direct-message fast path stops swallowing them first.

**Parallel classifiers verified aligned, no changes needed:** `api/_owner-command-executor.js`'s `WORK_HINT` regex already includes "make"; `delegation-fast-path.ts` has no verb-exclusion logic at all.

**Tests:** the "clean the kitchen" test's expectation flipped from "stays direct message" (documented bug) to "excluded, routes to delegation" (correct). New explicit regressions added for "make lunch.", "clean the kitchen.", "buy groceries.", "fix the door." (all → excluded from direct-message routing, i.e. delegation), "Tell Eren I'm on my way." (→ stays direct message, unaffected), and "Ask Loulya if she likes avocado." (→ out of this parser's scope entirely, unaffected — "Ask" isn't a recognized prefix here). Targeted suite (`direct-message-fast-path.test.ts`, `delegation-fast-path.test.ts`, `_owner-command-executor.test.js`, `_owner-command-executor.execution.test.js`, `_owner-whatsapp-routing.test.js`, `carson-protected-behaviors.test.ts`, `ElevenLabsAgentWidget.typed-delegation-execution.test.ts`): 255/255 passing. Full `npm run test:carson-protected`: 54/54 files, 1023/1023 tests (5 new), zero regressions. Typecheck and production build both clean. CodeRabbit review: zero actionable findings.

**Production verification:** deployment `dpl_5SWZgrcytexEUjAfWR6pW8Nj4sxA`, `READY`, `target: production`, `githubCommitSha` matches the merge commit exactly, aliased to `www.ra7etbal.com`/`ra7etbal.com` with `aliasError: null`, canonical URL returns HTTP 200, zero new runtime errors in the post-deploy window. No live Carson conversation was originated to test this in a real voice/typed session — this agent has no way to authenticate as the owner (same limitation as Historical Lookup Phase 2 and the Tool Registration Drift incident above). This is a pure, deterministic client-side string classifier with no Meta/WhatsApp round-trip involved in its own correctness, so the exhaustive, passing test suite is the primary evidence rather than a forced live send. A real "Tell Christopher to make lunch." (or "...clean the kitchen"/"...buy groceries"/"...fix the door") spoken to Talk to Carson would be a trivial, safe self-check whenever convenient.

Protect: `DELEGATION_BODY_START`'s `to\s+`/`please\s+` prefix shape — do not reintroduce a bare `to` alternative without trailing whitespace. Do not widen the verb whitelist beyond what already existed plus "make" without a separate, explicitly-scoped task.

### Carson communication vs. delegation routing fix

Status: merged and deployed (PR #49, merge commit `85b3bc5b74743af43798a032162c111522bfc5c8`). See "Carson wait-location-qualifier regression fix" below for a follow-up production regression found after this shipped.

**Confirmed production regression**: "Ask Grace to call me now." (Type to Carson), "Ask Suresh to call me now." (Talk to Carson), and "Tell Ghulam to wait for me." (Talk to Carson) were all wrongly routed to the tracked-delegation path — the staff member received a confirmation link ("When done, tap here" + `/confirm?task=`) and a task was created, when the correct behavior is a plain WhatsApp message with no task and no link. "Tell Ghulam I'm on my way." was and remains correct (plain message, no link).

**Root cause**: neither Type to Carson's fast-path parsers nor Talk to Carson's `send_delegation` tool handler had any check for whether a task's text actually targets the *owner* (a communication act) rather than describing trackable operational work. `parseDelegationFastPath`'s "ask/tell [name] to [task]" pattern (`delegation-fast-path.ts`) has no exclusion for communication-style task text, so "call me"/"contact me"/"wait for me" phrasing following "ask/tell X to" matches as delegation task text. On the voice side, `sendDelegation()` (`ElevenLabsAgentWidget.tsx`) unconditionally created a task whenever the ElevenLabs voice model called the `send_delegation` tool — with no reclassification check — so if the (externally hosted, not in this repo) ElevenLabs system prompt's model picked `send_delegation` for a communication-style instruction, this codebase faithfully created a tracked task with a confirmation link. Both Type to Carson's delegation fast path (`executeDelegationFastPath`'s injected `sendDelegationFn`) and Talk to Carson's `send_delegation` clientTool call the exact same `sendDelegation()` function — confirmed the single shared convergence point for both channels.

**Fix**: added one new shared, verb-agnostic classifier, `isCommunicationStyleTaskText()` (`src/lib/communication-vs-delegation.ts`) — true when task text targets the owner personally (call me, contact me, text me, wait for me, let me know, etc.), regardless of which verb introduces it. Wired into `sendDelegation()`: when the task text is communication-style, it reroutes to the exact same `createAndSendDirectMessage()` primitive `direct-message-fast-path.ts` and `send_direct_whatsapp_message` already use (never a confirmation URL, since that function always sets `confirmation_url`/`confirmationLink` to `null`), instead of creating a task. Since both channels call the same `sendDelegation()`, one guard protects both — Type and Talk cannot diverge on this because there is only one implementation. `direct-message-fast-path.ts`'s own parsing logic (`COMMAND_PREFIX`, `DELEGATION_BODY_START`, `isUnsafeBody`) is unchanged — it already resolved "Tell Ghulam to wait for me." correctly before this fix (confirmed by tracing); the confirmed regression only reproduced via `parseDelegationFastPath`'s "ask X to Y" pattern (typed) and the ElevenLabs voice model's own tool choice (voice), both of which are now caught downstream in `sendDelegation()` regardless of how they got there.

**Permanent tests**: `src/lib/carson-protected-behaviors.test.ts` (35 tests, 1 `it.todo` documenting the separate pre-existing "make" gap) — classifier behavior, the exact confirmed production phrases, typed fast-path routing, structural proof that `sendDelegation()` checks the classifier before ever calling `createAndSendDelegation()`, Type/Talk parity (one shared `sendDelegation()` implementation, both call sites verified), and confirmation-link-freedom of the direct-message send path. Proven to fail against the unfixed code first (3/34 failing on the wiring checks), then pass after the fix (34/34, plus the 1 todo). Also updated `direct-message-fast-path.test.ts` (corrected the stale "wait for me" `it.fails`) and `ElevenLabsAgentWidget.direct-whatsapp-duplicate.test.ts` (narrowed its delegation-block assertion to exclude the new, intentional communication-reroute sub-block).

**CI protection**: `.github/workflows/carson-protected-behaviors.yml` runs `npm run test:carson-protected` (a curated 10-file focused suite, ~10s) on every PR to `main`, deliberately with no path filter — Carson routing logic is spread across too many files to safely allowlist by path.

**Production verification status**: verified on `https://www.ra7etbal.com` after PR #49 merged and deployed.

Protect: this classifier and its wiring inside `sendDelegation()` — do not reintroduce a per-channel or per-phrase patch; any future confirmed regression against this contract must extend `isCommunicationStyleTaskText()` and its test suite, not bypass them.

### Carson wait-location-qualifier regression fix

Status: merged and deployed (PR #50, merge commit `4d6822d76807d9496c734f25a8fe896ed40dbe5a`).

**Confirmed production regression** (found after PR #49 shipped): "Tell Christopher to wait in the kitchen for me." was still wrongly routed to tracked delegation. Talk to Carson replied "Christopher has it." and sent a WhatsApp confirmation-link task message; Type to Carson replied "Okay, I'm on it." instead of the plain-message path.

**Root cause**: `isCommunicationStyleTaskText()`'s "wait" pattern (`/\bwait\s+(?:for|here\s+for)\s+(?:me|us)\b/`) required "wait" and "for me/us" to be immediately adjacent. Inserting a location or time qualifier between them ("wait IN THE KITCHEN for me") broke that adjacency, so the classifier missed it and the text fell through to the delegation path — the exact same convergence point (`sendDelegation()` in `ElevenLabsAgentWidget.tsx`) fixed in PR #49, just a gap in the classifier's grammar, not a new architectural issue.

**Fix**: `communication-vs-delegation.ts`'s `OWNER_TARGET_COMMUNICATION` regex now allows one bounded location clause between "wait" and "for me/us" ("in"/"at"/"by"/"near" require 1-3 following words; "outside"/"inside" allow 0-3, since they can stand alone), plus a separate "wait until TIME" alternative. Two CodeRabbit review rounds hardened this against false positives that would have suppressed real task creation on compound instructions: the qualifier rejects coordinating conjunctions ("and"/"then"/"or"/"but"/"to") via a per-word negative lookahead, so "wait at the store AND BUY MILK for me" cannot have the trailing real task swallowed into the location clause; the "wait until TIME" alternative is anchored to both the start and end of the string, so it cannot match as a fragment of a longer compound instruction in either direction ("wait until 8, THEN CLEAN THE KITCHEN" or "CLEAN THE KITCHEN, then wait until 8").

**Known, documented, deliberately deferred limitation** (not fixed, not proven by any confirmed production incident): a compound instruction pairing real trackable work with a communication clause via a coordinating conjunction is still misclassified as fully communication-style in both directions — "clean the kitchen and let me know when done" (trailing communication after real work) and "wait in the kitchen for me and then clean the garage" (trailing real work after a location-qualified wait clause). A safe general fix needs conjunction/clause-boundary detection distinguishing "communication phrase with descriptive trailing content" (must still match — see the protected "wait for me in the kitchen. I'm on my way." case) from "actionable clause + conjunction + communication phrase" — genuinely new logic, not a small regex extension, and out of scope for this fix. See the two `it.todo` entries in `carson-protected-behaviors.test.ts`.

**Permanent tests**: extended `src/lib/carson-protected-behaviors.test.ts` with the exact confirmed regression phrase plus the three other required-protection phrases ("Tell Ghulam to wait by the car for me.", "Ask Grace to call me from the office.", "Tell Nasira to wait until 8."), the two preserved-delegation phrases ("Ask Christopher to clean the kitchen.", "Ask Ghulam to bring the car out."), and negative regression tests for every compound-instruction false positive found across two CodeRabbit review rounds ("wait at the store and buy milk for me", "wait until 8, then clean the kitchen", "clean the kitchen, then wait until 8") plus positive coverage for the outside/inside standalone-adverb form. 50/53 passing (3 `it.todo`, up from 2 — the new one documents the mirrored compound-instruction gap above). Full curated suite (`npm run test:carson-protected`): 154 passed, 3 todo.

**Production verification status**: verified on `https://www.ra7etbal.com` — deployment `dpl_CV1YfDfcFjgzcXet6vXi7DH6ugma`, commit `4d6822d76807d9496c734f25a8fe896ed40dbe5a` matches the merge commit exactly, `www.ra7etbal.com`/`ra7etbal.com` aliased with `aliasError: null` and `readyState: READY`.

Protect: the four required phrases above, plus the two preserved-delegation phrases — same contract as the PR #49 entry, extended for the location/time qualifier grammar. Do not reintroduce a per-channel or per-phrase patch.

### Carson communication vs. delegation — acknowledgement wording and typed dispatch (PR #52, PR #53) — PERMANENTLY LOCKED

Status: merged, deployed, and verified in production. PR #52 merge commit `8cef9064f02afefe3a21b2be74f6733331ac66a8`. PR #53 merge commit `a94d3d71983dc52f2208390767ad0cc962768c10`. Production verification completed on `https://www.ra7etbal.com`.

This entry covers two further confirmed production regressions in the same Carson communication-vs-delegation contract established by PR #49/#50 above, and locks the final, verified behavior permanently.

**Regression 1 — acknowledgement wording (PR #52)**: after PR #50 correctly stopped creating a task/confirmation-link for plain staff communication ("Tell Christopher to wait in the kitchen for me."), Carson still replied "Christopher has it." — task-style wording for a message with no task behind it. Root cause: `sendDelegation()`'s communication-reroute successText and `CARSON_VOICE_SESSION_GUARD`'s single example phrase for "a delegation tool succeeds" didn't distinguish a real tracked task from the plain-message reroute, so Talk to Carson's voice model defaulted to task-style wording for both outcomes.

**Regression 2 — typed dispatch gap (PR #53)**: "Tell Christopher to wait for me in the kitchen" correctly matched `parseSimpleDirectMessage` (so it correctly skipped the delegation fast path — "never reclassify a direct message"), but nothing then deterministically sent it. The typed pipeline only ever reached a WhatsApp send when either the deterministic delegation fast path ran, or the free-form ElevenLabs LLM itself decided to call a tool — when `parseSimpleDirectMessage` matched, the delegation fast path was (correctly) excluded, but nothing deterministic existed for direct messages on the typed channel. The message fell through to the free-form turn, and the model replied "Okay, I'm on it." without calling any tool at all. Confirmed via production Supabase evidence: zero `messages` rows, zero `tasks` rows, for two identical test submissions ~70 seconds apart.

**Regression 2a — malformed leading "to" body (surfaced by PR #53's own fix)**: once the typed dispatch became deterministic, `extractMessageBody`'s "tell"-verb branch was found to never strip a leading "to" connector — "Tell X to Y" parses to body "to Y", not "Y". Harmless while nothing deterministically sent it; became a real malformed-WhatsApp-body risk the moment delivery became reliable. Fixed in `executeDirectMessageFastPath`, *after* `parseSimpleDirectMessage`'s own classification has already run against the untouched body — proven not to change delegation routing (`"Tell Christopher to clean the kitchen."` gets the exact same, unchanged, pre-existing classification verdict before and after).

**Regression 2b — duplicate-send risk (CodeRabbit finding on PR #53)**: `executeDirectMessageFastPath` has no recent-send protection of its own. Once dispatch became deterministic, an identical resubmission — exactly what happened in the confirmed production test above — would reliably double-send a real WhatsApp message. Fixed by reusing the exact `recentDirectWhatsappMessagesRef`/`isRecentDirectWhatsappDuplicate`/`recordDirectWhatsappSent` mechanism `sendDelegation()`'s own communication reroute already uses, at the new typed-dispatch call site, keyed on the raw parsed recipient/body.

**Final verified production behavior**:

- Plain staff communication (e.g. "Tell Christopher to wait for me in the kitchen.", "Ask Grace to call me from the office."): sends a plain WhatsApp message; never creates a task; never creates a Waiting item; never includes a confirmation link; acknowledgement is communication-style ("I let Christopher know. I'll watch for the reply."), never task-style ("Christopher has it."); Type and Talk behave the same; an identical immediate repeat is blocked, not duplicated.
- Real delegation (e.g. "Ask Christopher to clean the kitchen."): creates a real task; sends the task message with a confirmation link; acknowledgement is task-style ("Christopher has it." on Talk; "Done. I asked Christopher to clean the kitchen." on Type — different literal wording by design, since Type displays `sendDelegation()`'s raw return value while Talk's model composes its own phrasing guided by `CARSON_VOICE_SESSION_GUARD`, but both unambiguously task-style); Type and Talk behave the same.

**Permanent regression tests** (audited 2026-07-22, one gap found and closed — see below):

- `src/lib/carson-protected-behaviors.test.ts` §7 "Acknowledgement wording" — communication-reroute successText is message-style, real-delegation successText is unchanged task-style, `CARSON_VOICE_SESSION_GUARD` distinguishes both outcomes with the real-delegation example preserved verbatim.
- `src/lib/carson-protected-behaviors.test.ts` §8 "Typed direct-message dispatch" — dispatch runs before the delegation fast path, never reaches `conversation.sendUserMessage`/`createAndSendDelegation`/`executeDelegationFastPath`, persists and returns immediately when handled, real delegation phrasing is unaffected, the duplicate guard is wired before the send and records only on actual success, and (added in this audit) `direct-message-fast-path.ts` never references the known task/delegation-creation symbols (`createAndSendDelegation`, `createDelegationTaskAndMessage`, `createTask`) or imports from `./delegations`/`./tasks` (quote-style and static/dynamic-import agnostic) — closing the same guarantee already proven for `sendDelegation()`'s reroute, now also proven for the newer dispatcher, so an accidental direct reintroduction of task creation into this module would be caught. Like any source-text check, it cannot detect an arbitrarily indirect re-export chain — the primary defense remains the architectural separation itself (this module has no reason to ever import task-creation logic).
- `src/lib/direct-message-fast-path.test.ts` — behavioral tests (mocked `createMessageFn`/`deliverTaskMessageFn`) proving the exact outgoing body for the confirmed phrase is "wait for me in the kitchen", never the malformed "to wait for me in the kitchen"; that `parseSimpleDirectMessage`'s own raw output is unchanged (the fix lives only in `executeDirectMessageFastPath`, after classification); that a mid-sentence "to" is left alone; that classification/routing is unaffected; and (added in this audit) that confirmation link fields are null for this exact confirmed phrase, not just proven generically.
- `src/lib/direct-message-duplicate-guard.test.ts` — behavioral proof of the underlying duplicate-detection mechanism (first send allowed, immediate repeat blocked within the cooldown window, per-recipient/message keying, expiry).
- `src/components/home/ElevenLabsAgentWidget.direct-whatsapp-duplicate.test.ts` — proves the communication-reroute sub-block intentionally uses the direct-WhatsApp duplicate guard, and the genuine delegation-send path never does (separate, correct mechanisms).
- `src/components/home/ElevenLabsAgentWidget.direct-message-parity.test.ts` — proves exactly two `normalizeOwnerReference` call sites (the typed deterministic dispatch hardcodes `true`; the model-driven `execute_instruction` call site gates on the active channel), and that voice's own direct-message tool never duplicates normalization.
- `src/components/home/ElevenLabsAgentWidget.typed-delegation-execution.test.ts` — proves the delegation fast path's own guard/exclusions/ordering are unchanged by the new adjacent dispatch block.
- `src/lib/delegations.test.ts` — behaviorally proves `createDelegationTaskAndMessage` (the DB-layer primitive behind `sendDelegation()`'s real-delegation branch) creates a task and message with a real, non-null confirmation URL.

A 2026-07-22 audit against this contract found exactly one gap (no test proved `direct-message-fast-path.ts` itself never references task/delegation creation) and zero production-code gaps — the audit resulted in test-only additions, no behavior change.

**Code invariant**: `ElevenLabsAgentWidget.tsx`'s typed routing boundary (`sendTypedMessage`, inside the `if (authUserId)` block) carries an explicit comment: *"a matched direct message must be dispatched and returned immediately here. It must never fall through to the free-form model below."*

**CI protection**: `.github/workflows/carson-protected-behaviors.yml` runs `npm run test:carson-protected` on every PR to `main` — confirmed still the required status check on branch protection (`gh api repos/Sanafaham/ra7etbal/branches/main/protection` → `required_status_checks.contexts: ["carson-protected-behaviors"]`).

Protect: everything in "Final verified production behavior" above, plus the specific defects in Regressions 1/2/2a/2b — any future change touching `sendDelegation()`, `executeDirectMessageFastPath`, `parseSimpleDirectMessage`, `sendTypedMessage`'s typed routing boundary, or `CARSON_VOICE_SESSION_GUARD` must preserve this contract and its full test suite. Do not reintroduce a per-channel or per-phrase patch. Do not let the two acknowledgement styles (communication vs. delegation) merge back into one. Do not remove the typed deterministic dispatch or the duplicate-send guard on it.

### Morning brief does not proactively include reminders

Current behavior: the focused fix is merged and deployed in PR #24. Carson now receives supported owner reminders scheduled in the next 24 hours through the existing morning brief automation slot, including when another automation status also needs to be spoken.

Expected behavior: the morning brief should automatically include the owner's relevant reminders and commitments without requiring a separate question.

Verification status: production deployment is ready. Sana's live morning-brief check is still required before this moves to Stable and protected.

### Universal Timestamp System V2 — remaining future work (not defects)

Status: not started. Kept separate from the production-verified, protected Universal Timestamp System baseline (see Stable and protected above). These are additive future improvements, not defects in the verified timestamp display — do not present them as bugs:

- true completion timestamps in History
- precise Waiting duration
- persisted Needs You entry time
- missing task lifecycle event timestamps
- owner-decision timestamps
- proof-submission timestamps
- cancellation timestamps
- owner-notification timestamps

These require small additive `tasks`/related-table columns (a real migration, unlike V1A/V2A, which were display-only and zero-migration) — see the full audit for the smallest-safe-fix proposal before starting. Any future work here must be additive and must not break or rewrite the production-verified V1A/V2A displays.

### Staging WhatsApp webhook environment — future infrastructure, not a workstream

Status: not started. Recorded 2026-08-07 during Workstream 5's production-verification design, as a **separate future infrastructure item — explicitly not part of Workstream 5 and not to be folded into it.**

What it is: a dedicated staging WhatsApp Business Account + Meta App + webhook URL/secret, isolated from real recipients, matching the "target architecture, not yet built" language already in this repo's locked "permanent production verification policy" (see above). Would let webhook-driven features be verified with constructed payloads on demand, without touching a real person's phone and without waiting on an unpredictable organic event.

Why it matters: identified as the correct long-term methodology during an engineering review of Workstream 5's verification options (organic wait / controlled real send / staging / historical replay). Staging is the only option that is simultaneously zero production risk, repeatable on demand, and doesn't consume a real recipient's engagement standing every time verification is needed. It does not, however, reproduce Meta's real per-recipient pacing algorithm — so it complements, rather than replaces, occasional real-world confidence.

Do not start this without an explicit, separately-scoped engineering session.

### PWA push-subscription accumulation and restoration — FORMALLY CLOSED, PRODUCTION VERIFIED

Status: FIXED. MERGED. DEPLOYED. PRODUCTION VERIFIED on Sana's actual installed iPhone PWA. PROTECTED.

PR #207, merge commit `a896c901b63e1df33fb30193b1f98eb572c4df43`. PR #209 (Engineering Completeness Review follow-up, below), merge commit `77b92e66ebf83369adf868e76186073260fad350`. Docs closure PRs (this entry).

**Engineering Completeness Review addendum (2026-08-09, PR #209):** an explicit completeness review of this capability, performed before treating it as closed a second time, found that CodeRabbit finding (a) below — the dedupe update's error only being `console.warn`'d — was not actually resolved by the review round that "fixed" it; the caller could still resolve `"enabled"` while the pile-up this capability exists to fix silently persisted. Reopened and fixed narrowly: `disableOtherEnabledSubscriptions` now throws on a failed update instead of warning, so `enableReminderNotifications`/`refreshPushSubscription` genuinely fail (existing `try/catch` in `SettingsModal.tsx` already reports `"error"`) and the `pushsubscriptionchange` auto-save path (`push-subscription-rotation.ts`, previously a bare fire-and-forget call with no `.catch()` at all) now logs via `console.error`. New regression tests prove failure now propagates on all three call sites and is never reported as false success. Full `test:carson-protected` (54 files, 1028 passed), typecheck, and build all clean. Production deployment `dpl_J27sbe7oRLnQCyHR7P4Bez4QaDzE`, `READY`, SHA matches the merge commit, aliased to `www.ra7etbal.com`/`ra7etbal.com`, `aliasError: null`, zero new runtime errors (only the same pre-existing, unrelated `DEP0169` deprecation warning). No live device re-test was needed or performed — this only changes behavior on a cleanup *failure*, which is not independently reproducible on a real device; the happy path already live-verified below is unchanged.

**The following two limitations were tracked here as open engineering debt — both RESOLVED 2026-08-10 by the migration-based fix below. See "Push Subscription Installation Identity + Atomic Replacement" for the closure.**
1. ~~Same-platform multi-device identity collision~~ — RESOLVED: client-generated `installation_id` replaces `navigator.platform` as the supersede key.
2. ~~Non-atomic concurrent save/dedupe race~~ — RESOLVED: `upsert_push_subscription` RPC does upsert + supersede in one transaction, serialized by a transaction-scoped advisory lock.

What it replaces: the prior "PWA authentication or notification restoration difference" entry ("browser sign-in restores notifications, while the installed home-screen PWA may not restore them in the same way") was an unrooted observation with no investigation. It is superseded by the confirmed root cause and fix below — auth/session restoration was independently confirmed unrelated (Supabase's `onAuthStateChange` session machine and push-subscription persistence are two completely separate systems; no push logic runs on sign-in anywhere).

Root cause (confirmed against production Supabase, not guessed): a fresh `pushManager.subscribe()` always inserted a brand-new `push_subscriptions` row keyed on the new endpoint — it never replaced a prior row for the same device. iOS is documented to evict an infrequently-used installed PWA's service worker and storage; each time that happened and the app was reopened, a new subscription was minted and yet another row piled up, left `enabled: true` forever (the only prior cleanup path required a hard 404/410 from the push provider, which an evicted iOS registration may never produce promptly). Before the fix, Sana's account had accumulated 24 enabled rows total (19 iPhone) across roughly ten weeks, none ever superseded; two real historical reminder sends fanned out to 10 and 5 provider-accepted (HTTP 201) subscriptions but only 2 and 1 respectively ever reached a live service worker.

Fix, two additive pieces, no new API route (respects the 12-function Vercel Hobby cap):
1. `src/lib/push-notifications.ts` — every successful subscription save now disables (never deletes, preserving audit history) every other still-enabled row for the same `user_id` + `platform`, keeping at most one canonical enabled row per real device.
2. `public/sw.js` + new `src/lib/push-subscription-rotation.ts` — handles the browser's own `pushsubscriptionchange` event (silent provider-side rotation), resubscribing via `event.oldSubscription.options.applicationServerKey` (no hardcoded VAPID key needed) and relaying the new subscription to an open tab via `postMessage`, since a service worker has no Supabase session of its own. Known, accepted limitation: only catches a rotation while a tab is open — piece 1 is the primary, always-effective fix.

CodeRabbit review (PR #207): one finding initially only partially addressed (the dedupe update's error was silently swallowed — first-round fix made it log via `console.warn` but still non-fatal, which the Engineering Completeness Review above found was not actually complete; PR #209 finished it by making the failure propagate). Two findings deliberately deferred and documented inline in `push-notifications.ts` — see the two open-debt items above; not resolved by either PR #207 or #209.

**Live production verification, performed step-by-step on Sana's actual installed iPhone PWA (2026-08-09), Supabase project `ggarvhgqzpooloacjgcj`, account `645ddb96-6e09-4d91-b650-cbc75bac9a5d`:**
- Baseline confirmed before touching anything: 7 enabled iPhone rows + 3 enabled MacIntel rows, matching the pre-fix pile-up pattern exactly.
- Sana disabled notifications in Settings on-device → row `833a8611…` (this device's tracked subscription) disabled at `17:29:44`, matching exactly.
- Sana re-enabled notifications on-device → new row `f46621dc…` inserted at `17:49:42.926` (`platform: iPhone`, `enabled: true`); all 6 previously-enabled iPhone rows batch-disabled ~296 ms later at `17:49:43.222` — the dedupe pass firing correctly. All 3 MacIntel rows and the already-disabled legacy rows were left untouched. Exactly one enabled iPhone row remained afterward.
- Sana created a real reminder via Carson ("check the PWA notification test", task `c101f394…`, `due_at 17:59:59`). Full delivery-event chain for the new subscription `f46621dc…`: `provider_send_attempted` → `provider_accepted` (HTTP 201) → `service_worker_received` → `show_notification_attempted` → `show_notification_resolved`, exactly once, no duplicates. Sana's own screenshot confirms exactly one visible notification banner on the lock screen. Two of the three legitimate MacIntel devices independently fired the same reminder once each (unaffected, correctly untouched by the platform-scoped dedupe) — confirming the fix did not collaterally break other real, valid devices; the third MacIntel subscription was provider-accepted but never reached a live service worker, the same pre-existing, already-documented "provider acceptance is not confirmed delivery" behavior from the reminder golden contract, unrelated to this fix.

Protect: `disableOtherEnabledSubscriptions`'s platform-scoped dedupe in `push-notifications.ts` — do not widen or narrow its scoping without a reproduced regression. Its failure must keep propagating (PR #209) — do not reintroduce a swallow-and-warn pattern here. The `pushsubscriptionchange` handler in `sw.js` and its `postMessage` bridge to the page — do not attempt to have the service worker persist a subscription directly (it has no Supabase session). The two open-debt items above (atomicity, per-device identity) are real, tracked, unresolved limitations, not closed defects — do not present them as fixed; implement the actual migration-based fix, or leave them explicitly open, before ever marking either resolved.

### Push Subscription Installation Identity + Atomic Replacement — FORMALLY CLOSED, PRODUCTION VERIFIED (live device)

Status: FIXED. MERGED. DEPLOYED. LIVE-DEVICE VERIFIED on Sana's actual installed iPhone PWA (2026-08-09/10). PROTECTED.

PR #211, merge commit `90073f439bde7b56d66ffde4a0c3bb392c078b59`. Migration `20260810_push_subscription_installation_identity.sql`, applied directly to production Supabase project `ggarvhgqzpooloacjgcj` ahead of the app-code merge (additive, backward-compatible, no-op against existing data since no row had `installation_id` set before this).

Resolves the two open-debt items carried from the PWA push-subscription entry above (same-platform multi-device collision, non-atomic dedupe race) — see that entry for what changed.

**Architecture (three-round design review before implementation — see PR #211 discussion):**
- Client generates a stable per-storage-partition `installation_id` (`crypto.randomUUID()`, persisted in `localStorage`, key `ra7etbal:push-installation-id`) — deliberately distinct from a hardware device ID; tracks storage-partition lifetime, not the physical device. Never falls back to an ephemeral unpersisted UUID on storage failure (that would mint a new "installation" every save and recreate the accumulation problem); a storage failure passes `installation_id: null` straight through, treated exactly like a legacy pre-migration row.
- Save + supersede is one Postgres function (`upsert_push_subscription`, `SECURITY INVOKER`), not two client requests: disables every other enabled row for this exact `(user_id, installation_id)` first, *then* upserts the new row enabled — this ordering (not the reverse) is required so the transaction never has two enabled rows for one installation at once, which would trip the partial unique index before the supersede step ever ran.
- Concurrency is a real transaction-scoped advisory lock (`pg_advisory_xact_lock`, keyed on `user_id + installation_id`), not just per-call atomicity — proved with genuine two-Postgres-connection `dblink` tests (not same-session simulation): a concurrent second caller is shown actually blocked while the first's transaction is open, then unblocks and correctly supersedes after commit.
- `push_subscriptions_one_enabled_per_installation` partial unique index is defense-in-depth, not the primary serialization mechanism — it exists so the invariant holds loudly (`unique_violation`) even against a future write path that forgets to take the lock, rather than silently corrupting state.
- Deliberately does **not** include any age/inactivity-based cleanup of rows orphaned by iOS storage eviction or a home-screen reinstall. Explicitly rejected during design review: absence of recent activity is not proof a device is dead — a legitimate second device can be idle a long time and must never be auto-disabled for that reason alone. Orphaned rows stay enabled until one of three existing, evidence-based mechanisms resolves them (provider 404/410, explicit user disable, or the same `installation_id` resubscribing).

**Production security gap found and fixed during rollout (2026-08-10):** the migration's `REVOKE EXECUTE ... FROM PUBLIC` was applied first and verified insufficient — a post-apply `SET ROLE anon` probe showed `anon` could still call `upsert_push_subscription`. Root cause: this Supabase project has `ALTER DEFAULT PRIVILEGES` granting EXECUTE directly to `anon`/`authenticated`/`service_role` on every new function, independent of and not removed by revoking `PUBLIC`'s grant alone. Fixed immediately on production (`REVOKE ... FROM PUBLIC, anon`), then the migration file and the CI bootstrap fixture were both corrected so this class of bug is caught going forward — the bootstrap now replicates the same default-privileges behavior, and was mutation-tested (reverting to the buggy revoke locally makes the security verification suite fail; the fix makes it pass again).

**Test coverage (all real, not mocked where DB-related):** a dedicated path-filtered CI workflow (`push-subscription-installation-identity-verification.yml`, mirrors the `staff-escalation-migration-verification.yml` pattern) runs against a genuine ephemeral `postgres:17` service container — bootstrap → pre-existing legacy fixture → forward migration → lifecycle (idempotent re-save, rotation, no cross-installation collision, partial unique index) → legacy backfill (old rows untouched, lazily adopt `installation_id` on next save) → real two-connection `dblink` concurrency (concurrent first-saves, concurrent rotations, rollback-on-terminal-failure) → security (anon/PUBLIC denied, authenticated allowed, cross-user isolation) → rollback → post-rollback cleanup check → reapply → lifecycle rerun. Client-side: `push-notifications.test.ts` rewritten for the RPC-based flow (installation-id generation/reuse/UUID-validation, RPC failure propagation on all three entry points). `push-subscription-rotation.ts` and `public/sw.js` confirmed unchanged and unneeded — their existing test suites passed without modification.

**CodeRabbit findings (one batched fix round, both PR review commits):** first round — the anon-grant security gap above (self-caught via production verification, not CodeRabbit). Second round, 3 actionable comments, all fixed in one batch: workflow checkout now sets `persist-credentials: false`; `getOrCreateInstallationId()` now validates the stored value is UUID-shaped before reusing it (a corrupted value is treated as absent and regenerated, instead of failing every save with `invalid_text_representation` until storage is cleared by hand); the concurrency verification's `dblink` conninfo now derives its port from `current_setting('port')` instead of a hardcoded `5432`, re-verified against a real ephemeral Postgres end-to-end after the change.

Full local ephemeral-Postgres sequence, targeted client tests, `npm run typecheck`, and `npm run build` all clean. Production deployment SHA-matched to the merge commit for both `ra7etbal-v2` and `ra7etbal-work` Vercel projects, `www.ra7etbal.com` returns HTTP 200, zero new runtime error clusters (only the same pre-existing, unrelated `DEP0169` deprecation warning seen on unrelated routes since 2026-06-16).

**Live production verification, performed step-by-step on Sana's actual installed iPhone PWA (2026-08-09/10), Supabase project `ggarvhgqzpooloacjgcj`, account `645ddb96-6e09-4d91-b650-cbc75bac9a5d`:**
- Baseline confirmed before touching anything: 4 enabled rows (1 iPhone `f46621dc…`, 3 MacIntel), all `installation_id: null` — expected, since no device had saved since the migration deployed. No duplicate-enabled anomaly.
- Single normal refresh (tapped the "Push notifications" row once): old untagged iPhone row disabled, new row `8fcce355…` inserted enabled with a freshly-minted `installation_id: 15967456-64f4-4bec-b86f-3990b96a617c` (localStorage had none yet — correct first-adoption behavior) and a rotated endpoint (Apple issued a new push token on unsubscribe/resubscribe). All 3 Mac rows untouched.
- Second refresh, same device: `installation_id` **reused** (`6c559300…`, same `15967456…`) — proving persistence across separate saves, not just within one call. Old row disabled ~0.55s before the new one was inserted, confirming the disable-first-then-enable-last ordering in production, not just in tests.
- Concurrency stress test: 5–6 rapid taps in quick succession produced 6 sequential save events (`22:37:00`→`22:37:15`), all carrying the identical `installation_id`. Each row's disable timestamp preceded the next row's create timestamp — no window with two enabled rows or zero enabled rows for the installation at any point. Final state: exactly one enabled row (`ffa31fe8…`), all 7 predecessors (the original untagged row plus 6 stress-test rows) correctly disabled. All 3 Mac rows untouched throughout.
- Real reminder created via Carson ("remind me in 2 minutes to check the push notification test", task `00d292c0-20b3-47be-800f-20c16d8698d8`, due `22:44:58.42`). Full delivery-event chain for `ffa31fe8…`: `provider_send_attempted` (`22:45:01.36`) → `provider_accepted` (HTTP 201, `22:45:01.50`) → `service_worker_received` (`22:45:02.94`) → `show_notification_attempted` (`22:45:03.73`) → `show_notification_resolved` (`22:45:04.70`), exactly once, no duplicates, no other iPhone `subscription_id` present anywhere in the event log (all disabled/superseded rows correctly excluded from the fan-out). Sana confirmed exactly one visible notification banner, arriving essentially on time. Two of the three Mac subscriptions independently completed their own full chains (unaffected, correctly untouched); the third (`5efe9cca…`) was provider-accepted but never reached a live service worker — the same pre-existing, already-documented "provider acceptance is not confirmed delivery" behavior from the PR #207 reminder verification, unrelated to this change.

**Follow-up:** "Push Subscription Installation Management / Orphan Resolution" — see its own entry below (FORMALLY CLOSED, PRODUCTION VERIFIED, 2026-08-10).

Protect: the disable-first-then-enable-last ordering inside `upsert_push_subscription` — do not reverse it, it exists specifically to avoid tripping the partial unique index. The advisory-lock keying (`user_id + installation_id`) — do not widen or narrow its scope without a reproduced regression. `getOrCreateInstallationId()`'s never-fall-back-to-ephemeral-UUID behavior on storage failure. Do not introduce any age/inactivity-based orphan cleanup without a genuinely new, evidence-based signal — this was deliberately rejected, twice, during design review.

### Push Subscription Installation Management / Orphan Resolution — FORMALLY CLOSED, PRODUCTION VERIFIED

Status: FIXED. MERGED. DEPLOYED. LIVE-DEVICE VERIFIED on Sana's actual production account (2026-08-10). PROTECTED.

PR #215, merge commit `35036a169c06a24cdbfb84c5e4f7e7b1b8cd66d1`. Docs closure (this entry). The deferred follow-up recorded in the "Push Subscription Installation Identity + Atomic Replacement" entry above.

**Read-only investigation preceded design, as usual.** Before writing any code, real production `push_subscriptions` data was queried directly: two accounts unrelated to Sana's carried 6 and 3 stale enabled rows respectively, all pre-dating the `installation_id` migration, zero `reminder_delivery_events` ever recorded for any of them — concrete proof the orphan-accumulation risk was real, not hypothetical, and that no existing mechanism would ever clean them up without a real send event happening to target them. Also confirmed: no safe deterministic automatic mechanism exists beyond the already-implemented reactive provider-404/410 cleanup — a proactive "liveness probe" push was considered and rejected, since the Web Push spec (`userVisibleOnly: true`) requires every push to show a visible notification, so a silent probe either violates the spec or confuses the user with a phantom notification.

**What was built — owner-visible list + manual remove, deliberately mitigates rather than eliminates accumulation:** Settings → Notifications → "Manage notification devices" lists every currently-enabled push subscription (platform, device details, added date, last-confirmed-delivery date sourced from real `reminder_delivery_events` `show_notification_resolved` rows) with a per-row "Remove" action. No age/inactivity heuristic anywhere — every removal is owner-initiated. Copy explicitly states "No confirmed delivery yet" does not mean a device is dead, since a live but simply-never-sent-to device looks identical to a truly orphaned one by that evidence alone.

**Implementation** (`src/lib/push-notifications.ts`): `listPushSubscriptionDevices` (RLS-scoped read, `push_subscriptions` joined client-side with `reminder_delivery_events`) and `removePushSubscriptionDevice` (reuses the exact `enabled: false` update shape already used by "Disable notifications" — never a hard delete, preserving audit history like every other disable path in this file; confirms the row was actually affected via `.select()` after `.update()` before reporting success, never a false "removed"). `src/components/settings/SettingsModal.tsx`: new `NotificationDevicesPanel`, following the existing `HouseholdDelegationRulesPanel` structural convention. Zero schema change, zero migration, zero new RPC.

**CodeRabbit findings:** one, fixed pre-merge — `formatDeviceDate`'s `try/catch` never actually caught an invalid timestamp (`new Date()` doesn't throw on an unparsable string; it silently produces `Invalid Date`, which `toLocaleDateString` then stringifies as the literal text "Invalid Date"). Fixed with an explicit `Number.isNaN(date.getTime())` check.

**Live production verification, performed step-by-step on Sana's actual account (2026-08-10), Supabase project `ggarvhgqzpooloacjgcj`, account `645ddb96-6e09-4d91-b650-cbc75bac9a5d`:**
- Baseline (4 enabled rows: 1 iPhone, 3 MacIntel) confirmed via direct query, then cross-checked byte-for-byte against the rendered Settings screen — every platform label, device-detail string, added date, and delivery date matched production exactly. Confirmed no raw `endpoint`, `p256dh`, `auth`, or `installation_id` is ever rendered.
- **A real ambiguity was found and correctly not auto-resolved, exactly as designed.** Sana has one physical Mac but the list showed three enabled MacIntel rows. Investigation (`user_agent`, push-service host, `reminder_delivery_events`) found: one Safari row (structurally never redundant with Chrome, since each browser holds its own independent push registration) and two Chrome rows (versions 149 and 150) that had **both** received real, independently-confirmed deliveries from the same reminder nine days apart in creation date — meaning neither could be safely called "orphaned" by evidence alone. The tool correctly surfaced this as owner-decidable, not machine-decidable; no code path attempted to guess. Sana identified from her own real-world knowledge (multiple past Chrome testing sessions on the same Mac, no intentional multi-profile setup) that the older Chrome 149 row (`ae2d8af7…`, created 2026-06-11) was the one to remove, while confirming the newer Chrome 150 row and the Safari row are both hers and in current use.
- **Controlled removal, fully verified:** pre-removal query confirmed `ae2d8af7…` belonged to the account, was the Chrome 149 row, and that the two rows being kept plus the current iPhone were still enabled. Sana used the live "Remove" button in production (not a database action). Post-removal query confirmed: `ae2d8af7…` → `enabled: false` (not deleted — row and its original `created_at` still present, only `updated_at` changed, matching the removal instant), the kept Chrome 150 row, the kept Safari row, and the current iPhone row all unchanged (`updated_at` identical to pre-removal), all 18 unrelated pre-existing rows for this account unchanged, no new row created anywhere. The UI's displayed 3-remaining-device state matched the database exactly.
- Production deployment SHA-matched to the merge commit for both `ra7etbal-v2` and `ra7etbal-work` Vercel projects, `www.ra7etbal.com` returns HTTP 200, zero new runtime error clusters (only the same pre-existing, unrelated `DEP0169` deprecation warning).

**Known, honest, permanent limitation — do not describe this capability as automatic cleanup:** this mitigates accumulation, it does not eliminate it. An owner who never opens this screen still accumulates orphans exactly as before this capability existed; nothing here runs on its own. This was the explicit, twice-reaffirmed design decision (see the Identity + Atomic Replacement entry above) — no age/inactivity heuristic exists or should ever be added without a genuinely new, evidence-based signal.

**Real, currently-open completeness gap surfaced by this exact live verification — not fixed here, tracked for a future task:** the panel does not identify "this is the device you're using right now." It was unambiguous only by luck during this test's iPhone case (exactly one iPhone row existed); the Mac case proved directly that the same platform label can legitimately apply to multiple simultaneously-valid rows with no way to tell which one is "here" from the list alone. A deterministic fix exists and needs no guessing: compare each row's `installation_id` against the value already persisted in the requesting browser's own `localStorage` (the same value `getOrCreateInstallationId()` in `push-notifications.ts` already reads/writes) and badge a match as "This device." Not implemented in PR #215 — none of today's three Mac rows could have used it anyway, since all three predate the `installation_id` migration (`installation_id: null`). Scope for a future task, not started.

Protect: `removePushSubscriptionDevice`'s enabled-false-not-delete shape and its confirm-the-row-was-affected check before reporting success. `listPushSubscriptionDevices`'s refusal to render raw endpoint/`p256dh`/`auth`/`installation_id`. The "no confirmed delivery ≠ dead" copy — do not let future wording imply staleness from absence of evidence. Do not add any automatic removal path without a new, genuinely evidence-based signal — this has now been rejected three times across two related capabilities.

### Push-subscription "This device" badge — FORMALLY CLOSED, PRODUCTION VERIFIED

Status: COMPLETE. MERGED. DEPLOYED. PRODUCTION VERIFIED. PROTECTED.

PR #226, merge commit `233a2e1bc29acf7245cbdc26c4fe1041bcbce974`. Closes the completeness gap the Orphan Resolution entry above left open: the Notification devices panel could show multiple simultaneously-valid rows sharing the same platform label with no way to tell which one is the device currently in use.

**Fix:** two small, additive pieces in `push-notifications.ts` — `getStoredInstallationId()`, a read-only counterpart to the existing, unexported `getOrCreateInstallationId()` (the save-path function) that reads the same `localStorage` key (`ra7etbal:push-installation-id`) and validates the same UUID shape, but never mints or persists a new id (viewing the panel must never have the side effect of writing a fresh installation identity); and `isCurrentDeviceRow(device, currentInstallationId)`, a pure predicate (`currentInstallationId !== null && device.installationId === currentInstallationId`) extracted as a standalone function so the matching logic is unit-testable without a DOM/testing-library dependency, which this project doesn't have. `NotificationDevicesPanel` computes `currentInstallationId` once via `useMemo(fn, [])` and badges each row independently. No schema change, no migration, no new RPC, no change to subscription creation/rotation/dedup/notification delivery, `removePushSubscriptionDevice` untouched, no ElevenLabs prompt/tool change.

**A real, reproduced false-negative was found and diagnosed mid-verification, then correctly explained as a testing-environment mismatch, not a code defect:** the first live check (on the PR's Vercel preview, `www.ra7etbal.com`'s Mac) showed no badge on any of the 3 listed rows. Root-caused via direct production Supabase query: both existing MacIntel rows genuinely predate the `installation_id` migration (`installation_id: null`, created 2026-07-28 and 2026-07-30) — a correct, expected no-match, not a bug. Separately, `localStorage` is strictly origin-scoped, so a preview-origin check could never see a production-origin id regardless of DB state. A second, reproducible false-positive-then-vanish was then found: tapping "Push notifications" (refresh) on `www.ra7etbal.com` correctly minted a fresh id and created a new, correctly-identified MacIntel row — confirmed stable in the database (single `created_at`/`updated_at`, `62c01899-a0e4-44b3-98f9-0358ce97a7fd`, `enabled: true`, unchanged since creation) — but the badge appeared briefly then disappeared while the panel stayed open, when checked on **`www.ra7etbal.com` itself** at that point in the process, before PR #226 was merged. Root cause: `www.ra7etbal.com` runs `main`, which did not yet contain PR #226's code at all — the instruction to check the badge there (this agent's own error, corrected mid-investigation) was structurally impossible to satisfy; whatever flashed was not this feature's code running successfully. Also explicitly ruled out and confirmed unnecessary: creating a preview-origin subscription to test positively — the preview and production Vercel deployments share the same Supabase project (no dedicated staging Supabase project exists in this repo, confirmed against `RA7ETBAL_STATE.md`'s own "Staging WhatsApp webhook environment" entry), so that would have written a second real, permanent row into the same production `push_subscriptions` table for no need.

**Tests:** `push-notifications.this-device-badge.test.ts` (new, 7 pure behavioral tests for `isCurrentDeviceRow` — exact match, non-match, null row, null current id, null-vs-null non-match, multi-row exactly-one-match, multi-row zero-match) + 3 new source-text wiring assertions extending `SettingsModal.notification-devices.test.ts` (uses the read-only getter not the mint-on-read one, renders via `isCurrentDeviceRow` not an inline platform/user-agent heuristic, imports both). Mutation-tested twice (once by this agent, independently reproduced by a separate review pass): reverting the implementation makes exactly these 10 assertions fail, all pre-existing tests in all four related files unaffected. Full `npm run test:carson-protected` (55 files, 1033 passed), typecheck, and production build all clean. Independent pre-merge review (`review:bug-hunter`): no findings — explicitly verified the `null !== null` guard, the DB-level partial unique index (`push_subscriptions_one_enabled_per_installation`) backing per-row badge independence as defense-in-depth, no accidental `localStorage` writes, no push-subscription lifecycle changes, no scope expansion.

**Production deployment:** `dpl_2M5sswvHknNHWPreAGFZGtN7RnNE` (project `ra7etbal-v2`), `state`/`readyState: READY`, `target: production`, `meta.githubCommitSha` matches the merge commit exactly.

**Live production verification (2026-08-11, `www.ra7etbal.com`, real account `645ddb96-6e09-4d91-b650-cbc75bac9a5d`), screenshot evidence captured:** Settings → Manage notification devices loads correctly; the new MacIntel row (added Aug 11) displays "This device" and the badge **remains visible** (does not disappear, resolving the earlier wrong-URL false alarm above); the iPhone row is not badged; the older, legacy (`installation_id: null`) MacIntel row is not badged; exactly one device is identified as current — matching `isCurrentDeviceRow`'s contract exactly.

Protect: the `currentInstallationId !== null` guard in `isCurrentDeviceRow` — do not remove it or a null-vs-null false positive becomes possible. `getStoredInstallationId()` staying strictly read-only — never call `getOrCreateInstallationId()` (the mint-on-read save-path function) from this panel or any other read-only view. The DB-level partial unique index as the actual per-installation uniqueness guarantee — the UI's independent per-row check relies on it. Do not attempt to badge based on `platform`/`userAgent` text matching. Reopen only on a reproduced production regression.

### Carson capability expansion

Planned, not a bug:

- Better arts, culture, destination, and local experience recommendations
- Trip curation
- Transport, hotel, restaurant, and logistics coordination
- Tool and connector access required to verify availability and execute actions

Do not fake these capabilities before the relevant tools and permissions exist.

## Working method

Every agent must read `AGENTS.md` and `SKILL.md` before changing code.

Every task must define:

- Exact outcome
- Scope
- Non-goals
- Protected behavior
- Verification plan
- Stop condition

Parallel coding agents require separate branches and separate Git worktrees.

Meaningful changes should use a maker-checker review when practical.

Sana performs live production UI testing unless she explicitly delegates it.

Production verification policy (adopted 2026-08-06, Workstream 3): browser/app-driven
features verify on the PR's Vercel preview deployment before merge; webhook-driven
features (WhatsApp inbound, delivery-status callbacks, any third-party webhook) verify
on a dedicated staging webhook environment before merge — target architecture not yet
built. Until it exists, any webhook-driven PR must document the gap as an explicit
temporary exception, not treat it as the standard. Full reasoning and the exception
procedure: `ra7etbal-v2/docs/production-verification-policy.md`.

## State update rules

After each completed task:

1. Move the item into Stable and protected when production behavior is verified.
2. Keep it under Current issues when code is complete but live behavior is not verified.
3. Record blockers precisely.
4. Remove stale plans and superseded bugs.
5. Include the relevant commit or PR reference when useful.
6. Keep this file short enough that every agent can read it at session start.
