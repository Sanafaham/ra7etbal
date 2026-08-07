# ElevenLabs Prompt Patch — get_commitment_history
**Date:** 2026-08-03
**Feature:** Historical Lookup — Phase 1, Q4 Commitment History
**PR:** #163 (initial backend/widget), tool registration and prompt insertion completed directly via the ElevenLabs API during the Blue Pen incident investigation (see `RA7ETBAL_STATE.md`).

**STATUS: APPLIED.** Both insertions below (and the tool registration itself,
which was found to be separately missing — see the Blue Pen incident record
in `RA7ETBAL_STATE.md`) are live on the production agent and confirmed
working by direct production evidence on 2026-08-04
(conversation `conv_2401kz4qx1s4errtchfz1afns3gh`). This file is kept as the
historical record of what was inserted and why — the insertions below no
longer need to be pasted; they are already on the live agent.

---

## What to do

Two insertions into the live ElevenLabs dashboard prompt. Open the Carson agent → System Prompt tab, then make both changes below.

---

## Insertion 1 — TOOLS section

Find this block (added by the Operations Center V1 patch):

```
get_operations_summary — live operational health snapshot: WhatsApp delivery failures and reminder delivery issues in the last 48 hours. Use when the user asks about overall delivery status, whether anything failed, or operational health — "Is everything working?", "Any delivery problems?", "Did anything go wrong today?", "Are there any issues?".
```

Immediately after it, add:

```
get_commitment_history — the full evidence-based history of one specific commitment (task, reminder, or delegation), not just its delivery status. Use when the user asks whether something ever got done, what happened to it, or wants the full story — "Did the guest room ever get prepared?", "What happened to the passport reminder?", "Whatever happened with the flowers?". Param: keyword (task description or the assigned person's name). Do not use this for "did it deliver" questions — that is get_task_delivery_status.
```

---

## Insertion 2 — COMMITMENT HISTORY section

Find this block (end of DELIVERY STATUS section, added by the Operations Center V1 patch):

```
When the user asks about overall delivery health, delivery failures, or operational status — "Is everything working?", "Any delivery problems?", "Did anything go wrong?", "Are there any issues?" — call get_operations_summary.
Report what it returns. If there are no failures, say so plainly.
Do not offer to fix failures — report only.
```

Immediately after it, add:

```
COMMITMENT HISTORY
When the user asks whether a specific task, reminder, or delegation ever happened, what happened to it, or wants its full history — "Did the guest room ever get prepared?", "What happened to the passport reminder?", "Whatever happened with the flowers?" — call get_commitment_history with a keyword from the task description or the assigned person's name.
This is different from a delivery-status question. Use get_task_delivery_status only for "did it deliver / did they get the message." Use get_commitment_history for "did it actually happen / what's the full story."
If more than one commitment matches, read back the short list it returns and ask which one the user means. Never guess between them.
Report the outcome and the evidence exactly as returned. If it flags something worth noting — a contradiction between the recorded outcome and a downstream event — say that too, plainly, without downplaying or resolving it yourself.
If nothing matches, say so plainly. Do not guess or reconstruct from memory.
```

---

## Validation

After pasting, start a voice or typed session and say:
> "Did the guest room ever get prepared?"

Carson should silently call `get_commitment_history` and answer with the outcome plus one or two dated pivotal events, not a raw log. If two tasks match "guest room," Carson should read back the short list and ask which one.

## Rollback

Remove the `get_commitment_history` TOOLS entry and the COMMITMENT HISTORY section from the live agent prompt via PATCH API. No code changes needed — the client tool remains registered in ElevenLabsAgentWidget.tsx but will not be invoked without prompt routing rules.

## Related

- `src/lib/carson-commitment-history.ts` — implementation (resolution, timeline merge, conflict resolution, answer formatting)
- Historical Lookup Architecture (frozen, this conversation) — Q4 Commitment History
- `docs/elevenlabs-prompt-patches/2026-08-01-operations-center-v1-tools.md` — the sibling delivery-status tool this is deliberately distinct from
- `docs/elevenlabs-prompt-patches/` — all prompt patches live here, never the full prompt
