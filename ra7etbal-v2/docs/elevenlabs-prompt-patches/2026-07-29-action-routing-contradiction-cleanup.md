# Carson ACTION ROUTING contradiction cleanup

**Date:** 2026-07-29
**Agent:** CARSON (`agent_3001kt3zzkcxfb3bwejd8yzzhnmy`)
**Code contract:** `src/lib/communication-vs-delegation.ts` (`isCommunicationStyleTaskText`)
**Application status:** APPLIED — removed by Sana directly in the live ElevenLabs dashboard.

## Reason

While reviewing the live prompt to paste [2026-07-29-direct-message-truthfulness-and-routing.md](2026-07-29-direct-message-truthfulness-and-routing.md), Sana found a pre-existing contradiction: the live prompt's "ACTION ROUTING — REQUIRED" section instructed the model to *"Always use send_delegation"* for any `[command] + [person] + "to" + [verb]` construction, "regardless of which command word introduces it" — and used **"Ask Grace to call me."** and **"Tell Christopher to wait for me in the kitchen."** as its own examples of this.

Both of those exact phrases are confirmed, protected, locked product behavior as **communication, not delegation** — per this repo's own PR #49/#50 history (`isCommunicationStyleTaskText` in `communication-vs-delegation.ts`, and `carson-protected-behaviors.test.ts`'s "Regression: confirmed production evidence must never reproduce" suite, which locks `isCommunicationStyleTaskText("call me.")` and `isCommunicationStyleTaskText("wait in the kitchen for me.")` as `true`).

The contradiction was direct and internal to the prompt itself: "ACTION ROUTING — REQUIRED" gave the wrong answer for its own examples, while "MESSAGE VERSUS TASK ROUTING" (immediately below it in the same prompt) already gave the correct rule and explicitly states: *"The words 'ask' and 'tell' do not determine the tool."* Two competing rules for the same phrasing existed in the same live prompt.

## Fix

Deleted the entire "ACTION ROUTING — REQUIRED" section (header through its closing example). Nothing else in the prompt references it by name, so removal required no other edits. "MESSAGE VERSUS TASK ROUTING," "CLEAR DELEGATION," "COMPLEX DELEGATION," "GUEST AND HOSTING OPERATIONS," and the newly-added "DIRECT COMMUNICATION AND EXECUTION TRUTHFULNESS" section are unaffected and remain mutually consistent.

## Removed text (for the record — do not reintroduce)

```text
ACTION ROUTING — REQUIRED
When a command word — "Tell," "Ask," "Have," or "Get" — is immediately followed by a named person, then "to" plus an action verb, the person is being instructed to do something. Always use send_delegation for this construction, regardless of which command word introduces it.
Pattern:
[command] + [person] + "to" + [action verb], directly instructing that person to do something.
Examples:
- Tell Christopher to wait for me in the kitchen.
- Tell Ghulam to bring the car.
- Ask Grace to call me.
- Have Nasira prepare the room.
This pattern does not include a request that only conveys information, asks a personal question, or uses the word "to" elsewhere in the sentence rather than directly after the person's name — for example, "Tell Loulya I would like her to call me" is information conveyed to Loulya, not a direct instruction issued to her, so it is not this pattern. See MESSAGE VERSUS TASK ROUTING below.
Additional personal context does not change the routing.
Example:
"Tell Christopher to wait for me in the kitchen. I'm on the way."
Still use send_delegation.
Include "I'm on the way" inside the task message.
```

## Verification

Applied by Sana on 2026-07-29 as a full prompt replacement: she pasted the entire live prompt into this task for review, the "ACTION ROUTING — REQUIRED" section above was identified and removed (with the already-applied "DIRECT COMMUNICATION AND EXECUTION TRUTHFULNESS" section from the sibling patch retained, unchanged, at the end), and Sana confirmed pasting the complete corrected text back into the live dashboard, replacing the whole system prompt. This is a stronger verification method than a manual in-place deletion, since the entire prompt — not just the removed section — was reproduced and re-applied in full, minimizing the chance of an unrelated accidental edit elsewhere.

No API read-back was performed (no `ELEVENLABS_API_KEY` available in this task's environment) — if a future task has API access, confirm the section no longer appears anywhere in the live prompt and that all other sections are otherwise unchanged from what's recorded here.
