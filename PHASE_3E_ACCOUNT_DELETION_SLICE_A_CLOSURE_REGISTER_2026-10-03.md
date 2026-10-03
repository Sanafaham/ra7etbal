# Phase 3E — Account Deletion Slice A Closure Register

Date: 2026-10-03

This register records Phase 3E implementation obligations only. It does not authorize or claim any Production mutation.

| Obligation | Disposition | Evidence / closure prerequisite |
|---|---|---|
| Immutable implementation baseline | READY FOR REVIEW | GitHub `main`, merged PR #431, and the public Production bundle identify `0d5202c19da00a908dcd8efe097bb3ca25870692`. The earlier `031ad2b` observation came from a stale/misconfigured local mirror. |
| Durable deletion request/state | READY FOR IMPLEMENTATION AFTER OWNER APPROVAL | Local migration creates `account_deletion_requests`, one-active-request constraint, lifecycle states, timestamps, and correlation UUID. Production migration not applied. |
| Minimum deletion audit evidence | READY FOR IMPLEMENTATION AFTER OWNER APPROVAL | `account_deletion_events` records only request id, state, timestamp, and bounded failure code. Final retention duration is separately blocked. |
| Audit-evidence retention duration | BLOCKED — LEGAL/POLICY REVIEW REQUIRED | Engineering has no established legal/policy duration. |
| Authenticated ownership and recent authentication | READY FOR IMPLEMENTATION AFTER OWNER APPROVAL | RPC has no user-id parameter, derives `auth.uid()`, validates JWT session id against a matching non-expired `auth.sessions` row created within 15 minutes, and grants execution only to `authenticated`. |
| Idempotent/replay-safe request creation | READY FOR IMPLEMENTATION AFTER OWNER APPROVAL | Partial unique index plus existing-row return and unique-violation recovery. |
| Consequential-action freeze | READY FOR IMPLEMENTATION AFTER OWNER APPROVAL | Shared guard, direct-insert triggers, protected registry entry, focused tests. Production deployment still separately gated. |
| Old callbacks and retries | READY FOR IMPLEMENTATION AFTER OWNER APPROVAL | Due reminders, delegation/routine/automation sweep, owner command retries, personal-contact retries, and no-response handoffs check the account state at execution time. |
| Production migration/deployment | BLOCKED — PRODUCTION EVIDENCE REQUIRED | Requires owner-approved migration/RLS/grant review, controlled deployment, disposable-account verification, and rollback decision. |
| Existing QStash/reminder/provider cancellation | DEFERRED — NAMED RELEASE STAGE: Account deletion Slice B | Slice A intentionally blocks execution on arrival but does not destructively cancel existing work. |
| Relational account-data deletion | DEFERRED — NAMED RELEASE STAGE: Account deletion relational cleanup slice | Not authorized in Phase 3E. |
| Storage/media deletion | DEFERRED — NAMED RELEASE STAGE: Account deletion Storage slice | Preserve canonical account prefix until enumeration and evidence are complete. |
| Carson history/memory/vector deletion | DEFERRED — NAMED RELEASE STAGE: Account deletion Carson data slice | Not authorized in Phase 3E. |
| Provider revocation/deletion | BLOCKED — PROVIDER VERIFICATION REQUIRED | Provider APIs, retention limits, identifiers, and evidence contracts must be verified before implementation. |
| Supabase Auth identity deletion | DEFERRED — NAMED RELEASE STAGE: Account deletion final identity slice | Must occur only after dependent cleanup and preserved minimal audit evidence; Slice A uses `ON DELETE SET NULL` for eventual finalization. |
| Six unattributed `whatsapp_inbound_evidence` rows | BLOCKED — LEGAL/POLICY REVIEW REQUIRED | Attribution/policy decision required; no guessing, deletion, or indefinite-retention assumption in this slice. |
| Public 30-day deletion promise | BLOCKED — PRODUCTION EVIDENCE REQUIRED | Keep wording unchanged; release gate remains open until implemented deletion and processor evidence substantiate it. |
| Native/App Store deletion UI | DEFERRED — NAMED RELEASE STAGE: Native deletion UX | Final native build and complete backend lifecycle required first. |
| Destructive verification | BLOCKED — PRODUCTION EVIDENCE REQUIRED | Must use controlled disposable accounts, never Sana's real account, after separate authorization. |

No Production change, destructive deletion, provider action, commit, merge, or deployment is represented by this register.
