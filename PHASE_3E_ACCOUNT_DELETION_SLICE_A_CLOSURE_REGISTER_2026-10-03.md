# Phase 3E — Account Deletion Slice A Closure Register

Date: 2026-10-03

This register records Phase 3E implementation and controlled Production closure evidence. Slice A was deployed and verified on 2026-10-03; it does not close the later deletion slices or the public 30-day deletion promise.

| Obligation | Disposition | Evidence / closure prerequisite |
|---|---|---|
| Immutable implementation baseline | CLOSED — EVIDENCE RECORDED | Pre-rollout GitHub `main` and Vercel Production both identified `0d5202c19da00a908dcd8efe097bb3ca25870692`; PR #432 merged as `44116620c063c898b0aeac971994665a84d0ae22`. |
| Durable deletion request/state | CLOSED — EVIDENCE RECORDED | Production migration `20261003094421_account_deletion_slice_a` created `account_deletion_requests`; catalog, constraint, index, RLS and live disposable-account evidence verified. |
| Minimum deletion audit evidence | CLOSED — EVIDENCE RECORDED | `account_deletion_events` records only request id, state, timestamp, and bounded failure code. One retained disposable-account transition event proved the trigger. Final retention duration is separately blocked. |
| Audit-evidence retention duration | BLOCKED — LEGAL/POLICY REVIEW REQUIRED | Engineering has no established legal/policy duration. |
| Authenticated ownership and recent authentication | CLOSED — EVIDENCE RECORDED | Production proof: anon denied; stale session denied; authenticated recent-session simulation succeeded; RPC has no target-user parameter and derives `auth.uid()`. Temporary disposable-test session timestamp was restored before commit. |
| Idempotent/replay-safe request creation | CLOSED — EVIDENCE RECORDED | Two calls returned the same active request; one request and one event remain. Partial unique index is present for concurrency defense. |
| Consequential-action freeze | CLOSED — EVIDENCE RECORDED | Exact deployed SHA contains the shared guard. Rolled-back Production DB canary accepted task/message/automation/routine inserts for unfrozen Test Account B and denied all four for frozen Test Account A. No external side effect occurred. |
| Old callbacks and retries | CLOSED — EVIDENCE RECORDED | Exact deployed SHA contains the execution-time guard coverage; protected CI passed. Existing in-flight provider cancellation remains Slice B. |
| Production migration/deployment | CLOSED — EVIDENCE RECORDED | Supabase `ggarvhgqzpooloacjgcj`; migration version `20261003094421`; PR #432 merge `44116620c063c898b0aeac971994665a84d0ae22`; Vercel deployment `dpl_8xFaiJBYz7URspkCcho8niN9RTWY` READY/Production/exact SHA; Production canary run `37114423345` passed. |
| Existing QStash/reminder/provider cancellation | DEFERRED — NAMED RELEASE STAGE: Account deletion Slice B | Slice A intentionally blocks execution on arrival but does not destructively cancel existing work. |
| Relational account-data deletion | DEFERRED — NAMED RELEASE STAGE: Account deletion relational cleanup slice | Not authorized in Phase 3E. |
| Storage/media deletion | DEFERRED — NAMED RELEASE STAGE: Account deletion Storage slice | Preserve canonical account prefix until enumeration and evidence are complete. |
| Carson history/memory/vector deletion | DEFERRED — NAMED RELEASE STAGE: Account deletion Carson data slice | Not authorized in Phase 3E. |
| Provider revocation/deletion | BLOCKED — PROVIDER VERIFICATION REQUIRED | Provider APIs, retention limits, identifiers, and evidence contracts must be verified before implementation. |
| Supabase Auth identity deletion | DEFERRED — NAMED RELEASE STAGE: Account deletion final identity slice | Must occur only after dependent cleanup and preserved minimal audit evidence; Slice A uses `ON DELETE SET NULL` for eventual finalization. |
| Six unattributed `whatsapp_inbound_evidence` rows | BLOCKED — LEGAL/POLICY REVIEW REQUIRED | Attribution/policy decision required; no guessing, deletion, or indefinite-retention assumption in this slice. |
| Public 30-day deletion promise | BLOCKED — PRODUCTION EVIDENCE REQUIRED | Keep wording unchanged; release gate remains open until implemented deletion and processor evidence substantiate it. |
| Native/App Store deletion UI | DEFERRED — NAMED RELEASE STAGE: Native deletion UX | Final native build and complete backend lifecycle required first. |
| Slice A disposable-account verification | CLOSED — EVIDENCE RECORDED | Used labelled disposable Test Account A (zero business rows) and Test Account B. A's request/event intentionally remain authoritative; all representative business inserts were rolled back. No Auth identity deletion or provider action occurred. |
| Slice A performance-advisor findings | FIX BEFORE RELEASE | Add a covering index for `account_deletion_events.request_id` and evaluate `(select auth.uid())` policy form. These are performance findings, not a security or Slice A correctness failure. |
| Existing Node `DEP0169` scheduler warnings | FIX BEFORE RELEASE | Post-deploy Vercel inspection found the pre-existing `url.parse()` warning on reminder/escalation scheduler routes; no Slice A runtime errors were found. |

Production mutations represented here are limited to the additive Slice A migration, the retained disposable Test Account A request/event, PR #432 merge, and its normal Vercel deployment. No account data, Storage object, Carson memory, Auth identity, provider resource, or real household content was deleted or changed.
