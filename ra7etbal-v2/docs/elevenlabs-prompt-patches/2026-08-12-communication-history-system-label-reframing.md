# ElevenLabs Prompt Patch — Communication History system-label reframing + date anchoring

**Date:** 2026-08-12
**Feature:** Workstream 4, Phase 1 — `get_communication_history` (second follow-up correction)

**STATUS: PENDING.** Narrow additive guidance for the same `COMMUNICATION
HISTORY` section extended by `2026-08-11-communication-history-actor-attribution.md`.
No tool, schema, or code change — `src/lib/carson-communication-history.ts` is
untouched. Only tightens how Carson speaks two specific shapes of the tool's
already-correct output.

## Why

A live production re-test of the prior patch ("What has Christopher told
us?") showed real improvement — no fabricated events, no wrong-actor
attribution — but surfaced two narrower gaps:

1. Carson said "the owner approved one of the photos" while speaking
   directly to the owner. Traced to the exact source: `buildCommunicationHistory`
   labels an escalation-decided event as `Owner decided: "Approve it"` — a
   **system-generated status label**, not a stored message that was
   originally addressed to Christopher. The prior patch's reframing rule was
   worded around "a message Carson sent the person that refers to 'the
   owner'" — its example only covers stored messages, so the model
   reasonably didn't generalize it to a code-generated label describing an
   owner decision.
2. Carson's answer read "on Aug 4 and 5, he sent photos... confirmed... and
   the owner approved one of the photos" — every fact was true and correctly
   dated underneath, but folding three facts under one shared two-date
   header left it ambiguous which fact belonged to which date.

## What to do

Two more sentences, appended to the end of the same `COMMUNICATION HISTORY`
section — immediately after the paragraph block added by
`2026-08-11-communication-history-actor-attribution.md`, still before
`DETERMINISTIC TOOL PRECEDENCE`. Do not remove or reorder anything already
there.

## Insertion — end of the COMMUNICATION HISTORY section (after the prior addition)

```text
A returned event's label may be system-generated rather than a stored message — for example an escalation label like "Owner decided: 'Approve it'". Apply the same listener-relative reframing to these: when speaking directly to the owner, render the owner's own historical action as "you" (for example, "You approved that photo on August 5"), never "the owner", while keeping the real date and fact unchanged.
When a group of events spans more than one real date, anchor each materially different date in its own clause rather than folding multiple dates into one shared date phrase — say what happened on each date separately, so the listener is never left unsure which date a given fact belongs to.
```

## Regression target

BAD (what Carson actually said on retest):
> "...on Aug 4 and 5, he sent photos as proof of completed tasks, confirmed
> 'Yes I did it,' and the owner approved one of the photos."

ACCEPTABLE:
> "On August 4, Christopher sent the photos and said, 'Yes I did it.' Carson
> recorded the photo and asked you to review it. You approved it on August 5.
> On August 8, Christopher sent 'Thanks.'"

Exact wording may differ — Christopher's actions stay Christopher's, Carson's
actions stay Carson's, owner actions become "you" when speaking directly to
Sana, each materially different date is clearly anchored in its own clause,
and no historical event may sound like a current action.

## Validation

Re-run the same live test: ask Carson "What has Christopher told us?" and
check the answer no longer says "the owner" to Sana and no longer leaves
Aug 4 and Aug 5 facts ambiguously grouped. If it still does either, stop and
report the exact response before broadening this patch further.

## Rollback

Remove the two sentences above from the live `COMMUNICATION HISTORY`
section. Prompt-text only — no code, schema, or tool-attachment rollback
needed.

## Known separate issue (not addressed by this patch)

A read-only trace during this investigation found that the specific task
this regression case was built on (`7fdbe86c-09e5-4441-8c6a-924952d42d8c`)
was deleted from `tasks` on 2026-08-11, and an `ON DELETE SET NULL`-shaped
cascade nulled `task_id` on both the related `staff_messages` row and the
related `staff_escalation_owner_decisions` row at the identical timestamp.
A fresh `get_communication_history` call today would no longer surface that
escalation event, since wave 2's join depends on the now-null `task_id`.
This is a real, separate data-linkage risk — flagged here for a future
read-only investigation, not addressed or acted on by this patch.

## Related

- `docs/elevenlabs-prompt-patches/2026-08-11-communication-history.md` — the
  base `get_communication_history` patch.
- `docs/elevenlabs-prompt-patches/2026-08-11-communication-history-actor-attribution.md` —
  the first follow-up correction this one extends.
- `src/lib/carson-communication-history.ts` — unchanged; `buildCommunicationHistory`'s
  escalation-event label (`Owner decided: "..."`) is the exact source string
  this patch's first sentence addresses.
