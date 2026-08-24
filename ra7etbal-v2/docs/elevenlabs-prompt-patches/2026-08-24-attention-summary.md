# ElevenLabs Prompt Patch — get_items_needing_attention
**Date:** 2026-08-24
**Feature:** Second Brain — attention_summary_read (get_items_needing_attention)
**PR:** #323

**STATUS: NOT YET APPLIED — requires manual dashboard action.** This session
has no `ELEVENLABS_API_KEY`, so neither the tool registration nor the prompt
insertion below could be applied via the API (as some prior patches were).
Sana must do both steps by hand. This file is the exact, complete
instruction set — nothing further needs to be worked out.

---

## Why two separate steps are both required

The Tool Registration Drift incident (2026-08-04, see `RA7ETBAL_STATE.md`)
proved that a tool can exist as a correctly-schemed resource in the
workspace's Tools tab while never being attached to the live agent's
`tool_ids` — and separately, that a tool can be attached but never mentioned
in the prompt, so the model never knows to call it. Both failure modes look
identical from the outside ("the tool exists, why doesn't Carson use it?").
Both steps below are required; skipping either silently reproduces that
incident for this tool.

---

## Step 1 — Create and attach the tool resource

In the ElevenLabs dashboard, open the Production Carson agent (agent id
`agent_3001kt3zzkcxfb3bwejd8yzzhnmy`, per this repo's
`scripts/carson-diagnose.mjs` default — confirm this is the agent you
normally test Talk to Carson / Type to Carson against before proceeding).

Add a **Client Tool** (not a Webhook/Server tool — this one runs in the
browser, exactly like `get_operations_summary` and `get_task_delivery_status`
already do) with exactly:

- **Name:** `get_items_needing_attention`
- **Description:** `Grounded, live read of what genuinely needs the owner's attention right now — pending owner tasks, overdue reminders, active delegations awaiting confirmation, and open staff escalations needing an owner decision. Use when the owner asks "what needs my attention", "what's pending", "what's on my plate", "what am I waiting on", or similar open operational questions. Always call this rather than answering from memory or the morning brief you were given at the start of the session — this tool re-checks live data. If the result says information may be incomplete, say so — never imply the picture is complete when it isn't. If the result says nothing needs attention, say that plainly — never invent urgency.`
- **Parameters:** none. The tool takes no input.
- **Response timeout:** match whatever `get_operations_summary` currently uses (same shape — one or two Supabase round trips, comparable latency profile). Do not set a shorter timeout than that tool's.

Make sure the tool is attached to *this* agent specifically — not merely
present in the workspace-level Tools list. That distinction is exactly what
the 2026-08-04 incident got wrong.

---

## Step 2 — Prompt insertion

Open the Carson agent → System Prompt tab.

### Insertion A — TOOLS section

Find the block added by the Operations Center V1 patch:

```
get_operations_summary — live operational health snapshot: WhatsApp delivery failures and reminder delivery issues in the last 48 hours. Use when the user asks about overall delivery status, whether anything failed, or operational health — "Is everything working?", "Any delivery problems?", "Did anything go wrong today?", "Are there any issues?".
```

Immediately after it (or after whichever tool entry is currently last in
this section — order doesn't matter, only that it's present), add:

```
get_items_needing_attention — grounded, live read of what genuinely needs the owner's attention right now (pending tasks, overdue reminders, active delegations, open staff escalations needing a decision). Use whenever the owner asks an open operational question — "What needs my attention?", "What's pending?", "What am I waiting on?", "What's on my plate?" — instead of answering from the morning brief you were given at session start or from memory. This is different from get_operations_summary (delivery/health status only) and from get_task_delivery_status/get_commitment_history (about one specific named task). Use this one for the general "what's outstanding" question.
```

### Insertion B — behavior section

Find the end of the DELIVERY STATUS / COMMITMENT HISTORY section (added by
earlier patches) and add a new block:

```
ATTENTION SUMMARY
When the owner asks a general "what needs my attention / what's pending / what am I waiting on" question, call get_items_needing_attention. Do not answer this question from the opening brief or from memory — always call the tool, even if you already gave a morning brief earlier in this same session, since new items may exist now.
Report exactly what the tool returns. If it says nothing needs attention, say that plainly — do not invent something to report. If it says the check was incomplete or partial, say so — never imply you have the full picture when you don't. Never state a pending item, delegation, or escalation that the tool result did not actually return.
```

---

## Validation

After both steps, start a fresh Talk to Carson (or Type to Carson) session
and ask:

> "What needs my attention?"

Carson should silently call `get_items_needing_attention` (confirm via the
ElevenLabs conversation's tool-call chip / `carson-diagnose.mjs inspect`)
and answer only from what the tool actually returned — including saying
"nothing needs your attention" plainly if that's what the tool reports, and
disclosing incompleteness if the tool reports `completeness: partial`.

Then run, with `ELEVENLABS_API_KEY` set:

```
npm run carson:diagnose -- audit
```

Before these two steps, this will report `get_items_needing_attention` under
**FAIL — MISSING on the agent**. After both steps, it must report **PASS**
on all three checks (registered, not orphaned, not prompt-blind) with zero
other regressions (no other tool should newly appear as missing, orphaned,
or prompt-blind — if one does, stop and investigate before treating this
patch as applied).

## Rollback

Detach the tool from the agent's `tool_ids` (or delete the client tool
resource) and remove both prompt insertions above from the live agent
prompt. No code changes needed — the client tool implementation remains in
`ElevenLabsAgentWidget.tsx`/`carson-operations-center.ts` but will not be
invoked without both the registration and the prompt routing rule.

## Related

- `src/lib/carson-operations-center.ts` — `fetchAttentionEvidence` / `renderAttentionSummary` / `fetchAttentionSummary`
- `src/components/home/ElevenLabsAgentWidget.tsx` — `get_items_needing_attention` clientTool entry
- `carson-protected-registry.json` — `attention_summary_read` capability
- `docs/elevenlabs-prompt-patches/2026-08-01-operations-center-v1-tools.md` — the sibling delivery/health-status tool this is deliberately distinct from
- `docs/elevenlabs-prompt-patches/README.md` — all prompt patches live here, never the full prompt
