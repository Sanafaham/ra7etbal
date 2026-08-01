# ElevenLabs Prompt Patch — Operations Center V1 Tools
Date: 2026-08-01
Applied via: PATCH API (agent_3001kt3zzkcxfb3bwejd8yzzhnmy)
Status: LIVE

## What changed

Two additions to the live Carson ElevenLabs prompt.

### 1. TOOLS section — two new entries

Inserted immediately after the `search_calendar_history` entry, before the LIVE WEB RESEARCH WITH TAVILY section.

**Added:**
```
get_task_delivery_status — look up live WhatsApp delivery state for a task or person. Use when the user asks whether a specific message or task was delivered, received, or read — "Did Ahmed get the message?", "Was the task delivered?", "Did Christopher receive it?". Param: keyword (task description or person's name).
get_operations_summary — live operational health snapshot: WhatsApp delivery failures and reminder delivery issues in the last 48 hours. Use when the user asks about overall delivery status, whether anything failed, or operational health — "Is everything working?", "Any delivery problems?", "Did anything go wrong today?", "Are there any issues?".
```

### 2. DELIVERY STATUS routing section

Inserted after the CALENDAR HISTORY section, before the DETERMINISTIC TOOL PRECEDENCE section.

**Added:**
```
DELIVERY STATUS
When the user asks whether a specific WhatsApp message or task was delivered, received, or read, call get_task_delivery_status with a keyword from the task description or person's name.
Never answer delivery questions from ra7etbal_state or session context — always call the live tool.
Report the actual delivery state: sent, delivered, read, or failed. If failed, state the reason.
Do not offer to resend or retry — report the state only.

When the user asks about overall delivery health, delivery failures, or operational status — "Is everything working?", "Any delivery problems?", "Did anything go wrong?", "Are there any issues?" — call get_operations_summary.
Report what it returns. If there are no failures, say so plainly.
Do not offer to fix failures — report only.
```

## Why

P1 #3 (Operations Center V1) added two client tools to ElevenLabsAgentWidget.tsx:
- `get_task_delivery_status` (PR #151, commit b676e65)
- `get_operations_summary` (PR #151, commit b676e65)

Without prompt entries, Carson had no routing instructions for these tools and answered delivery questions from the frozen `ra7etbal_state` session context instead of querying live data.

## Validation phrase

Ask Carson: "Did [name] get the message?" — Carson should call get_task_delivery_status and return live delivery state, not a session-context answer.

Ask Carson: "Is everything working?" — Carson should call get_operations_summary and return a live 48h operational snapshot.

## Rollback

To revert: remove the two TOOLS entries and the DELIVERY STATUS section from the live agent prompt via PATCH API. No code changes needed — the client tools remain registered in ElevenLabsAgentWidget.tsx but will not be invoked without prompt routing rules.

## Related

- PR #151 — Operations Center V1 code
- `src/lib/carson-operations-center.ts` — tool implementation
- `docs/elevenlabs-prompt-patches/` — all prompt patches live here, never the full prompt
