# Ra7etBal Current State

Last updated: 2026-07-22

This file is the operational source of truth for agents working in this repository. Update it whenever a task changes what is complete, protected, blocked, or next.

## Product

Ra7etBal is a personal Chief of Staff that reduces mental load. Carson is the AI Chief of Staff.

Typed Carson and voice Carson are the same person. They must use the same rules, tools, state transitions, memory, and operational logic.

## Stable and protected

Do not modify these areas without a reproduced regression or explicit product decision.

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

### Recurring owner reminders

Status: completed and production verified.

Do not reopen without a reproduced regression.

Personal recurring reminders must not be converted into staff WhatsApp delegations when the owner's name also exists in the people table.

### Type to Carson V1

Status: implemented and tested.

Protect:

- Same production Carson agent as voice
- Persistence and history restore
- Clear Chat
- Image attachment and image understanding
- To-do creation
- Preview allowlisting
- Tool authority and deterministic operational actions

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

### WhatsApp owner decision template

Status: pending Meta approval or final live validation.

Dynamic task URL requirement:

`https://www.ra7etbal.com/confirm?task={{1}}`

Ra7etBal supplies only the task UUID.

After approval, live-test:

- Approve Alternative
- Reject Alternative
- Custom Instruction

Protect normal delegations, proof upload, worker replies, routine templates, and Quality Intelligence.

## Known current issues and near-term priorities

### Transport-independent staff communication engine (Issue #46)

Status: implemented, merged (PR #47, merge commit `e7a8e56c59b27f6f3857d68c0a2ec3b825ac5353`), deployed to production (`www.ra7etbal.com`). No live production UI testing performed (per task scope — this was a backend engine with a focused test harness, not a UI change).

What it is: a canonical, transport-independent pipeline that lets a staff member's message be classified, answered directly or escalated, and persisted — without ElevenLabs or WhatsApp, both currently blocked/unavailable transports. There is still only one Carson: this is the first place Carson's staff-facing reasoning runs as a direct Claude call rather than only inside the ElevenLabs dashboard-configured agent (see `api/_carson-agent-turn.js`, an existing read-only PoC that tunnels into ElevenLabs — untouched, not reused, since it depends on the currently-blocked transport). Any future transport (WhatsApp inbound, a rebuilt ElevenLabs bridge) must call through this same module.

Schema: new table `public.staff_messages` (migration `supabase/migrations/20260720_create_staff_messages.sql`), with four `SECURITY DEFINER` functions as the only insert/update path: `claim_staff_message` (atomically verifies person_id/task_id belong to the caller's user_id and that the sender is not `is_family`, idempotent on `(user_id, source, external_message_id)`), `complete_staff_message` (claimed → completed, idempotent no-op if already completed), `fail_staff_message` (claimed → failed), `retry_staff_message` (failed → claimed, explicit recovery only, returns `is_retried` so callers can't double-process a losing race). RLS: owner-only `SELECT`; `EXECUTE` on all four functions revoked from `PUBLIC`/`anon`/`authenticated`, granted only to `service_role`. Applied to the live Supabase project (`ggarvhgqzpooloacjgcj`) and verified with temporary fixtures (cross-household rejection, family exclusion, idempotency including source-scoping, full claimed/completed/failed/retried state machine, person-deletion history preservation) — all fixtures fully cleaned up, zero residue, confirmed by count query.

Application layer: `api/_staff-comms-engine.js` (`processStaffMessage`), underscore-prefixed so it doesn't count against the Hobby 12-function cap. Loads person/task/household-rules/recent-memory context scoped by `user_id`, calls Claude directly (`claude-sonnet-4-6`, same pattern as `api/_quality-review.js`) with a narrow staff-reply system prompt, strictly re-validates the model's JSON output against the DB's own enums before trusting it, and never writes to `public.tasks` — a `completion_confirmation` classification only marks the staff *message* `Completed`, never the underlying task (that stays exclusively inside the protected `api/task-confirm.js` proof/confirmation pipeline).

Test interface: `api/_staff-comms-engine.test.js`, 12 focused Vitest tests (all passing) covering the 8 scenarios from issue #46 plus Claude-failure handling and pure-function edge cases — the preferred "focused test harness" option per the issue, so no new API route or Hobby-cap slot was used.

Independent review (separate agent, `review:bug-hunter`): 0 critical/high/medium findings across second-Carson risk, cross-household leakage, idempotency, false completion, accidental ElevenLabs/WhatsApp changes, and test-meaningfulness (2 findings mutation-tested to confirm the tests actually fail without the implementation). One Low/nit, not a blocker: if `fail_staff_message` itself throws inside the outer catch block's nested try/catch, the row is left silently stuck in `claimed` with no distinguishing signal — logged at the same level as normal errors. Left as a documented follow-up, not fixed in this task (narrow, pre-existing-shape gap, not a regression risk to protected behavior).

Remaining for issue #46, deferred until ElevenLabs is unblocked (explicit non-goal of this task): wiring an actual transport (WhatsApp inbound or ElevenLabs) to call `processStaffMessage`; owner-facing UI surfacing of escalations (currently persisted on `staff_messages.escalation_reason`/`user_facing_state`/`next_action_owner` only, not yet shown in any UI — "do not redesign the UI" was an explicit non-goal here).

Protect: this table/module design must not be duplicated by a future transport integration — reuse `processStaffMessage`, do not build a second reasoning path.

### Owner visibility for staff communications V1

Status: implemented. Not yet merged, PR open against `main`.

What it is: a read-only "Staff" tab added to the existing Updates screen (`src/routes/Updates.tsx`, the same tab bar that already hosts Needs You / Waiting / To-do / Notes / Automations / History), showing every `staff_messages` row the owner is allowed to see: staff name, their message, Carson's response (when present), the current state (Waiting / Needs You / Completed / In Progress), who owns the next action, the exact decision needed (when `owner_attention_required` is true), when the message arrived, and linked task context when available. No reply, approve/reject, or outbound-messaging controls — display only.

UI location: `/updates?tab=staff`.

Files: `src/types/staff-message.ts` (new type), `src/lib/staff-messages.ts` (new — `listStaffMessages()`, RLS-only, no manual `user_id` filter, same anon-key `supabase` client as `messages.ts`/`people.ts`/`tasks.ts`; `getStaffMessageDisplayState()` implementing the exact Needs-You-if-either-signal-is-true rule from the spec, nothing invented), `src/routes/StaffUpdates.tsx` (new — a stateful data-fetching wrapper plus pure, hook-free `StaffUpdatesView`/`StaffMessageCard` exports so rendering logic is unit-testable without a DOM/testing-library dependency), `src/routes/Updates.tsx` (edited — one new tab entry + one new conditional render block, mirroring how To-do/Notes/Automations already render as self-contained `headerless` components). Card styling reuses `TaskCard.tsx`'s existing badge language (`rounded-full border ... text-[10px] font-medium uppercase tracking-wide`, rose/amber/sky/emerald semantics) rather than inventing new visual language. No schema change, no new dependency, no new state-management layer (plain `useState`/`useEffect`, matching `Inbox.tsx`'s existing pattern for a self-contained tab).

Internal fields (`processing_status`, `processing_error`, `external_message_id`, `user_id`, `person_id`, `thread_id`, `source`, raw row `id`) are never selected by the query and never rendered — `id` is used only as a React list key.

Tests: `src/lib/staff-messages.test.ts` (6) + `src/routes/StaffUpdates.test.tsx` (14) — the 10 scenarios required by this task (empty state, Needs You with escalation reason, Waiting with next-action-owner, Completed label, Carson response shown/omitted safely, linked task context shown/omitted safely, internal fields never rendered, fetch error contained without breaking the parent screen, no cross-household filter surface). Plus `src/routes/Updates.test.ts`'s pre-existing 6-tab regression guard updated to 7 tabs (this branch's own change legitimately added the 7th; the guard now protects against an 8th being silently added). 34/34 passing. Typecheck and production build both clean.

Independent review (separate agent, `review:bug-hunter`, mutation-tested): zero write paths, zero service_role reference, zero cross-household exposure surface, zero duplication of `daily-brief.ts`/`needs-you-timestamp.ts` logic, zero internal-field leakage — all confirmed via mutation testing (introducing each failure mode and confirming the relevant test catches it, then reverting). One High finding (the stale 6-tab regression-guard test) — fixed before delivery.

Known limitation: no live transport (WhatsApp/ElevenLabs) calls `processStaffMessage()` yet, so this tab is expected to show its empty state ("No staff messages need your attention.") in production until a transport is wired — this is truthful, not a bug, and the empty-state copy never mentions ElevenLabs, transports, or implementation status.

Protect: this is a read-only view. Do not add write/reply/approve controls here without a separate, explicitly-scoped task.

### Typed Carson delegation execution regression fix

Status: implemented. Not yet merged.

Confirmed production regression: Talk to Carson (voice) executes both direct messages and delegations correctly. Type to Carson executed direct messages correctly but silently failed simple delegations — "Ask Ghulam to bring the car out." made Carson reply "Ghulam has it" with no real delegation row and no WhatsApp task sent.

Root cause: Type to Carson's tool-calling path depends entirely on the ElevenLabs text model choosing to invoke `send_delegation`/`execute_instruction`. For simple single-person delegation wording, the model could return a natural-language reply without calling any tool, so `executeDelegationFastPath` (already used for voice) never ran. The deterministic direct-message path had no equivalent gap because typed direct-message wording reliably triggers a tool call; delegation wording did not.

Fix: `sendTypedMessage` in `ElevenLabsAgentWidget.tsx` now runs the existing, unmodified `executeDelegationFastPath` + `sendDelegation` deterministically for a fresh typed owner turn, immediately before the instruction would otherwise be sent to ElevenLabs — same executor, same task creation, same `ra7etbal_task_v3` WhatsApp delivery and confirmation-link path as voice. Excluded (falls through to the existing model-driven flow unchanged): pending photo, recurring language, instructions matching the protected direct-message grammar (`parseSimpleDirectMessage`), and multi-person/personal-note/ambiguous wording (already excluded by `parseDelegationFastPath` itself). No second delegation implementation was created.

Focused tests passed: 9 new (`ElevenLabsAgentWidget.typed-delegation-execution.test.ts`) + 25 existing `delegation-fast-path.test.ts` + 18 existing `ElevenLabsAgentWidget.typed-mode.test.ts` + 3 existing `ElevenLabsAgentWidget.direct-message-parity.test.ts` + 27 existing `direct-message-fast-path.test.ts` = 82/82. Typecheck passed. Build passed. Full suite not re-run per this task's narrow scope.

Protect: Talk to Carson / voice tool routing (untouched), the protected direct-message baseline from PR #29 (`ra7etbal_direct_operational_message`, two-parameter payload, `en` language — untouched), `ra7etbal_task_v3` and all WhatsApp template mappings (untouched), typed owner-reference normalization from PR #25 (untouched).

### Direct-message WhatsApp template routing fix

Status: implemented (third attempt). Not yet merged.

History: PR #26 first split direct messages onto `ra7etbal_direct_operational_message` but sent only one body parameter, causing Meta error 132000 (wrong parameter count) — messages were accepted then asynchronously marked failed. PR #27 tried an `en_US` → `en` language fix; Meta still rejected with error 132001 because the payload shape was still wrong. PR #28 fully reverted #26 and #27 back to the shared routine-template path (`ra7etbal_routine_message` for both routine and direct messages) to restore delivery, at the cost of reintroducing the original template-mismatch bug for direct messages.

Root cause, confirmed against the approved Meta Utility template preview: the direct-message template body is `Operational update from {{1}}:\n\n{{2}}\n\nThank you.` — it requires **two** body parameters (`ownerName`, `messageText`), not one. `send-whatsapp-task.js` now gives `direct_message` a fully isolated branch (separate from `routine_message`, no shared code path) with its own template name (`WHATSAPP_DIRECT_MESSAGE_TEMPLATE || 'ra7etbal_direct_operational_message'`), own language (`WHATSAPP_DIRECT_MESSAGE_TEMPLATE_LANGUAGE || 'en'`), and a dedicated `buildDirectMessagePayload` builder sending exactly `[{ type: 'text', text: ownerName }, { type: 'text', text: messageText }]`. Routine messages are untouched — same template, same language default (`en_US`), same one-parameter payload via `buildRoutineMessagePayload`.

Focused tests passed (`send-whatsapp-task.test.js` 21/21, relevant direct-message/escalation/webhook tests 201/201). Typecheck passed. Build passed. Full suite not re-run for this narrow fix per task scope — no shared infrastructure changed beyond the isolated direct-message branch.

Protect: task/delegation templates, owner-decision template, reminder/automation delivery, typed message normalization (PR #25), and the routine-message template/payload (byte-for-byte unchanged).

**Before merging, confirm with Sana / Meta Business Manager that `ra7etbal_direct_operational_message` is approved and live with exactly this two-parameter body** — a correct payload shape still fails if the template itself isn't approved yet.

### Typed direct-message owner-reference normalization

Status: implemented. Not yet merged.

Focused tests passed. Typecheck passed. Build passed. Full suite: 1509/1510, with one confirmed pre-existing unrelated failure in `canonical-paths.test.ts` (hardcoded `CANONICAL_CONFIRMATION_ORIGIN`, not caused by this change).

Output does not invent a gendered pronoun: "Tell Grace I'm on my way." sends "Sana is on the way."

Typed Carson's direct-message fast path (`direct-message-fast-path.ts`) now rewrites a leading first-person subject in the message body to the owner's display name before sending, via a new `normalizeFirstPersonForOwner` utility (`direct-message-owner-normalization.ts`), so "Tell Grace I have no Wi-Fi." sends "Sana has no Wi-Fi." to the worker — matching voice Carson's natural third-person phrasing. Gated by a new opt-in `normalizeOwnerReference` flag on `executeDirectMessageFastPath`'s context, set only from the typed call site in `ElevenLabsAgentWidget.tsx` (`activeChannelRef.current === "text"`). Voice's own `send_direct_whatsapp_message` tool composes its own text and is untouched.

Protect: voice behavior, delegation routing, the parser's (`parseSimpleDirectMessage`) unnormalized output contract.

### Confirmed: Meta rejection may still report success

Status: confirmed, pre-existing, not fixed. Out of scope for the typed/voice owner-normalization task — record only.

When Meta rejects a direct-message send, typed and voice Carson may still report success to the owner. Needs its own scoped fix and verification; do not fold into unrelated work without explicit authorization.

### Confirmed: delegation misclassification for "make" verb

Status: confirmed, pre-existing, narrowed and partially superseded — see "Carson communication vs. delegation routing fix" below.

**Correction to this entry's prior claim**: this previously stated that "Tell Christopher to wait for me in the kitchen. I'm on my way." was *required* to route to delegation. That was wrong — Sana has since explicitly confirmed the opposite: "wait for me" targets the owner, so it is simple communication, not trackable delegated work. The `it.fails` test for that phrase in `direct-message-fast-path.test.ts` has been corrected to a normal passing test asserting it stays a direct message.

`parseSimpleDirectMessage` still classifies "Tell Christopher to make lunch." as a direct message, not a delegation, even though it should route to delegation. Root cause remains in `DELEGATION_BODY_START`'s fixed verb whitelist (`direct-message-fast-path.ts`) not including "make." This is a narrower, separate gap from the confirmed call-me/contact-me/wait-for-me production regression fixed below, still documented via `it.fails` in `direct-message-fast-path.test.ts`, and still needs its own scoped fix and verification — not folded into the fix below to keep it minimal.

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

### PWA authentication or notification restoration difference

Observed behavior: browser sign-in restores notifications, while the installed home-screen PWA may not restore them in the same way.

This requires a focused root-cause investigation. Protect normal browser authentication and existing push subscriptions.

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

## State update rules

After each completed task:

1. Move the item into Stable and protected when production behavior is verified.
2. Keep it under Current issues when code is complete but live behavior is not verified.
3. Record blockers precisely.
4. Remove stale plans and superseded bugs.
5. Include the relevant commit or PR reference when useful.
6. Keep this file short enough that every agent can read it at session start.
