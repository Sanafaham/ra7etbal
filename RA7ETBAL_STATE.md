# Ra7etBal Current State

Last updated: 2026-07-17

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

### Confirmed: delegation misclassification for "make"/"wait" verbs

Status: confirmed, pre-existing, not fixed. Documented via two `it.fails(...)` tests in `direct-message-fast-path.test.ts` (routing-protection describe block) so the gap is visible without asserting broken behavior as correct.

`parseSimpleDirectMessage` currently classifies "Tell Christopher to make lunch." and "Tell Christopher to wait for me in the kitchen. I'm on my way." as direct messages, not delegations, even though the required behavior is that these route to delegation and preserve full instruction/context. Root cause is in `DELEGATION_BODY_START` matching / delegation-routing logic in `direct-message-fast-path.ts`, not touched by the normalization work above. Needs its own scoped fix and verification.

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
