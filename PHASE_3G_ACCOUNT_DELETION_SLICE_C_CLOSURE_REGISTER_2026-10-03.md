# Phase 3G — Account Deletion Slice C Closure Register

Date: 2026-10-04
Status: CLOSED — DEPLOYED AND PRODUCTION VERIFIED

## Baseline

- Authoritative implementation base: `5d83eb93bb966be83e60de27216bc69be96f2114` (`origin/main`).
- Slice A `44116620c063c898b0aeac971994665a84d0ae22` and Slice B `d290b201a9237ad32c59bdec69ebfa34566dc8f0` are ancestors.
- No commits after the Slice B closure materially altered the deletion architecture.
- PR #437 reviewed head: `9d822018be90caa0b3719ed3ef4181e1a04bc546`; merge SHA: `0a15d6f19730442d8a4da9ec85e8375e26afe164`.
- Production migration: `20261004083856_account_deletion_slice_c` on Supabase project `ggarvhgqzpooloacjgcj`.
- Production deployment: `dpl_8MWinKpf4vJRK9HTG6AiKTFAHZ14`, READY, exact merge SHA, canonical aliases attached.
- Destructive real-user deletion: **NONE**. Production mutations were limited to the reviewed migration and labelled disposable canary data.

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
- Production schema: PASS. Migration `20261004083856_account_deletion_slice_c` is recorded; RLS is enabled on both new tables; anon/authenticated cannot execute destructive RPCs; service role can; 24 frozen-account insert triggers exist; Slice A/B functions/tables remain present.
- Production two-account canary: PASS. Request `c3c00000-0000-4000-8000-000000000003`; Account A `a3c00000…`; Account B `b3c00000…`. Both identities are labelled disposable `example.com` records. No real-user data was used.
- Production resource truth: A deleted 8 Carson rows, 2 operational rows, 2 communication rows and 2 notification/preference rows. All eight B Carson stores remained, together with its task/message/push records; a post-delete B insert succeeded.
- Production idempotency/freeze: PASS. Completed-stage replay returned false; post-delete A memory recreation was rejected with SQLSTATE `55000`; Slice B recorded the disposable pending task and pending operation as `locally_invalidated`.
- Production dependency preservation: PASS. Seven cleanup references remain: three Storage paths, two WhatsApp IDs, one ElevenLabs conversation ID and one provider phone-number ID. No Storage object existed at those canary paths and none was deleted. A's Auth user, profile, People and consent remain. All 35 inbound-evidence rows remain.
- Production deployment/health: canonical site HTTP 200; no new Slice C runtime error observed. The pre-existing Node `DEP0169` warning remains separate.

## No-floating-work register

| Obligation | Disposition | Release impact / closure prerequisite |
|---|---|---|
| Slice C code and additive migration | CLOSED — DEPLOYED AND PRODUCTION VERIFIED | PR #437, migration `20261004083856_account_deletion_slice_c`, deployment `dpl_8MWinKpf4vJRK9HTG6AiKTFAHZ14`. |
| Production migration/deployment/canary | CLOSED — EVIDENCE RECORDED | Disposable two-account isolation, eight-store deletion, replay/freeze and dependency-preservation evidence recorded above. |
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
