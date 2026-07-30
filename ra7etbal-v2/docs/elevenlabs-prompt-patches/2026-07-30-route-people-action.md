# route_people_action — semantic entry point for communication/delegation

**Date**: 2026-07-30

**Reason**: Confirmed production incidents this session (PR #110, PR #122) traced to a client-side deterministic gate that re-derived intent from raw utterance text via regex, independently of whatever tool the model had already selected, and rejected the model's correct tool choice whenever the regex disagreed — most recently, a garbled voice transcript of "Ask Christopher to reply yes if he can come tomorrow night." was rejected with "Required entities are missing: task." before any WhatsApp send was attempted.

The architectural fix: the model no longer selects between `send_direct_whatsapp_message` and `send_delegation` directly for new requests. It calls one new tool, `route_people_action`, describing the intended outcome as structured fields. Application code (not the model) decides which of the two existing tools to actually invoke, based on those fields — never by re-parsing the raw utterance.

**Status**: applied to the ElevenLabs production agent. Live production
evidence confirms successful direct communication, meaning preservation,
exactly one outbound message, and a truthful Carson success response. It does
**not** yet prove that the model selected `route_people_action` or that its
mapping executed; no live `people_action_mapped` diagnostic has been confirmed.
The live dashboard remains the source of truth; validate it against
`docs/CARSON_COMMUNICATION_ROUTING_RELEASE.md` before every related release.

## New tool: `route_people_action`

**Tool description** (for the dashboard tool registration):
> Use this whenever the owner wants to communicate something to a specific named person, or wants to assign that person a piece of work. This is the only tool for that — do not call send_direct_whatsapp_message or send_delegation directly. Describe what the owner actually wants; the app decides how to execute it.

**Parameters**:

| Name | Type | Required | Description |
|---|---|---|---|
| `intendedOutcome` | string | yes | Your own short paraphrase of what the owner wants to happen. |
| `actionType` | enum: `interpersonal_communication` \| `tracked_delegation` | yes | Your best judgment of the kind of outcome — see guidance below. |
| `recipient` | string | yes | The person's name, resolved from context if referred to indirectly (e.g. "him", "her"). |
| `content` | string | yes | The message or task content, in your own words, preserving the owner's meaning. |
| `replyExpected` | boolean | yes | Does the owner want or expect a reply from the recipient? |
| `trackedCompletionExpected` | boolean | yes | Does the owner want this tracked until it's done or confirmed complete? |
| `followUpOrEscalationExpected` | boolean | yes | Does the owner expect follow-up or escalation if there's no response/completion? |
| `actualWorkRequired` | boolean | yes | Does fulfilling this require the recipient to actually do something beyond replying or acknowledging? |
| `timing` | string | no | Any timing, deadline, or recurrence mentioned. |
| `constraints` | string | no | Any conditions or caveats mentioned. |
| `ambiguityReason` | string | no | Fill this ONLY if you genuinely cannot determine the fields above with reasonable confidence — briefly explain what's unclear. Leave the other fields as your best guess when you do fill this. |

**"Wait for response"**: enable this — the app returns the real outcome (sent / assigned / needs clarification) and you should speak based on that returned result, never before receiving it.

## Behavior rule to add to the prompt

> **COMMUNICATING WITH OR ASSIGNING WORK TO A PERSON**
> When the owner wants you to say something to a named person, or wants that person to do something, call `route_people_action` — never `send_direct_whatsapp_message` or `send_delegation` directly.
>
> Decide `actionType` and the four boolean fields from the complete meaning of the request, never from specific words. The same word (e.g. "confirm") can appear in requests that must be classified differently — for example, "ask Grace to confirm whether she can come" is a one-off question (`interpersonal_communication`, all four booleans reflecting a simple reply), while "have Grace make sure the room is ready, confirm completion, and keep following up until it's done" is ongoing tracked work (`tracked_delegation`, `trackedCompletionExpected` and `followUpOrEscalationExpected` both true). Judge the actual outcome the owner wants, not the vocabulary.
>
> If you genuinely cannot tell whether the owner wants a message sent or work tracked, set `ambiguityReason` rather than guessing — the app will ask a short clarifying question.
>
> Never state or imply an outcome (sent, assigned, delivered) until the tool's own result confirms it.

## Rollout sequencing (do not skip)

1. Add `route_people_action` additively — do not remove `send_direct_whatsapp_message`/`send_delegation` from the tool list yet.
2. Add the behavior rule above.
3. After a period of production verification (the app records `legacy_people_tool_bypass` in diagnostics whenever the model still calls the old tools directly — check this to see how much traffic has migrated), a follow-up patch will tighten the prompt to fully deprecate direct calls to the legacy tools.

## Rollback

Remove `route_people_action` from the tool list and revert the prompt section above. The legacy tools and their existing behavior are untouched and immediately resume as the only path — no app code change is needed to roll back.

## Validation

Not yet validated in production — pending Sana pasting this into the dashboard. Client-side code (routing logic, diagnostics, legacy-bypass telemetry) is merged and tested; see `RA7ETBAL_STATE.md` for the code-level verification already completed.
