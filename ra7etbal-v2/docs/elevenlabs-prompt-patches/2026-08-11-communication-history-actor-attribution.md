# ElevenLabs Prompt Patch — Communication History actor/date/tense attribution

**Date:** 2026-08-11
**Feature:** Workstream 4, Phase 1 — `get_communication_history` (follow-up correction)

**STATUS: PENDING.** Additive guidance for a section that is already live in the
ElevenLabs dashboard prompt (see `2026-08-11-communication-history.md`). This
patch does not add a new tool, does not change any tool schema, and does not
touch `src/lib/carson-communication-history.ts` — it only tightens how Carson
is instructed to *speak* the tool's already-correct, already-well-typed
output.

## Why

A real production conversation (agent CARSON, branch Main, v211) asked
"What has Christopher told us?" `get_communication_history` succeeded (865ms,
no cascade error, no fallback tool). Carson's answer:

> "Christopher sent photo evidence on August 4th and 5th. He also confirmed
> completing a task on August 4th and sent a thank you on August 8th. I've
> recorded the photo and asked the owner to review it."

Forensic trace against production Supabase confirmed:

- "I've recorded the photo and asked the owner to review it." is a **verbatim,
  word-for-word quote** of Carson's own historical `staff_messages.carson_response`
  from 2026-08-04, and the underlying fact is independently true (a real
  `staff_escalation_owner_decisions` row exists for the same task, approved by
  the owner the next day). Not a hallucination — but spoken with no past-tense
  marker and no listener-relative reframing, so it sounded like something
  Carson had just done in the current conversation, and "the owner" was said
  directly *to* the owner instead of "you".
- "sent photo evidence on August 4th **and 5th**" is **not supported by any
  record** — the only real August 5th event for this person is the *owner's*
  escalation decision, not a Christopher event. The LLM blended an adjacent
  system/owner event into a false claim about the person's actions.

Full trace is recorded in this session's forensic investigation; not
reproduced here, since this file is prompt guidance, not an incident log.

## What to do

One additive insertion at the end of the existing `COMMUNICATION HISTORY`
section (added by `2026-08-11-communication-history.md`). Do not remove or
reorder anything already in that section — append the paragraphs below
immediately after its last line ("Do not answer from memory or from
ra7etbal_state when this tool is available — always call it.").

## Insertion — end of the COMMUNICATION HISTORY section

```text
Every returned event has its own real date and its own real actor — inbound events belong to the person, outbound events belong to Carson, system events belong to the owner. Never blur these together. Speak every event as something that already happened, on its own date, from its own actor — never in a way that could sound like Carson is doing it right now.
Never combine two events into one claim unless the returned history independently supports every date and every actor in that claim. If only one date has real evidence, state only that date — do not extend a claim to a nearby date just because another, different event happened then.
Never conclude the person did something merely because an owner or system event connected to them happened on a nearby date. An owner's decision, approval, or review is the owner's action, not the person's, even when it concerns the same task or photo.
When a returned event's wording was originally addressed to someone else — for example, a message Carson sent the person that refers to "the owner" in the third person — restate it naturally for whoever you are speaking to now (say "asked you to review it" when speaking to the owner) without changing the underlying date, actor, or fact.
If attribution or timing is not clearly supported by what the tool returned, say only what is directly supported rather than filling in the rest.
```

## Regression target (from the production incident above)

BAD (what Carson actually said):
> "Christopher sent photo evidence on August 4th and 5th. I've recorded the
> photo and asked the owner to review it."

ACCEPTABLE (same underlying facts, correct attribution):
> "Christopher sent photo evidence on August 4. Carson recorded it and asked
> you to review it. You approved it on August 5."

Exact wording may differ between live runs — actor, date, and historical
framing must remain correct: Christopher's action stays on August 4 only,
Carson's action is attributed to Carson, the owner's approval stays on
August 5 and is attributed to the owner, and none of it is phrased as
happening right now.

## Validation

After pasting, run the same live test that surfaced this issue: ask Carson
(voice or typed) "What has Christopher told us?" and check the answer against
the regression target above. If the answer still blends actors, dates, or
speaks a historical action as current, this patch needs to be revisited
before being marked APPLIED — do not broaden it speculatively without a new
concrete failure to anchor the change.

## Rollback

Remove the inserted paragraphs above from the live `COMMUNICATION HISTORY`
section. No tool, schema, or code change is involved, so rollback is prompt-text
only.

## Related

- `docs/elevenlabs-prompt-patches/2026-08-11-communication-history.md` — the
  base `get_communication_history` patch this one extends.
- `src/lib/carson-communication-history.ts` — unchanged by this patch; its
  `CommunicationEvent` shape (`direction`, `eventType`, `at`, `label`) already
  encodes actor and date correctly. This patch only instructs Carson to
  preserve that separation when speaking the answer.
