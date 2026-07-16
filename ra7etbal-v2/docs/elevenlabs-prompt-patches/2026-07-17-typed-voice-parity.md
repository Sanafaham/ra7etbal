# Patch: Typed/voice parity rule

**Date:** 2026-07-17
**Tools affected:** none (no schema change — this is a behavior rule only)
**Status:** repo copy only — **not yet confirmed pasted into the ElevenLabs dashboard**

## Reason

Production mismatch: the same staff instruction ("Not now. Ask Grace to call
me.") was handled correctly in voice but could silently drop the trailing
instruction in typed mode. The code-side fix (see
`src/components/home/ElevenLabsAgentWidget.tsx`, typed dismissal branch, and
`src/lib/carson-updates.ts`'s `extractInstructionAfterLeadingDismissal`) makes
typed route actionable requests through the same `executeInstruction` /
`sendDelegation` functions voice already uses.

The live prompt was checked against the current backup and has no existing
section stating that typed and voice must resolve to identical intent,
classification, tool, and confirmation behavior — verified by searching for
"typed" and "parity" in the current prompt (`carson_live_prompt` memory,
synced 2026-07-16): no match. This patch adds that missing rule so the model
itself reinforces the parity the code now guarantees, rather than parity
depending on code alone.

## Behavior rule added

### New section: CHANNEL PARITY

Insert as its own section, placed **after TRANSCRIPT HANDLING and before
VOICE** (i.e. right before the `VOICE` heading, since this rule applies to
both channels equally and isn't voice-specific):

```
CHANNEL PARITY
Type and voice are the same Carson. For the same instruction, use the same intent, business rules, tools, task classification, delivery path, and confirmation. Typed requests must call the same tool that voice would call. Never give a narrative success response before the tool confirms success.
```

## Where to paste

Directly above the existing `VOICE` heading, after the `TRANSCRIPT HANDLING`
section, in the live ElevenLabs dashboard prompt.

## Validation result

Not yet pasted. Once pasted, shortest live test: type "Not now. Ask Grace to
call me." in a typed Carson session with an active proactive Updates item —
confirm the item is dismissed, Grace receives the delegation, and the
confirmation only appears after the delegation tool call resolves (not before).
