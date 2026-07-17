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

### Direct-message WhatsApp template routing fix

Status: implemented. Not yet merged.

Production evidence showed a direct message failing at 22:20 because `send-whatsapp-task.js` selected `ra7etbal_routine_message` (via `WHATSAPP_ROUTINE_MESSAGE_TEMPLATE`) for both routine and direct messages. Direct messages now select `process.env.WHATSAPP_DIRECT_MESSAGE_TEMPLATE || 'ra7etbal_direct_operational_message'` independently; routine messages are unchanged (`WHATSAPP_ROUTINE_MESSAGE_TEMPLATE || 'ra7etbal_routine_message'`). Language selection is likewise independent: direct messages use `WHATSAPP_DIRECT_MESSAGE_TEMPLATE_LANGUAGE || en_US`; routine messages continue using `WHATSAPP_TEMPLATE_LANGUAGE || en_US`.

Focused tests passed. Typecheck passed. Build passed. Full suite: 1513/1514, with the same pre-existing unrelated failure in `canonical-paths.test.ts`.

Protect: task/delegation templates, owner-decision template, reminder/automation delivery, typed message normalization (PR #25).

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
