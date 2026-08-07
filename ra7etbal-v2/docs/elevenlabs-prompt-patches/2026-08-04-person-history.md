# ElevenLabs Prompt Patch — get_person_history
**Date:** 2026-08-04
**Feature:** Historical Lookup — Phase 2, Person History

**STATUS: PENDING.** The backend, widget registration, and tests are
implemented and merged, but this patch has **not** been pasted into the live
ElevenLabs dashboard prompt, and the `get_person_history` tool has **not**
been registered on the live agent's `tool_ids` yet — no ElevenLabs API key
was available in the session that implemented this slice. Per the exact
lesson from the Blue Pen incident (see `RA7ETBAL_STATE.md`), **do not assume
this tool works in production until both of those are confirmed done** —
a tool existing in code and in this patch file proves nothing about whether
the live agent can actually call it.

**Before marking this APPLIED:** run `npm run carson:diagnose -- audit` with
a valid `ELEVENLABS_API_KEY` and confirm `get_person_history` shows no
missing/orphaned/prompt-blind result — that is the same check that would
have caught Blue Pen's true root cause, applied here proactively instead of
after a production failure.

---

## What to do

Two insertions into the live ElevenLabs dashboard prompt, plus one tool
registration. Open the Carson agent → System Prompt tab for the prompt
insertions; use `POST /v1/convai/tools` + `PATCH /v1/convai/agents/{id}` (or
the dashboard Tools tab) for registration, matching `get_commitment_history`'s
existing registration exactly (`type: client`, `execution_mode: immediate`,
`expects_response: true`).

---

## Tool registration

Schema, matching `get_commitment_history`'s pattern:

```json
{
  "type": "client",
  "execution_mode": "immediate",
  "expects_response": true,
  "name": "get_person_history",
  "description": "Summarizes a person's overall commitment history — outcome counts and the most recent items — rather than resolving one specific task. Use when the user asks about a person broadly (\"What's been going on with Grace?\", \"How has Christopher been doing?\"), not about one specific commitment (that is get_commitment_history).",
  "parameters": {
    "type": "object",
    "properties": {
      "person_name": {
        "type": "string",
        "description": "The person's name to look up."
      }
    },
    "required": ["person_name"]
  }
}
```

## Insertion 1 — TOOLS section

Find the `get_commitment_history` TOOLS entry (added by the Phase 1 patch).
Immediately after it, add:

```
get_person_history — a person's overall commitment history: outcome counts and the most recent items, not one specific task's story. Use when the user asks broadly about a person — "What's been going on with Grace?", "How has Christopher been doing?", "What has Grace been up to?" — not about one specific commitment (use get_commitment_history for that). Param: person_name.
```

## Insertion 2 — COMMITMENT HISTORY section

Find the `COMMITMENT HISTORY` section (added by the Phase 1 patch).
Immediately after it, add:

```
PERSON HISTORY
When the user asks broadly about a person's commitment history rather than one specific task — "What's been going on with Grace?", "How has Christopher been doing?" — call get_person_history with the person's name.
This is different from get_commitment_history: use get_commitment_history when the question names a specific task or expects one answer; use get_person_history when the question is about the person overall and multiple commitments are expected.
Report the outcome counts and recent items exactly as returned. Do not turn this into a full per-task lifecycle dump — that is get_commitment_history's job for one task, not this tool's.
If nothing matches, say so plainly. Do not guess or reconstruct from memory.
```

---

## Validation

After registering and pasting, start a voice or typed session and say:
> "What's been going on with Grace?"

Carson should silently call `get_person_history` and answer with outcome
counts plus a few recent items — not ask "which one do you mean" (that
phrasing belongs to `get_commitment_history`'s task-keyword ambiguity, not
this tool).

## Rollback

Remove the `get_person_history` TOOLS entry and PERSON HISTORY section from
the live prompt, and remove the tool from the agent's `tool_ids`, via PATCH
API. No code changes needed — the client tool remains registered in
`ElevenLabsAgentWidget.tsx` but will not be invoked without both the prompt
routing rule and the live tool registration.

## Related

- `src/lib/carson-commitment-history.ts` — `lookupPersonHistory()`, reuses `findCommitmentCandidates()`/`buildCommitmentHistory()`/`formatCommitmentHistoryAnswer()` from Phase 1 as-is
- `docs/elevenlabs-prompt-patches/2026-08-03-commitment-history.md` — the sibling single-task tool this is deliberately distinct from
- `scripts/carson-diagnose.mjs audit` — run this after registering, to independently confirm the tool is actually callable before treating this patch as APPLIED
- `docs/elevenlabs-prompt-patches/` — all prompt patches live here, never the full prompt
