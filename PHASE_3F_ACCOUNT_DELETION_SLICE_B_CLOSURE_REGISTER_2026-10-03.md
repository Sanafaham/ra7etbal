# Phase 3F — Account Deletion Slice B Closure Register

Status: **IMPLEMENTED AND LOCALLY VERIFIED — NOT DEPLOYED**

| Obligation | Disposition | Evidence / closure prerequisite |
|---|---|---|
| Pre-existing reminder execution | CLOSED — EVIDENCE RECORDED (local) | Slice A execution-time guard remains authoritative; Slice B inventories QStash IDs and adds retryable external cancellation evidence. Production rollout verification required. |
| QStash cancellation | KEEP — VERIFIED REQUIRED | Provider `DELETE /v2/messages/{id}` is attempted by the authenticated scheduler. `2xx` and provider `404` are recorded as confirmed absent/cancelled; timeout is unknown, never success. Verify with disposable Production reminder. |
| pg_cron safety net | BLOCKED — PRODUCTION EVIDENCE REQUIRED | Architecture is a generic sweep and must not be deleted per account. Local execution guards are present; exact live pg_cron identity/configuration remains unproven. |
| Active automations and non-terminal runs | CLOSED — EVIDENCE RECORDED (local) | Inventoried as locally invalidated; the durable deletion tombstone and execution guards prevent continuation. Historical rows are preserved. |
| Pending Carson operations | CLOSED — EVIDENCE RECORDED (local) | Inventoried and atomically transitioned from `pending` to `cancelled`; replay is idempotent. |
| Outstanding task confirmations | CLOSED — EVIDENCE RECORDED (local) | POST confirmation and authenticated owner-decision paths fail closed before mutation/provider execution. |
| WhatsApp already accepted by Meta | NOT APPLICABLE — EVIDENCE RECORDED | Provider-accepted delivery cannot truthfully be recalled by this architecture. Slice B blocks only new continuation; provider-side history deletion is a later slice. |
| Calendar queued work | NOT APPLICABLE — EVIDENCE RECORDED | No server-side calendar job queue exists; pending weekly-plan operations are invalidated and calendar API execution retains the Slice A guard. |
| Generic scheduler deletion | NOT APPLICABLE — EVIDENCE RECORDED | Shared QStash/pg_cron sweeps serve all tenants; per-account deletion is enforced through tenant state, not global scheduler removal. |
| Audit-evidence retention duration | BLOCKED — LEGAL/POLICY REVIEW REQUIRED | Slice B does not invent or publish a duration. |
| Six unattributed inbound-evidence rows | BLOCKED — LEGAL/POLICY REVIEW REQUIRED | Unchanged from Slice A closure. |
| Provider deletion/revocation capability | BLOCKED — PROVIDER VERIFICATION REQUIRED | Outside Slice B; cancellation of scheduled QStash messages is not provider-data deletion. |
| Public 30-day complete-deletion promise | FIX BEFORE RELEASE | Slice B alone does not satisfy complete account deletion. |
| Relational, Storage, Carson-memory, provider-data and Auth deletion | DEFERRED — NAMED RELEASE STAGE | Separate bounded deletion slices; not implemented here. |
| Slice B Production rollout | KEEP — VERIFIED REQUIRED | Apply additive migration first, deploy runtime second, use disposable identities/work only, verify evidence/tenant isolation/retry behavior, then update this register to Production verified. |

Production mutations during implementation: **NONE**.
