# ElevenLabs Prompt Patch — get_communication_history
**Date:** 2026-08-11
**Feature:** Workstream 4, Phase 1 — Unified Communication History

**STATUS: PENDING.** The backend, widget registration, and tests are
implemented and merged, but this patch has **not** been pasted into the live
ElevenLabs dashboard prompt, and the `get_communication_history` tool has
**not** been registered on the live agent's `tool_ids` yet — no ElevenLabs
API key was available in the session that implemented this slice. Per the
exact lesson from the Blue Pen incident (see `RA7ETBAL_STATE.md`), **do not
assume this tool works in production until both of those are confirmed
done** — a tool existing in code and in this patch file proves nothing about
whether the live agent can actually call it.

**Before marking this APPLIED:** run `npm run carson:diagnose -- audit` with
a valid `ELEVENLABS_API_KEY` and confirm `get_communication_history` shows
no missing/orphaned/prompt-blind result.

**Important framing for the model:** this tool is read-only, **not
immutable**. Never let the prompt or Carson's phrasing imply this is a
tamper-proof audit record — see `src/lib/carson-communication-history.ts`'s
own header for why (Workstream 4, Phase 1 of 2; the immutable evidence
ledger is Phase 2, not yet built).

---

## What to do

Two insertions into the live ElevenLabs dashboard prompt, plus one tool
registration, matching `get_person_history`'s existing registration pattern
exactly (`type: client`, `execution_mode: immediate`, `expects_response:
true`).

---

## Tool registration

```json
{
  "type": "client",
  "execution_mode": "immediate",
  "expects_response": true,
  "name": "get_communication_history",
  "description": "Reconstructs what Carson has said to or heard from a specific person, in chronological order, across every channel (staff messages, personal WhatsApp replies, direct messages, delivery status, owner decisions tied to their messages). Use when the user asks what was said/discussed/heard with someone, not their task outcome counts (that is get_person_history) or one specific task's lifecycle (that is get_commitment_history).",
  "parameters": {
    "type": "object",
    "properties": {
      "person_name": {
        "type": "string",
        "description": "The person's name whose communication history to look up."
      }
    },
    "required": ["person_name"]
  }
}
```

## Insertion 1 — TOOLS section

Find the `get_person_history` TOOLS entry. Immediately after it, add:

```text
get_communication_history — what was said/heard with a specific person, in chronological order, across every channel (staff messages, personal replies, direct messages, delivery status, owner decisions tied to their messages). Use when the user asks what was said, discussed, or heard with someone — "What has Christopher told us?", "What did we hear from Grace?" — not their task outcome counts (use get_person_history) or one specific task's story (use get_commitment_history). Param: person_name.
```

## Insertion 2 — COMMITMENT HISTORY / PERSON HISTORY section

Find the `PERSON HISTORY` section (added by the Phase 2 patch). Immediately
after it, add:

```text
COMMUNICATION HISTORY
When the user asks what was said, discussed, or heard with a specific person — not their task outcomes, not one specific commitment — call get_communication_history with the person's name.
This is distinct from both other history tools: get_commitment_history answers "what happened with this one task"; get_person_history answers "how many commitments and what were the outcomes"; get_communication_history answers "what did we actually say to each other, in order."
Report events exactly as returned, in the order given. Never present this as a tamper-proof or permanent record — it is a current, best-effort reconstruction, not an audit log.
If the tool reports the history may be incomplete, say so plainly rather than presenting it as complete.
If more than one person matches the name, ask which one before proceeding — never guess.
Do not answer a communication-history question from memory or from ra7etbal_state when this tool is available — always call it.
```

---

## Validation

After registering and pasting, start a voice or typed session and say:
> "What has Christopher told us?"

Carson should silently call `get_communication_history` and answer with a
chronological list of real events — not a task-outcome summary (that
phrasing belongs to `get_person_history`) and not a single-task lifecycle
(that belongs to `get_commitment_history`).

## Rollback

Remove the `get_communication_history` TOOLS entry and COMMUNICATION
HISTORY section from the live prompt, and remove the tool from the agent's
`tool_ids`, via PATCH API. No code changes needed — the client tool remains
registered in `ElevenLabsAgentWidget.tsx` but will not be invoked without
both the prompt routing rule and the live tool registration.

## Related

- `src/lib/carson-communication-history.ts` — `lookupCommunicationHistory()`, `resolvePersonForCommunicationHistory()`, `buildCommunicationHistory()`, `formatCommunicationHistoryAnswer()`
- `docs/elevenlabs-prompt-patches/2026-08-04-person-history.md` — the sibling tool this is deliberately distinct from (outcome counts vs. chronological communication)
- `scripts/carson-diagnose.mjs audit` — run this after registering, to independently confirm the tool is actually callable before treating this patch as APPLIED
- `docs/elevenlabs-prompt-patches/` — all prompt patches live here, never the full prompt
