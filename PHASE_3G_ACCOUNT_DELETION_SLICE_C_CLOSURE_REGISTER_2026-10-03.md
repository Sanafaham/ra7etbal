# Phase 3G — Account Deletion Slice C Closure Register

Date: 2026-10-03
Status: IMPLEMENTED / NON-PRODUCTION VERIFIED / OWNER REVIEW REQUIRED

## Baseline

- Authoritative base: `5d83eb93bb966be83e60de27216bc69be96f2114` (`origin/main`).
- Slice A `44116620c063c898b0aeac971994665a84d0ae22` and Slice B `d290b201a9237ad32c59bdec69ebfa34566dc8f0` are ancestors.
- No commits after the Slice B closure materially altered the deletion architecture.
- Branch: `codex/phase3g-account-deletion-slice-c`.
- Production changes and destructive real-user deletion: **NONE**.

## Authoritative current deletion matrix

| Resource | Ownership/dependency | Slice C disposition | Evidence/remaining prerequisite |
|---|---|---|---|
| `carson_facts`, `carson_persistent_memory` | Direct `user_id`; no Auth FK | DELETE | Explicit trusted-server delete closes known survivor paths. |
| `carson_memory` | Direct `user_id`; Auth FK NO ACTION | DELETE | Explicit delete prevents later Auth deletion from being blocked. |
| `carson_notes`, `carson_todos`, `carson_pending_operations`, `carson_tool_diagnostics`, `carson_typed_messages` | Direct `user_id`; typed rows carry ElevenLabs correlation | DELETE after minimal provider reference capture | Stale inserts blocked while request remains frozen. |
| Tasks, attachments, confirmations, reminders, automations/runs, routines | Direct owner or task-dependent; Slice B must first have no pending/unknown/retryable cancellation | DELETE after Storage path capture | Storage objects themselves remain later. Confirmation rows follow task FK cascade. |
| Messages, staff messages/decisions, owner reply receipts, personal contact replies, WhatsApp deliveries, substitute decisions | Direct `user_id` with child-before-parent FK ordering | DELETE after minimum provider-ID capture | `personal_contact_replies` explicit deletion closes its no-Auth-FK survivor path. |
| Notifications, push subscriptions, OAuth state nonces, household rules, inboxes, WhatsApp health state | Direct `user_id` | DELETE; capture provider phone-number reference first | Push endpoint and transient state are removed. |
| `people`, `whatsapp_consent_log` | Direct owner; consent depends on People and may be retention evidence | RETAIN FOR LATER | BLOCKED — LEGAL/POLICY DECISION REQUIRED. No silent cascade. |
| `profiles` | Auth identity plus Google/provider credentials | RETAIN FOR LATER | Provider revocation must precede profile/Auth removal. |
| `whatsapp_inbound_evidence` | No owner key/FK; immutable trigger | BLOCKED / UNTOUCHED | Read-only Production recheck: 35 total, 29 uniquely attributable, 6 unresolved, 0 ambiguous. OWNERSHIP / RETENTION POLICY REQUIRED. |
| Storage objects | External to relational cascade | RETAIN FOR LATER | Exact task/attachment/photo paths captured service-only; no object deleted. |
| Provider-side data | External | RETAIN FOR LATER | WhatsApp/ElevenLabs/phone identifiers captured where present; provider verification and authorization required. |
| Auth user, sessions, account request/events/cancellation/results | Workflow identity/evidence | RETAIN FOR LATER | Auth last; evidence-retention duration requires legal/policy decision. |

## Architecture, ordering and truthfulness

`account_deletion_requests` remains the sole lifecycle record. Slice C adds stage status, timestamps, bounded failure code and lease fields. `account_deletion_resource_results` records only resource class, disposition and count. `account_deletion_cleanup_references` is service-only and contains only later-stage object/provider identifiers—not task text, messages, contacts, transcripts, notes, facts or instructions.

Eligibility requires an active frozen request and no Slice B cancellation in pending, attempted, unknown or retryable state. Claiming is `FOR UPDATE SKIP LOCKED`; the client cannot supply a victim `user_id`. Execution locks the claimed request, derives `user_id`, validates the unexpired lease, captures later-stage references, deletes child-to-parent, records outcomes and completes the Slice C stage in one transaction. A database error rolls back the deletion transaction; the worker records a bounded retryable failure with a separate lease-fenced RPC. Reclaim after failure/lease expiry is safe. A completed stage cannot execute again.

Slice C completion is not account-deletion completion. The overall request remains frozen/in progress. Outcomes explicitly retain People/consent, profiles/provider credentials and Storage, and block inbound evidence.

## Security and verification evidence

- Destructive RPCs: service role only; `PUBLIC`, `anon` and `authenticated` execute revoked.
- `SECURITY DEFINER` functions use `search_path = ''` and schema-qualified objects.
- Owner-readable results use request-owner RLS. Cleanup references have no client policy or grant.
- Disposable PostgreSQL 17 test: PASS. Account A rows removed from all 29 exercised owner tables; Account B retained one row in every corresponding table and remained insert-capable. Shared/retained records survived.
- Lease/retry/idempotency: PASS. Concurrent second claim returned no work; forced retryable transition released the lease; reclaim completed; repeat execution returned false.
- Carson memory: PASS for all eight current stores; post-delete insert for frozen A failed with SQLSTATE `55000`; B remained unchanged.
- Dependency preservation: PASS. Eight expected cleanup references and eight truthful resource-class results persisted; no personal-content field exists in cleanup evidence.
- Focused Vitest: 9/9 PASS. Slice A/B focused regression: 51/51 PASS. Protected pretest: 126/126 PASS. Full protected suite after integration correction: 2,819 passed, 4 skipped, 3 todo, 0 failed.
- Registry validation: PASS (28 capabilities). State integrity: 22/22 PASS. Impact map: 35/35 PASS.
- Production schema/data access during this phase was read-only. Migration `20261003_account_deletion_slice_c.sql` was **not** applied to Production.

## No-floating-work register

| Obligation | Disposition | Release impact / closure prerequisite |
|---|---|---|
| Slice C code and additive migration | READY FOR OWNER REVIEW / MERGE-ROLLOUT AUTHORIZATION | Complete remaining protected/type/build/CI review, then separate approval for rollout. |
| Production migration/deployment/canary | DEFERRED — SLICE C ROLLOUT | Requires explicit owner authorization; disposable accounts only. |
| Real QStash confirmed-cancellation evidence | KEEP — VERIFIED REQUIRED | Real disposable scheduled message; does not block local freeze or this patch review. |
| People and consent treatment | BLOCKED — LEGAL/POLICY DECISION REQUIRED | Define retention/deletion basis before later relational closure. |
| Inbound WhatsApp evidence | BLOCKED — OWNERSHIP / RETENTION POLICY REQUIRED | Authoritative attribution design plus unresolved-row policy; no heuristic deletion. |
| Storage objects | DEFERRED — SLICE D | Use preserved canonical paths; explicit Production authorization required. |
| Google/provider credentials and provider-held data | BLOCKED — PROVIDER VERIFICATION REQUIRED | Verify revocation/deletion APIs and evidence semantics before provider slice. |
| Supabase Auth identity and remaining sessions | DEFERRED — FINAL IDENTITY SLICE | Only after Storage/provider/policy dependencies reach required terminal states. |
| Audit/evidence retention duration | BLOCKED — LEGAL/POLICY DECISION REQUIRED | Define purpose and duration; do not silently retain forever. |
| Public 30-day deletion wording | BLOCKED — IMPLEMENTATION + POLICY EVIDENCE REQUIRED | Must not claim completion until all terminal evidence exists. |
| Slice A event FK/RLS performance advisories | DEFERRED — BEFORE RELEASE | Covering index and init-plan optimization remain separate, non-correctness work. |
| Existing Node `DEP0169` scheduler warning | DEFERRED — BEFORE RELEASE | Pre-existing; no Slice C regression evidence. |

## Next bounded slice

Slice D is Storage/media deletion using the preserved object-path manifest, with strict owner correlation, object-level idempotency, partial/unknown outcome evidence, two-account isolation and disposable-only verification. It must not delete provider data or Auth identity and must not start without explicit owner authorization.

Rollback warning: the schema patch is additive before execution, but no rollback can restore relational content after Slice C has run. Rollout therefore requires migration-before-runtime ordering, disposable Production proof, monitoring and an explicit go/no-go gate.
