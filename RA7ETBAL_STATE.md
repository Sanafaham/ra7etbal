# Ra7etBal Current State

Last updated: 2026-07-29

This file is the operational source of truth for agents working in this repository. Update it whenever a task changes what is complete, protected, blocked, or next.

## Product

Ra7etBal is a personal Chief of Staff that reduces mental load. Carson is the AI Chief of Staff.

Typed Carson and voice Carson are the same person, sharing the same memory, identity, and reasoning. Product decision (2026-07-25): Type to Carson is advisory-only — thinking, planning, drafting, research, and review only. Talk to Carson (voice) remains the sole execution channel for reminders, recurring reminders, push notifications, calendar events, staff messages, hosting plans, delegations, and any other state-changing action. See "Type to Carson is advisory-only" below.

## Current next task

### Carson deterministic pre-dispatch tool-policy gate (PR #105) — MERGED, PRODUCTION VERIFIED WITH A FOLLOW-UP FIX

Status: PR #105 merged to `main` at commit `c6d0017a44deb37eebdb382dc9ccfb5ff3b4a0b0`, deployed to production (`dpl_AsXxmyUCaR5V2Cd9MxJjAzMMEQXu`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com` aliased, `aliasError: null`). Adds `src/lib/carson-tool-policy.ts`, a deterministic policy contract that validates every relevant ElevenLabs-selected Carson client tool against the current utterance, channel, arguments, and required entities before the existing handler runs, with documented precedence (reminder → direct communication → tracked delegation → note/memory → calendar). Before merge, one CodeRabbit finding was closed (`calendar_mutation`'s `requiredEntities` were declared but never enforced — fixed by requiring title+date+time for `create_calendar_event` and `event_id` for update/delete). A second CodeRabbit finding (the ElevenLabs live-agent patch procedure lacking a version/ETag precondition before overwrite) was left open as a process note, not a code fix — see below.

**Process deviation, flagged not reverted**: this PR's ElevenLabs prompt/tool-description patch (`docs/elevenlabs-prompt-patches/2026-07-29-carson-deterministic-tool-policy.md`) was applied to the live ElevenLabs dashboard agent (`agent_3001kt3zzkcxfb3bwejd8yzzhnmy`, version `agtvrsn_1301ky5xpstken3vcm327z7y9pxq` → `agtvrsn_9101kynn4fj4e7vbthwmt6bn4cfx`) via automated API write, confirmed by Sana to have been done by Codex directly — not pasted manually by a human, contradicting this directory's own README (`docs/elevenlabs-prompt-patches/README.md`): "patches are additive guidance for a human to paste, not an authoritative replacement." Not reverted; recorded here for visibility. Consider either updating the README to permit automated application under recorded before/after hashes, or treating future patches as human-paste-only again — an explicit product decision, not made by this task.

**Confirmed production regression found during live verification, fixed same day (PR #106)**: live-tested "Ask Christopher to reply 'test received'." via Talk to Carson produced the spoken reply "Message sent to Christopher." with zero `messages` row, zero `whatsapp_deliveries` row, and zero `/api/send-whatsapp-task` (or any `whatsapp`-matching) request in Vercel runtime logs for that session — `send_direct_whatsapp_message` was never invoked at all that turn. Root cause: this tool was never wired into the existing truthfulness-override safety net (`carson-direct-tool-override.ts`) that already protects `create_todo`/`create_reminder`/`execute_instruction`/`save_note`/etc. against the identical class of bug (the documented 2026-07-13 `save_note` fabrication incident). Not caused by PR #105's code changes — a pre-existing gap this PR's new, more deterministic routing made easier to reproduce live.

Fix (PR #106, merge commit `a94a511c03393122115a9d3c62733fcf33fe4814`, deployed to production `dpl_FT42xaVe24uaSDR4NfjiEotxhFGb`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com` aliased, `aliasError: null`): new `messageSendOutcomeRef`, a dedicated current-turn-only outcome ref mirroring `noteSaveOutcomeRef` exactly (not the shared 15s-window `lastDirectToolSuccessRef`, which CodeRabbit already flagged as leak-prone for this class of check), set only by `sendDirectWhatsAppMessage` on its own verified success/failure paths. New `detectsUnconfirmedMessageSendClaim` in `carson-direct-tool-override.ts` replaces a "message sent" claim with a truthful retry reply whenever no genuine send succeeded this turn. Wired into the existing shared `resolveSanitizedCarsonDisplayMessage` call site — applies to both voice and typed.

No production data needed cleanup from the confirmed incident — since nothing was actually created (no task, message, or delivery row), there was nothing to delete.

Verification: mutation-tested (removing the new check reproduces the exact regression; restoring it passes). Focused: `carson-direct-tool-override.test.ts` (79), new `ElevenLabsAgentWidget.direct-message-truthfulness.test.ts` (7). `TZ=UTC npm run test:carson-protected`: 987 passed, 4 skipped, 3 todo. Full `npx vitest run`: 2351 passed (only a pre-existing, unrelated `ElevenLabsAgentWidget.sdk-config.test.ts` environment failure — a missing file in this worktree's `node_modules`, not caused by this change, not part of the protected suite). Typecheck and build both passed.

**Second confirmed production regression on the exact same-day retest, fixed same day (PR #108)**: the exact retest of the PR #106 fix ("Ask Christopher to reply, \"Test received.\" This is just a PolicyGate test. No action needed.") reproduced the incident again. ElevenLabs' own conversation dashboard (screenshot evidence) confirmed `send_direct_whatsapp_message` ran and showed "Succeeded" in **0ms** — consistent with an early-return/policy-gate short-circuit, not a real network round trip — with the same zero `messages`/`whatsapp_deliveries`/`tasks` rows and zero `whatsapp`-matching Vercel log lines as the first incident. Root cause: Carson's displayed reply this time was the shorter paraphrase **"Sent to Christopher."**, not "Message sent to Christopher." — verified directly (`node -e` regex test) that PR #106's `MESSAGE_SEND_CONFIRMATION_PATTERN` requires "message"/"text"/"whatsapp" immediately before "sent" (or "I've sent"/"it's with Name"/"that's sent"), none of which match "Sent to Christopher." The guard's wiring (`messageSendOutcomeRef`, turn-boundary resets, the `resolveSanitizedCarsonDisplayMessage` call site) was correct and untouched — only the claim-detection regex was too narrow to generalize past the first incident's exact wording.

Fix (PR #108, merge commit `82f0a68dd5f74ebd26850134c3491a7e7088f286`, deployed to production `dpl_5Zz7mk9koVCpupKd3DZXzhYvGF6T`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com` aliased, `aliasError: null`): added a `"sent [it/that/the message] to <Name>"` alternative to `MESSAGE_SEND_CONFIRMATION_PATTERN`, plus a new `NEGATED_SEND_PATTERN` exclusion (mirroring this file's existing `SUCCESS_LANGUAGE_PATTERN`/`FAILURE_LANGUAGE_PATTERN` dual-check convention) so a truthful negated reply ("I couldn't get that sent to Christopher.") is never misread as a fabricated claim. Mutation-tested: removing just the new alternative reproduces the exact regression (2 tests fail on "Sent to Christopher." instead of the truthful fallback); restoring it passes 76/76 in `carson-direct-tool-override.test.ts`. `TZ=UTC npm run test:carson-protected`: 987 passed. Full suite: 2355 passed (same pre-existing, unrelated `sdk-config.test.ts` environment gap). Typecheck and build both passed.

**Upstream root cause of the ~0ms/no-transport behavior found and fixed (PR #110)**: traced deterministically (no live retest needed) by calling `evaluateCarsonToolPolicy` directly with the exact confirmed utterance. The router classifies "Ask [Name] to reply/respond..." as **delegation** (confidence 0.97, generic "Ask [Name] to" pattern) rather than direct communication, because `isCommunicationStyleTaskText` — the single shared classifier used by both the tool-policy gate and `sendDelegation()`'s own reroute decision — only recognized owner-targeting phrases ("call me", "wait for me", "let me know"), not "reply/respond as the entire delegated task" (communication regardless of who it's addressed to). Delegation's eligible tools (`execute_instruction`/`send_delegation`/`send_followup`) don't include `send_direct_whatsapp_message`, whose actual params (`recipient_name`/`message`) never satisfy delegation's required `instruction`/`task`/`description` field — so the deterministic gate rejected the correctly-selected tool synchronously (0ms, zero network calls) every time, with Carson's own separately-generated reply then fabricating a "sent" outcome disconnected from that real rejection. Not a transport, schema, callback, or promise-handling defect — the client tool handler received the invocation correctly every time; the gate's own rules were simply wrong for this phrasing.

Fix (PR #110, merge commit `6904b855c3a7e6d5915da7079ca0fbb61c1eae6c`, deployed to production `dpl_FoZu2at6ECmGYM2U7c2L7PHGLZk2`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com` aliased, `aliasError: null`): `isCommunicationStyleTaskText` (`communication-vs-delegation.ts`) now also recognizes `"reply/respond/text back/write back"` as the entire delegated task as inherently communication, anchored to the start of the task text so a compound instruction with real work first is not swallowed entirely. One shared fix for both the tool-policy gate and `sendDelegation()`'s reroute decision — no risk of drift between them. Mutation-tested: reverting to owner-target-only reproduces exactly the 6 new/related tests failing; restoring passes. `TZ=UTC npm run test:carson-protected`: 996 passed. Full suite: 2364 passed (same pre-existing, unrelated `sdk-config.test.ts` environment gap). Typecheck and build both passed.

Drafted (per this directory's own README policy — human pastes it, not an automated write) `docs/elevenlabs-prompt-patches/2026-07-29-direct-message-truthfulness-and-routing.md` — additive prompt guidance reinforcing reply/respond routing and never claiming success without tool confirmation. **Applied**: Sana pasted this into the live Carson agent dashboard and published it on 2026-07-29.

**Third finding during that same live-prompt review (Sana, not this task's own investigation)**: a pre-existing "ACTION ROUTING — REQUIRED" section elsewhere in the live prompt directly contradicted this fix and the codebase's own locked behavior — it instructed `send_delegation` for "[command] + [person] + 'to' + [verb]" constructions "regardless of which command word," using **"Ask Grace to call me."** and **"Tell Christopher to wait for me in the kitchen."** as its own examples — both confirmed, protected communication cases per PR #49/#50 (`isCommunicationStyleTaskText`, locked in `carson-protected-behaviors.test.ts`). It also directly contradicted "MESSAGE VERSUS TASK ROUTING" immediately below it in the same prompt, which already states the correct rule. Fixed by deleting the entire "ACTION ROUTING — REQUIRED" section (full removed text recorded in `docs/elevenlabs-prompt-patches/2026-07-29-action-routing-contradiction-cleanup.md` for reference) — nothing else in the prompt referenced it by name, so no other prompt edits were needed. Applied by Sana directly, same session.

No API read-back was performed for either live-prompt change (no `ELEVENLABS_API_KEY` in this task's environment) — applied and confirmed by Sana through the dashboard UI directly, not independently re-verified via API by this task.

**Previously open item, now closed for future occurrences by PR #114 (see below)**: no server-side diagnostic used to distinguish "model never called a tool" vs. "gate rejected a real tool call" vs. "handler ran and exited early" vs. "backend request started and failed" — `guardCurrentToolInvocation` only ever recorded a `tool_policy_rejected` diagnostic to the device's local `localStorage`, never to Supabase.

Protect: the deterministic tool-policy gate's intent precedence and required-entity gating; the `messageSendOutcomeRef`/`detectsUnconfirmedMessageSendClaim` truthfulness guard, its current-turn-only (not time-windowed) design, and its claim-pattern coverage (do not narrow it back to only the first incident's exact wording); `isCommunicationStyleTaskText`'s `REPLY_CONTENT_TASK` addition and its start-anchored scope (do not widen it to match `\breply\b` anywhere in the text — that would swallow compound instructions with real work first). Do not reintroduce a shared time-windowed check for the truthfulness-guard class of fabrication. Reopen only on a reproduced production regression.

**Fourth confirmed production incident — same class, root cause was undetermined pending diagnostics (2026-07-29)**: a clean retest after a full refresh and new login, "Ask Christopher to reply yes if he can come tomorrow.", produced four conflicting responses within one turn. Investigated end to end: zero `messages` rows, zero `whatsapp_deliveries` rows, zero `tasks` rows, and zero matching Vercel runtime-log lines for either of the two candidate sessions (~14:27 and ~14:32 UTC) — identical evidence signature to the first three incidents. Available production evidence (Supabase + Vercel logs) at the time could not distinguish "the model never selected any tool this turn" from "the client never received the invocation" from "the policy gate rejected it before any log line" from "the handler ran and returned early" — every one of those hypotheses was consistent with the same all-zeros evidence. **Root cause found and fixed same day, see PR #116 below.**

**Root cause found via the new diagnostics table — a fifth same-day incident, fully traced (PR #116)**: a further clean retest (two attempts, ~18:39 Turkey time / 15:38–15:39 UTC, same exact utterance) was captured end to end by the `carson_tool_diagnostics` instrumentation from PR #114. Both attempts (sessions `conv_4901kyq8dyfzf548jtyxbnfbgvpz` and `conv_2601kyq8fwycfkca4keedj1nm6q4`) show the identical sequence: `invoked` for `send_direct_whatsapp_message` with `channel: "voice"`, immediately followed by `typed_blocked` with `reason: "Type to Carson is advisory-only and cannot authorize a mutation."` — for a genuine Talk to Carson (voice) session. `handler_started` never fired in either attempt; confirmed against zero `messages`/`whatsapp_deliveries`/`tasks` rows and zero matching Vercel runtime-log lines for the same window. Both attempts' `claim_overridden` diagnostic rows share an identical `message_hash`, proving Carson's own separately-generated reply text was byte-identical both times (the fabricated "Message sent to Christopher..." claim) — the apparent inconsistency between the two attempts (spoken "sent" vs. displayed "I couldn't confirm that message actually sent...") is the single, already-documented audio-vs-transcript architecture limit (TTS audio is already synthesized before the displayed-transcript correction can apply), not two different bugs.

Confirmed root cause: `guardCurrentToolInvocation`'s typed-advisory gate (`ElevenLabsAgentWidget.tsx`, introduced 2026-07-25 at `git 4ebee9d`) — `if (TYPED_MODE_IS_ADVISORY_ONLY && TYPED_BLOCKED_TOOL_MESSAGES[toolName])` — never checked `requestedChannel`. Since `TYPED_MODE_IS_ADVISORY_ONLY` is a hardcoded `true` module constant, this condition is satisfied for every tool in `TYPED_BLOCKED_TOOL_MESSAGES` (`execute_instruction`, `send_followup`, `send_delegation`, `send_direct_whatsapp_message`, `create_reminder`, `create_automation`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event`, `create_todo`, `complete_todo`, `control_task`, `act_on_note`, `save_note`, `save_city`, `save_instruction`) **regardless of channel** — silently blocking real Talk to Carson (voice) calls before the deterministic tool-policy gate (PR #110) or the real handler ever ran. This is why PR #106/#108/#110 each fixed a real, separate downstream bug but none of them could have worked end-to-end for this phrasing: all three operate strictly downstream of this gate. The pre-existing test suite had locked in the buggy, channel-blind shape as correct via source-shape assertions that never checked the condition was scoped to `requestedChannel === "text"` — including one test whose own title ("voice returns before it is checked") was never actually proven true.

Fix (PR #116, merge commit `bb3d8940bb811a0fd81988356059f8baee46ab35`, deployed to production `dpl_H6h7UXWKdjpWMyKAXQt8vvp7UyhY`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com` aliased, `aliasError: null`): gated the condition on `requestedChannel === "text"`, matching the block's own documented intent ("a typed request must never reach a state-changing tool"). Mutation-tested: reverting to the channel-blind condition reproduces exactly 3 failing tests (2 in `ElevenLabsAgentWidget.typed-mode.test.ts`, 1 in `ElevenLabsAgentWidget.tool-diagnostics.test.ts`); restoring passes all with no other regressions. `TZ=UTC npm run test:carson-protected`: 996 passed. Full suite: 2382 passed, 4 skipped, 3 todo. Typecheck and build both passed.

This closes all four confirmed 2026-07-29 "Ask Christopher to reply..." incidents under one root cause. Known remaining limitation, not fixed by this change and not fixable at this layer: TTS audio is synthesized before the displayed-transcript truthfulness correction can run, so a genuine transport failure (rare now that the real handler is reachable) can still produce spoken audio that doesn't match the corrected displayed text — the existing `messageSendOutcomeRef`/`detectsUnconfirmedMessageSendClaim` guard remains the backstop for that residual case. Protect: the `requestedChannel === "text"` gate on `guardCurrentToolInvocation`'s typed-advisory check — do not reintroduce a channel-blind version of this condition for any tool in `TYPED_BLOCKED_TOOL_MESSAGES`.

**Fifth confirmed production incident — a genuine async race, false-negative displayed correction (2026-07-29, final live retest after PR #116)**: "Ask Christopher to reply yes if he can come tomorrow." via Talk to Carson (voice) **succeeded** — Christopher received the real WhatsApp message — but the displayed transcript still showed "I couldn't confirm that message actually sent. Please ask me to try again." while the spoken reply said it was sent.

Traced via `carson_tool_diagnostics` for the confirmed 20:19 Turkey-time session (`conv_0201kyqe5s0be1xtq19hmnj4vcfv`): `invoked` and `handler_started` for `send_direct_whatsapp_message` both fired at 17:19:04.988–.989 UTC; the real WhatsApp network send took roughly 2.3 seconds; `claim_overridden` fired at 17:19:07.245 UTC — **35ms before** `handler_success` at 17:19:07.280 UTC (`recipient_person_id` confirmed). Root cause: the agent's own separately-generated reply (a documented, distinct generation from the tool's return value — see this codebase's long-standing note on this architecture) was classified by the truthfulness guard (`resolveSanitizedCarsonDisplayMessage`/`detectsUnconfirmedMessageSendClaim`) at a moment when `messageSendOutcomeRef` was still null — not because the send had failed, but because the real network round trip genuinely had not settled yet. This is **not** a stale-ref bug or a local ordering bug (`messageSendOutcomeRef` is set synchronously before the tool's own promise resolves, strictly before the SDK could relay a result back to the model) — it is a legitimate race between two independent timelines: the model's reply generation and the tool's own network completion.

Fix (PR #118, merge commit `2a94ef85a179857c41bf379177f428e671bfb70b`, deployed to production `dpl_7CK6kKtGr3aZrFfgk88mKZtNrj9b`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com` aliased, `aliasError: null`): new `messageSendInFlightRef` captures the current turn's own `send_direct_whatsapp_message` promise (cleared at every turn boundary alongside `messageSendOutcomeRef`, so no invocation can ever inherit another turn's stale state). When the agent's reply looks like an unconfirmed send claim and a real call is in flight for this voice turn, `onMessage` now awaits that promise (`resolvePendingMessageSendOutcome`, bounded by a 12s timeout) before finalizing the classification, instead of reading an instantaneous snapshot. A confirmed success is left untouched (matches what was already spoken). A confirmed failure still gets the honest fallback. A genuine hang still falls back to the honest "unconfirmed" reply after the timeout. The original 2026-07-13/07-29 fabrication case this guard exists for (no tool call at all this turn) is unaffected, since `messageSendInFlightRef` is only ever set by a real `send_direct_whatsapp_message` call.

No ElevenLabs prompt or tool-instruction change was made or needed — the trace shows this is a purely client-side timing issue, not a routing or wording defect.

Tests: 4 new behavioral tests in `carson-direct-tool-override.test.ts` (fake timers) proving `resolvePendingMessageSendOutcome` resolves to a real success before the timeout with no override needed, resolves to a real failure with the override still applying, falls back to null on a genuine timeout, and returns immediately with no tool in flight. 5 new source-shape tests in `ElevenLabsAgentWidget.direct-message-truthfulness.test.ts` proving the ref capture/reset/await wiring. Mutation-tested: removing the in-flight promise capture reproduces a failing test; restoring passes. Full `npx vitest run`: 2391 passed, 4 skipped, 3 todo. Typecheck and build both passed.

Remaining limitation, unchanged by this fix and not what this incident was about: TTS audio is still synthesized and spoken before any correction can run — a genuine failure can still be spoken as a false "sent" claim via audio even though the displayed transcript now correctly shows the truthful outcome. Protect: `messageSendInFlightRef`'s turn-boundary reset (do not let it leak across invocations); the 12s bounded timeout (do not remove the fallback path); the "confirmed success is left untouched" behavior (do not apply the resultText override on a success — the model's own truthful claim should stand as-is).

### Spoken Execution Truthfulness (2026-07-29) — CLIENT-SIDE SCOPE COMPLETE, FULL AUDIO GUARANTEE OPEN

Status: the direct-message path (`send_direct_whatsapp_message`) is production-verified working — Christopher received the WhatsApp, Carson spoke "Sent to Christopher.", and the displayed transcript showed the identical text (2026-07-29, ~20:57 Turkey time, session `conv_4401kyqgbn93e17rxzjry5k8rzqs`, `invoked` → `handler_started` → `handler_success` 2.53s later, no `claim_overridden` for this invocation).

**Investigated before any code change, per instruction not to speculate**: researched ElevenLabs' official documentation (client-tools reference, OpenAPI schema, `@elevenlabs/react`/`@elevenlabs/client` changelogs) to determine whether Carson's spoken audio and displayed reply can both be guaranteed to come from the same authoritative, settled tool result.

**Confirmed findings**:
- The only documented lever that makes the agent's reply depend on a client tool's real return value is the per-tool `expects_response` field — the dashboard's **"Wait for response"** checkbox. If it's off for a tool, the model never receives that tool's return value at all.
- There is no `execution_mode` (sync/async) concept for client tools — that only exists for webhook/MCP-server tools.
- There is no documented client-side API in `@elevenlabs/react`/`@elevenlabs/client` to delay, cancel, suppress, or replace TTS audio already streaming for a turn.
- Even with "Wait for response" enabled, the docs only state the agent "will wait for its response and append it to context" — no documented guarantee about exactly when TTS synthesis begins relative to that, and no documented mitigation for a race.

**Conclusion: full "Carson must never SPEAK a premature success" cannot be guaranteed by any code in this repository.** This is a platform-level constraint, not a gap in this codebase. **Action needed from Sana**: check whether "Wait for response" is enabled on `send_direct_whatsapp_message` (and ideally the other action tools) in the ElevenLabs dashboard — this task's environment has no `ELEVENLABS_API_KEY` to verify it via API. If it's already enabled and premature speech still occurs, that would need to be raised with ElevenLabs support as a platform question — the public docs give no further officially-endorsed mitigation.

**What is achievable client-side, and was hardened this pass (PR #120, merge commit `4a8877aa5825c8ad73a27cebef8311034f56218b`, deployed to production `dpl_CVUfFzyfzoym1cdRn5hWLo6Jo6ai`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com` aliased, `aliasError: null`)**: the *displayed* transcript can be, and is, always grounded in the real settled outcome (PR #118). While auditing that guarantee for gaps, found one: `messageSendOutcomeRef`, `messageSendInFlightRef`, and `noteSaveOutcomeRef` were reset at every turn boundary but **not** in `onDisconnect`/`onError` — unlike this file's own established precedent for the identical class of bug (other per-session refs, e.g. `activeExecuteLatencyRef`, are already cleared there with the comment "a NEXT session's ... event could log or complete a trace using this session's stale timing"). Fixed by clearing all three in both handlers, mirroring the existing precedent exactly. Also added a **permanent protected regression test** encoding the exact confirmed-working 20:57 production case verbatim (`resolveSanitizedCarsonDisplayMessage` returns "Sent to Christopher." untouched given a confirmed success outcome for that exact utterance) — do not remove or weaken this test.

Tests: 1 new protected regression test for the exact 20:57 case in `carson-direct-tool-override.test.ts`; 2 new source-shape tests in `ElevenLabsAgentWidget.direct-message-truthfulness.test.ts` proving `onDisconnect`/`onError` clear all three refs. Mutation-tested: removing the clearing reproduces a failing test; restoring passes. `TZ=UTC npm run test:carson-protected`: 996 passed. Full suite: 2394 passed, 4 skipped, 3 todo. Typecheck and build both passed.

No ElevenLabs prompt or tool-instruction change was made — the research and the trace both point to this being a platform-level constraint and a client-side hardening gap, not a wording or routing defect.

**This item is marked complete only for its client-side scope**: no cross-session leakage, the 20:57 case is now a permanent regression test, and the displayed-text guarantee from PR #118 has no known remaining gaps. **The full end-to-end guarantee that Carson can never speak a premature success remains open** pending Sana's dashboard check of "Wait for response" and, if needed, an ElevenLabs support inquiry. Do not claim this fully resolved beyond that scope.

**Sixth confirmed production incident, immediately after enabling "Wait for response" — proven NOT caused by that setting (2026-07-29, ~21:57 Turkey time)**: "Ask Christopher to reply yes if he can come tomorrow night." produced no WhatsApp to Christopher. Displayed sequence: "Good evening, Sana." (the normal session opening greeting — unrelated), then "I wasn't able to send that. Please try again."

Traced via `carson_tool_diagnostics` for session `conv_4401kyqktfgfe3tv39rn66f3va4g`: `send_direct_whatsapp_message` was `invoked`, then rejected at `policy_rejected` **1ms later** with `reason: "Required entities are missing: task."` — `handler_started` never fired; no backend request; no WhatsApp transport; nothing reached ElevenLabs' tool-result handling at all, since the rejection happens synchronously inside this codebase's own deterministic policy gate (`evaluateCarsonToolPolicy`), strictly before the real handler is ever called. **This rules out the "Wait for response" setting, a transport/backend failure, a timeout, a malformed tool result, and a config/cache issue** — none of those could be relevant before this rejection point is reached. The timing of this incident right after the dashboard change was coincidental, not causal — confirmed by reproducing the exact rejection via direct calls to `evaluateCarsonToolPolicy` with reconstructed candidate utterances.

Root cause (confirmed, not speculated): the voice transcript Carson actually heard was garbled into an "Ask Christopher if he can ... to reply/send yes..." shape (partial screenshot evidence: "Ask Christopher if he can to sen...") — the router's own explicit "Ask [Name] if/whether" check-in-delegation pattern. `directCommunicationIntent()`'s task-extraction regex in `carson-tool-policy.ts` required the connector "to" within at most one word of the person's name, so for this three-extra-word shape ("if he can" before "to") it never extracted a `delegatedTask` at all — `isCommunicationStyleTaskText` was never even evaluated, and the utterance fell through to plain delegation routing, which requires a "task" entity `send_direct_whatsapp_message`'s params (`recipient_name`/`message`) don't have.

Fix (PR #122, merge commit `708c1980e8727e93a356df64b243ecdc0a9b213e`, deployed to production `dpl_2jB6L25BAZnf3xdxmhVzb2wBD4Wh`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com` aliased, `aliasError: null`): broadened the extraction regex from a fixed 0–1-word gap before "to" to a non-greedy, unbounded gap (`.*?\bto\s+`) — unchanged behavior for the already-working "Ask [Name] to [task]" shape (0 intervening words matches identically); still only reclassifies as communication when the captured text after "to" itself reads as communication-style (`isCommunicationStyleTaskText`) — a genuine check-in delegation with no reply/respond clause is unaffected, protected by a dedicated new test.

Honest residual limitation: `carson_tool_diagnostics` only stores a privacy-safe hash of the raw utterance, so the exact full transcript ElevenLabs heard could not be recovered for this incident. If voice recognition had dropped the trigger word ("reply"/"respond") entirely rather than just reordering it, no classification fix can recover intent from text that no longer contains it — this fix closes the confirmed, reproducible regex-limit gap, not arbitrary ASR noise.

Tests: 2 new tests in `carson-tool-policy.test.ts` — the confirmed check-in-shaped phrasing now routes to `direct_communication`; a genuine check-in delegation with no reply clause is proven to still route to `delegation` (guards against over-broadening). Mutation-tested: reverting to the fixed 0–1-word regex reproduces the exact failing test; restoring passes. `TZ=UTC npm run test:carson-protected`: 998 passed. Full suite: 2396 passed, 4 skipped, 3 todo. Typecheck and build both passed.

PR #116, PR #118, and PR #120 were not touched or reverted. Protect: the non-greedy `.*?\bto\s+` extraction (do not narrow it back to a fixed word count); the "genuine check-in delegation with no reply clause stays delegation" test (do not broaden `isCommunicationStyleTaskText` beyond reply/respond/text-back/write-back and owner-targeting phrases just to chase this incident's exact wording).

**Server-side tool-invocation diagnostics shipped (PR #114, merge commit `5e4ff61c464bb884c2786e86b5fd6252655d733c`, deployed to production `dpl_DQ8nXCyUE4XGxpzHo8zoYm6D4i7b`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com`/`ra7etbal-v2.vercel.app` aliased, `aliasError: null`)**: adds an additive Supabase table `carson_tool_diagnostics` (migration `20260731_carson_tool_diagnostics.sql`, applied to production project `ggarvhgqzpooloacjgcj`, matching `.rollback.sql` provided) — owner-scoped RLS (SELECT/INSERT only for `authenticated`, no UPDATE/DELETE grants, `service_role` has full access), storing only safe identifiers (`user_id`, `session_id`, `channel`, `tool_name`, a `stage` enum — `invoked | policy_rejected | typed_blocked | handler_started | handler_success | handler_failure | claim_overridden` — `reason`, `missing_entities` jsonb, `recipient_person_id`, and SHA-256 hashes of the utterance/message) and **never** raw utterance or message content. New `src/lib/carson-tool-diagnostics.ts` exports a fire-and-forget `recordCarsonToolDiagnostic()` (never throws, skips the insert entirely when `userId`/`sessionId` is missing). Wired into `ElevenLabsAgentWidget.tsx` at every stage the fourth-incident investigation needed and could not observe: the top of `guardCurrentToolInvocation` (`invoked`, before any early return), the typed-advisory-block guard (`typed_blocked`), the policy-gate rejection point (`policy_rejected`, with the exact `reason`/`missingEntities`), the top of `sendDirectWhatsAppMessage` (`handler_started`, before any validation return) and its success/failure returns (`handler_success` with `recipientPersonId`, `handler_failure` with `reason`), and the `onMessage` truthfulness-override site (`claim_overridden`, whenever the displayed transcript is corrected).

Tests: `src/lib/carson-tool-diagnostics.test.ts` (5 tests — expected row shape and hashing, raw text never present in the serialized row, skips insert without `userId`/`sessionId`, never throws on a rejected Supabase call, safe `recipient_person_id` never a name). `src/components/home/ElevenLabsAgentWidget.tool-diagnostics.test.ts` (7 source-shape tests proving each call site is wired at the exact expected location). `TZ=UTC npm run test:carson-protected` and full `npx vitest run`: all passing except the same pre-existing, unrelated `sdk-config.test.ts` environment gap (2376 passed, 4 skipped, 3 todo). Typecheck and production build both passed.

**This closes the instrumentation gap for future occurrences only.** It does **not** retroactively explain the fourth incident above — that table did not exist during those sessions, so nothing can be queried from it for that specific incident. No live ElevenLabs prompt change was made or required for this diagnostics-only change. Per standing instruction, this item is **not** marked Done: the fourth incident's traced root cause is still outstanding, and no further live retest should be requested until the next occurrence can actually be traced through this new instrumentation.

PR #93 (`agent/server-backed-banner-dismissal`) persists completed-confirmation banner dismissal on `tasks.dismissed_at`. Independent verification on 2026-07-28 added client/server eligibility guards and optimistic rollback coverage; focused tests, typecheck, the protected suite, and production build pass. The additive, nullable, idempotent migration was applied directly and verified on the confirmed Ra7etBal production Supabase project `ggarvhgqzpooloacjgcj`. After current `main` introduced the canonical `20260727 owner_whatsapp_reply_receipts` migration, this PR's migration was renumbered to `20260729_add_dismissed_at_to_tasks.sql` so migration tooling will not skip it because of the occupied version. Production UI verification across refresh, logout/login, Safari, and the installed app still requires deployment of the PR code; do not merge PR #93 until that verification can be completed.

### Carson Intent Architecture — Stage 1 (Communication/Delegation) — CODE MERGED AND DEPLOYED, LIVE BEHAVIOR NOT YET CHANGED

Status: the client-side foundation is merged and deployed to production. **Carson's actual live behavior has not changed yet** — the new tool is not usable until the matching ElevenLabs dashboard change is applied by Sana. Do not treat this as production-verified until that happens and a live retest confirms it.

**Root-cause pattern across this session's three related incidents**: PR #110 and PR #122 were both the same architectural failure — a client-side deterministic gate (`carson-tool-policy.ts`'s `evaluateCarsonToolPolicy`, via `carson-router.ts`'s `classifyCarsonInstruction` and inline regexes) re-derived intent from raw utterance text independently of whatever tool the ElevenLabs model had already selected, and rejected the model's correct tool choice whenever the regex disagreed — PR #110 for "Ask Christopher to reply..." (generic "Ask X to" delegation pattern), PR #122 for a garbled "Ask Christopher if he can to reply/send..." transcript (extraction regex limited to one intervening word before "to"). (PR #118 was a separate, unrelated async-timing defect, not a regex/classification issue — see its own entry above.) A full architecture review (`src/lib/carson-router.ts`, `carson-tool-policy.ts`, `voice-task-control.ts`, `ops-intelligence.ts`) confirmed this pattern — raw-text regex re-derivation competing with and overriding the model's own semantic tool selection — is structural, not isolated to communication/delegation, though this stage only touches that capability.

**Architecture decision** (four rounds of design review before implementation): the ElevenLabs model no longer selects between `send_direct_whatsapp_message` and `send_delegation` directly for new person-directed requests. It calls one new tool, `route_people_action`, describing the intended outcome as structured evidence fields (`actionType`, `trackedCompletionExpected`, `followUpOrEscalationExpected`, `actualWorkRequired`, `replyExpected`, `recipient`, `content`, `timing`, `constraints`, `ambiguityReason`). Application code (`src/lib/carson-people-action.ts`, `resolveCarsonPeopleAction`) — not the model's own tool selection — decides which of the two existing, unchanged handlers to invoke, based on internal coherence between `actionType` and the three evidence booleans. **Critically, this does not default on word presence** ("reply"/"confirm"/"respond"/"let me know") — an earlier design draft did, and that was corrected during review specifically because it reintroduced the same class of brittleness this work removes: the same word ("confirm") must route differently depending on context ("confirm whether she can come" = communication; "confirm completion and keep following up" = delegation), so the distinction comes entirely from the model's own structured evidence fields, never the vocabulary.

**Shipped (PR #124, merge commit `04698516deebb0a902f405663d2a00861cca991b`, deployed to production `dpl_4PGUimSSPWx8C1Q854MTitiVBqgK`, commit-matched, `www.ra7etbal.com`/`ra7etbal.com` aliased, `aliasError: null`)**: new `route_people_action` client tool, exempted from the old regex-based `evaluateCarsonToolPolicy` gate (which remains unchanged for every other capability), voice-only via `TYPED_BLOCKED_TOOL_MESSAGES` like the tools it supersedes. The legacy tools (`send_direct_whatsapp_message`, `send_delegation`) are **not removed** — they remain the actual execution handlers, called internally by the new mapping code, and remain directly callable as a rollback safety net. Any direct model call to them bypassing `route_people_action` is recorded as `legacy_people_tool_bypass` — compatibility telemetry for the rollout, not the desired steady state. Additive Supabase migration (`20260730_carson_people_action_diagnostics.sql`, applied to production project `ggarvhgqzpooloacjgcj`, matching `.rollback.sql` provided): three new diagnostic stages (`people_action_mapped`, `people_action_clarify`, `legacy_people_tool_bypass`) and two new columns (`action_type`, `selected_tool`) — short enum-like strings only, never raw content.

**Deliberate scope limit**: communication/delegation only, per explicit instruction. Reminders, calendar, notes, task control, and hosting still use the existing regex-based classifiers unchanged — each is a separate future stage, migrated one capability at a time with its own approval, tests, and production verification, not bundled into this one.

Tests: 12 behavioral tests for `resolveCarsonPeopleAction` (confirmed incidents, both adversarial "confirm" pairs routing differently by evidence not vocabulary, missing-entity clarification, genuine ambiguity via the model's own `ambiguityReason` and `actionType`/evidence mismatch in both directions — proving no clarification is asked when the evidence already resolves it). 2 new diagnostics tests. 9 widget source-shape tests (registration, typed-advisory gate, the regex-gate exemption, legacy-bypass telemetry, dispatch to each handler). Mutation-tested: the regex-gate exemption, the coherence check, and the legacy-bypass instrumentation each reproduce specific failing tests when removed; restoring passes. `TZ=UTC npm run test:carson-protected`: 998 passed. Full suite: 2419 passed, 4 skipped, 3 todo. Typecheck and build both passed.

**ElevenLabs prompt/tool-schema change drafted, not yet applied**: `docs/elevenlabs-prompt-patches/2026-07-30-route-people-action.md` — the new tool's schema, description, behavior rule, and the two-phase rollout sequencing (add additively → observe `legacy_people_tool_bypass` telemetry → later patch tightens the prompt to fully deprecate direct legacy-tool calls). Per this directory's policy, requires Sana to paste it into the dashboard — not applied via API. **Carson cannot actually use `route_people_action` until this is done.**

**Do not mark this item production-verified until**: Sana applies the dashboard patch, and a live retest confirms the adversarial pairs (`"Ask Christopher to reply yes if he can come tomorrow."` → communication; `"Tell Christopher to clean the kitchen."` → delegation; the two "confirm" examples routing differently) on `www.ra7etbal.com`. Protect: the scope limit (do not expand to other capabilities without a separate approval); the no-word-based-default rule (do not reintroduce a vocabulary check into `resolveCarsonPeopleAction`); the legacy tools staying registered and untouched (rollback safety net).

### Owner WhatsApp decision message quality

Status: focused implementation complete and protected locally; production
verification pending. The confirmed defect was that the classifier's broadly
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

**Exact Phase B/C/D boundary:** Phase B's job ends the moment the owner has been notified and the staff member has a truthful holding reply. It never resolves the escalation, never writes an owner decision, and never routes anything back to staff. **Phase C** (the owner answering, e.g. via the WhatsApp template's "Visit Task" link) and **Phase D** (relaying that answer back to the staff member) are both not implemented — do not build them into this task's scope without a separate, explicitly-scoped task.

**Separate, explicitly out-of-scope backlog item:** `_staff-comms-engine.js`'s `loadStaffContext` still loads zero prior `staff_messages` conversation turns — each inbound message (including a direct follow-up to Carson's own prior question) is classified with no awareness of what was said moments before. Tracked as a Carson Reliability Engineering item, not fixed by PR #87 or #88.

Protect: the four-PR contract above in full — classification/escalation fields, the atomic notification lease as the sole idempotency/resend guard, the `staff_messages`-linked delivery audit row (never via `message_id`), the exact deterministic staff holding reply and its Meta-acceptance gating, and the unresolved-by-design escalation state. The full regression suite for this contract (`api/_staff-comms-engine.test.js`, `api/staff-escalation-phase-b-golden-contract.test.js`, `api/_whatsapp-delivery.test.js`) runs under `TZ=UTC npm run test:carson-protected`. Reopen only on a reproduced production regression — do not redesign this flow to add Phase C/D behavior without a separate task. Phase B remains protected by its existing stable state above; a separate stable tag (`ra7etbal-stable-owner-escalation-phase-b-2026-07-27`) marks this exact baseline.

### Phase C — Needs You visibility + read-only owner-decision page

Status: IMPLEMENTED. PRODUCTION-VERIFIED (owner-page load, read-only). PR #91 open, independent review in progress — **not yet merged, not yet closed.**

What it is: the open staff escalations Phase B already creates are now surfaced two ways, both read-only: (1) inside the *existing* Needs You list/counts on Home, Updates → Needs You, and the bottom-nav badge — no Staff tab restored, no new navigation surface; (2) via a dedicated, authenticated, read-only owner-decision page (`OwnerEscalationDecision.tsx`) reached through the same `/confirm?task={{1}}` WhatsApp template URL already approved for worker task-confirmation links, discriminated from a real task link purely by probing the existing, unmodified `/api/task-confirm` endpoint (`ConfirmRouter.tsx`'s `resolveConfirmLinkKind`) — a genuine 404 routes to the owner page, anything else routes to the unmodified `Confirm.tsx`.

`filterVisibleStaffEscalations` (`src/lib/needs-you-staff-escalations.ts`) performs no deduplication: a staff escalation is never hidden because its `task_id` happens to match a task shown in Needs You for an unrelated reason (quality review, cancellation, a self-owned decision task) — there is no reliable shared-decision identifier in the current schema, so visibility always wins over cosmetic duplicate suppression.

Production verification (2026-07-27): both open test escalations (balsamic-vinegar `staff_messages.id e02938bb-5a04-401b-8b60-79967b5a89fa` and the olive-oil escalation `8a90931f-cd03-4638-824d-1493a9a2d61a`) appeared in Needs You; the What's Happening badge showed a count of 2 for them; the balsamic-vinegar "Review decision" WhatsApp link routed to the correct owner page, displaying the correct Christopher request; opening the page caused zero database mutation (`staff_escalation_owner_decisions.status` remained `open`, `owner_reply_text`/`answered_at` remained `null`, `staff_messages.escalation_resolved_at` remained `null`, before and after, confirmed by direct query). Neither escalation was clicked through or answered.

Read-only by design: no form, button, write, insert, update, or RPC exists anywhere in this slice. Opening the owner page, or any Needs You surface showing an escalation card, can never itself resolve or answer an escalation — that is exclusively Phase D's job, not yet built. The owner-page copy reflects this truthfully: open escalations show "Decision controls are coming next. This request will remain in Needs You until you respond through Carson."; an already-answered decision (not yet reachable in production, since Phase D doesn't exist) shows only "You already responded to this request." — the open-state copy is suppressed, never both at once. No copy anywhere on this page instructs the owner to bypass Carson (reply/message/text/contact/call/WhatsApp the staff member directly, or "outside Carson"/"manually") — enforced by a dedicated regression test in `OwnerEscalationDecision.test.tsx` that also positively proves it cannot false-positive on a staff member's own quoted request text.

**Exact Phase B/C/D boundary (unchanged from the Phase B entry above):** Phase C never persists an owner answer, never calls `answer_escalation_owner_decision` or any other RPC, never sends a staff message, and never resolves an escalation. Phase D (relaying the owner's answer back to staff) remains not implemented — do not build it into a task scoped to Phase C.

**Separate, deferred, out-of-scope item:** dismissed Home notifications reappearing is a known, separate regression, unrelated to and not fixed by Phase C — do not conflate the two or attempt to fix it inside Phase C's scope.

Protect: `filterVisibleStaffEscalations`'s no-deduplication behavior — do not reintroduce `task_id`-based suppression or any text/category/timing heuristic. `ConfirmRouter`'s discriminator — do not change the Meta template URL shape or make `Confirm.tsx`/`api/task-confirm.js` aware of owner escalations. The owner page's read-only contract — no write/RPC/message-send may be added without a separate, explicitly-scoped Phase D task. The full regression suite for this contract (`src/lib/staff-messages.test.ts`, `src/lib/needs-you-staff-escalations.test.ts`, `src/routes/Home.test.ts`, `src/routes/Updates.test.ts`, `src/components/nav/BottomNav.staff-escalation-badge.test.ts`, `src/routes/ConfirmRouter.test.tsx`, `src/routes/OwnerEscalationDecision.test.tsx`) runs under `TZ=UTC npm run test:carson-protected`. Do not claim this section "CLOSED" until PR #91 is merged, deployed, and the live copy fix is production-verified — at that point, tag the merge commit `ra7etbal-stable-owner-escalation-phase-c-2026-07-27`.

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

Remaining for issue #46 at the time this section was written: wiring an actual transport to call `processStaffMessage`, and owner-facing UI surfacing of escalations. **Update:** the WhatsApp inbound transport is now wired — see "Phase B — staff-to-owner escalation loop" below, PROTECTED and CLOSED. Owner-facing UI surfacing of escalations (Phase C: the owner answering) and routing that answer back to staff (Phase D) remain not implemented — see that section for the exact boundary.

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
