# Safety rule: duplicate follow-up prevention

**Status: fixed and verified in production. This document exists so the fix is never accidentally reverted.**

## 1. Historical root cause

**Incident:** a staff member (Christopher, task `f2c557c0-8343-42c0-8fb2-e91eeb9226b1`) received **4 independent follow-up WhatsApp messages** for the same task within 0.6 seconds. Three other tasks in the same batch (Ghulam, Nasira, Grace) received 3–4 duplicates each.

**Why it happened — two compounding causes:**

1. **Fan-out trigger overlap.** `api/qstash-reminder.js` (`schedule-escalation` action) publishes a **per-task** QStash message for each delegation task, timed to fire ~10 minutes after task creation (`dedupId: followup-${taskId}`, `notBefore = created + 10min`). Separately, `api/process-delegation-escalations.js` is also invoked by a **periodic** QStash cron every 10 minutes and processes **every** due task in one batch. When a batch of tasks was created together (e.g. a guest-prep plan with 4 recipients), their per-task triggers and the periodic sweep landed in the same ~10-minute window, producing multiple concurrent invocations of the batch endpoint.

2. **Non-atomic guard (the actual bug).** The follow-up logic was *check → send → stamp*:
   ```js
   const followupDue = ageMs >= followupThresholdMs && !task.followup_sent_at; // stale in-memory read
   if (followupDue) {
     const sent = await sendFollowupWhatsApp({ task, ... });        // SEND FIRST
     if (sent) await stampColumn(..., 'followup_sent_at', now);      // STAMP AFTER
   }
   ```
   Every concurrent invocation independently `SELECT`ed the task, saw `followup_sent_at = NULL`, passed the in-memory check, and called `sendFollowupWhatsApp` — because the guard was only written *after* a successful send, it was already too late to stop the siblings that had read `NULL` moments earlier.

Evidence (Supabase, `whatsapp_deliveries` table, `source_type='followup'`): 14 sends across 4 single-message tasks, each task having exactly 1 `messages` row and 1 delegation delivery (ruling out row-level fan-out — the duplication was purely at the send-guard layer).

## 2. The fix

Commit `ddd17f2` (`api/process-delegation-escalations.js`): reordered the flow to **claim → send → release-on-failure**.

```js
// claimFollowupGuard: atomic conditional UPDATE, claimed iff exactly 1 row returned
PATCH /tasks?id=eq.<id>&followup_sent_at=is.null   (Prefer: return=representation)
  { followup_sent_at: now }

// processFollowupDueTask:
const claimed = await claimFollowupGuard(...);
if (!claimed) return { claimed: false, sent: false };   // another invocation already has it
const sent = await sendFollowupWhatsApp(...);
if (!sent) await releaseFollowupGuard(...);              // explicit failure → allow a later retry
```

Postgres serializes concurrent `UPDATE`s to the same row. Exactly one concurrent request's `WHERE followup_sent_at IS NULL` clause is still true when Postgres applies it; every other request — whether from this run or an overlapping invocation — gets zero rows back and must not send. The claim is durable in Postgres from the moment it's written, independent of what happens to the send afterward (see §5).

## 3. Are the guards durable?

Yes. `followup_sent_at` / `escalated_at` are plain columns on the `tasks` table — ordinary relational storage, not an in-memory cache or per-instance state. They:
- Survive serverless cold starts, redeploys, and process restarts (each invocation is a fresh Lambda with no shared memory).
- Are read fresh via `SELECT` and written via a real Postgres transaction on every check — no caching layer sits between PostgREST and Postgres for these calls.
- Are enforced by Postgres's row-level locking on `UPDATE`, which is atomic and consistent regardless of how many concurrent HTTP requests are in flight.

## 4. Concurrent cron / QStash runs — verified safe

**Automated (regression tests, `api/process-delegation-escalations.followup-guard.test.js`):**
- `claimFollowupGuard` claims once, rejects an already-claimed row, fails closed on a PATCH error.
- `processFollowupDueTask` called via `Promise.all` for **2** and **4** simulated concurrent invocations of the *same task* (modeling the exact historical scenario: the per-task QStash trigger racing the periodic sweep) → exactly 1 claim, exactly 1 send, exactly 1 call to `/api/send-whatsapp-task`, in every case.
- A second `claimFollowupGuard` call after the first has already claimed is rejected.

**Live production verification (2026-07-02, task `491c75bb-27ce-4fda-8b95-ad2fdce34ba8`, real delegation to Grace, natural QStash cron only — no manual triggers):**
- `14:30:02Z` cycle: task correctly excluded as not-yet-due (created after the cutoff).
- `14:40:00Z` cycle (only invocation in the entire window): `followup guard claim: claimed=true` → one send → `followup_sent_at = 2026-07-02T14:40:01.221Z`. Exactly **1** `whatsapp_deliveries` row (`delivered`, `attempt_count: 1`).
- `14:50:02Z` cycle: `follow-up guard already set` → correctly skipped re-send. Escalation fired once (`escalated_at` stamped once), fanned out to the owner's 2 push subscriptions (one escalation *event*, not a duplicate).
- No second `/api/process-delegation-escalations` invocation occurred at any point in the 27-minute observation window (Vercel runtime logs, `dpl_EDZEXZoWorTYo1WpbAB7bRBR1zkw`).

## 5. Retries cannot create duplicate WhatsApp messages

Three retry sources exist; all are safe under the current design:

- **QStash automatic retries** (`Upstash-Retries: 3` on the per-task publish in `qstash-reminder.js`): if the whole batch endpoint fails or times out *after* a task's guard has already been claimed, a retry re-`SELECT`s and sees `followup_sent_at` non-null → skipped before any send is attempted. The claim is written *before* the send, so a mid-flight crash after claiming never produces a duplicate — at worst it produces a missed follow-up (safer failure direction), not a duplicate one.
- **Template-shape fallback inside `send-whatsapp-task.js`**: the `attempts` loop (`primary-body-link`, `fallback-body-link`, …) tries alternate Meta payload shapes only on failure and `break`s on the first success (`if (templateResult.ok) break;`) — never sends twice for one call.
- **Controlled release-and-retry**: `releaseFollowupGuard` only runs after `sendFollowupWhatsApp` returns a definitive `false` (Meta explicitly rejected, or a resolvable precondition failed) within the *same* invocation that held the claim — never from an external timeout or a second invocation guessing at failure.

## 6. Deployment transitions

Each QStash-triggered request resolves to whatever code is currently promoted to production at request time — there's no shared in-memory guard state that could be "stale" across a deploy. The theoretical edge case is an **old-code invocation still executing when a new deploy promotes**, since old code (pre-`ddd17f2`) sent before checking a guard at all. This is not the historical failure mode (that was same-version concurrent execution) and is not currently exploitable — old code no longer exists in the deployed fleet. It remains a reason the rule in §8 must hold for any future change to this file: **if claim-before-send is ever reverted, even briefly, a deploy-transition race becomes possible again.**

## 7. Regression tests

`api/process-delegation-escalations.followup-guard.test.js` — 9 tests (8 general-purpose + 1 named for the exact historical incident):
- `claimFollowupGuard`: claims / rejects-already-claimed / fails-closed-on-error.
- `releaseFollowupGuard`: clears the guard for retry.
- `processFollowupDueTask` under 2 and 4 concurrent invocations of the same task → exactly 1 send each time.
- **`reproduces the exact Christopher/f2c557c0 incident shape: per-task QStash trigger racing the periodic sweep sends exactly once`** — named explicitly for this incident so a future reader cannot mistake its purpose.
- Failed send releases the guard; a second claim after the first succeeds is rejected.

Run: `npm test -- api/process-delegation-escalations.followup-guard.test.js`

## 8. The permanent safety rule

> **Never write a guard/idempotency column after a side-effecting call. Always claim it with an atomic conditional UPDATE (`WHERE column IS NULL`, checking rows-returned) *before* the side effect, and only perform the side effect if the claim succeeded. If the side effect fails, explicitly release the claim from within the same invocation — never rely on an external timeout or retry to "notice" a failure.**

This rule is stated at the top of `api/process-delegation-escalations.js` next to the code it governs, and enforced by the regression tests in §7. Any new one-shot scheduled action (a new escalation tier, a new automation type, etc.) added to this file or a similar poller must follow the same claim-before-act pattern.
