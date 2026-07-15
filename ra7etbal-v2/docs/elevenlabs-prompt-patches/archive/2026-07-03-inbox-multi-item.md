# Patch: Inbox multi-item sequencing + delegate-vs-message wording

> Historical only: the Inbox surface and `act_on_inbox_item` client tool have
> been removed from the active app/runtime. Do not paste or apply this patch to
> the live ElevenLabs prompt.

**Date:** 2026-07-03
**Tools affected:** `act_on_inbox_item` (existing tool, no schema change — code-side `src/components/home/ElevenLabsAgentWidget.tsx` untouched, see reason below)
**Status:** repo copy only — **not yet confirmed pasted into the ElevenLabs dashboard**

## Reason

Production incident: a single utterance with three Inbox instructions ("turn the Gemini one into a to-do, remind me to call Grace in a minute, delegate the lunch menu one to Christopher") lost context on the third item — Carson asked "To whom?" despite Christopher already being named, and no confirmation-linked delegation was ever sent.

Investigation found no code bug: `act_on_inbox_item`'s parameter shape only ever accepts one item per call, and `extractPersonNameParam` already has robust key fallbacks. The tool was most likely never called for the third item at all — a prompt-orchestration failure (dropped context across intervening tool calls in the same turn), not a code defect. Fix is prompt-only.

## Tool schema (unchanged, for reference)

```
act_on_inbox_item:
  query: string (required)
  action: "note" | "todo" | "reminder" | "delegate" | "message" | "delete" (required)
  time_text: string (required for reminder)
  person_name: string (required for delegate or message)
```

## Behavior rules added

### 1. Replace the existing "Delegate vs. message" line

Find (in the live prompt, under ACTING ON INBOX ITEMS):

> Delegate vs. message: if the inbox item is something you want a person to DO ("Confirm the menu.", "Call Grace."), use action "delegate" — it creates a trackable task with a confirmation link and follow-up. Use action "message" only when the user clearly wants a plain FYI sent as-is, not a task. If you inferred who the recipient is rather than the user naming them, repeat the name back and wait for the user to confirm before calling act_on_inbox_item.

Replace with:

```
Delegate vs. message: use action "delegate" whenever the user's wording is delegate, send, task, or ask someone to do it, or whenever the inbox item itself is something you want a person to DO ("Confirm the menu.", "Call Grace.") — it creates a trackable task with a confirmation link and follow-up. Use action "message" only when the user clearly wants a plain FYI sent as-is, not a task. Never use "message" for task-like inbox item text. If you inferred who the recipient is rather than the user naming them, repeat the name back and wait for the user to confirm before calling act_on_inbox_item.
```

(If the live prompt doesn't have the original "Delegate vs. message" line at all yet, just paste the replacement text above as new content in the same spot — see "Where to paste" below.)

### 2. New section: MULTI-ITEM INBOX INSTRUCTIONS

```
MULTI-ITEM INBOX INSTRUCTIONS
The user may give instructions for several inbox items in a single utterance — "Turn the Gemini one into a to-do, remind me to call Grace in a minute, and delegate the lunch menu one to Christopher."

Handle each item with its own separate act_on_inbox_item call, one at a time, in the order the user said them.

Before calling the tool for an item, re-read the ORIGINAL utterance and pull that item's own query, action, time_text, and person_name from its own clause — even if you already made tool calls for earlier items in between. Do not drop or forget a name, time, or action that was stated earlier in the same utterance just because other items were handled first.

If an item's required parameter genuinely was not stated anywhere in the utterance, pause on that specific item and ask the user directly — do not silently skip it, do not guess, and do not ask a vague question without having first tried to find the answer in what the user already said.

Process every item the user named. Do not stop after the first one or two and leave the rest unhandled.
```

## Where to paste

Both blocks go in the **ACTING ON INBOX ITEMS** area of the live prompt:
1. The replaced "Delegate vs. message" line stays in its existing position (or is added there if missing).
2. The new **MULTI-ITEM INBOX INSTRUCTIONS** section goes immediately after the "Delegate vs. message" line (and after any "note or to-do already exists" line, if present) and before the **TO-DO** section begins.

## Validation test phrase

Say, in one voice session:

> "Go through my inbox, turn the Gemini one into a to-do, remind me to call Grace in a minute, and delegate the lunch menu one to Christopher."

Expected:
- Carson lists the inbox, then processes each named item with its own tool call, in order.
- The delegation to Christopher completes without Carson re-asking "to whom" — it uses the name from the original utterance.
- Christopher receives a confirmation-linked delegation message (not a bare WhatsApp text).
- Items that couldn't be resolved (duplicate to-do, reminder) remain in the inbox; only the successfully delegated item is removed.

## Rollback

If this patch causes worse behavior (e.g. Carson stalls waiting for per-item confirmation on every single-item request), remove the MULTI-ITEM INBOX INSTRUCTIONS section and restore the original "Delegate vs. message" wording (see the "Find" block above) from the live prompt's version history / your last known-good paste.
