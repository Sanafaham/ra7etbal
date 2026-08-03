# Commitment History Tool-Routing Investigation — Forensic Runbook

Status: **BLOCKED** pending ElevenLabs conversation-level evidence.
Date frozen: 2026-08-03.

This file is the canonical diagnostic procedure for this investigation. Do not
restart the investigation from scratch in a future session — resume from the
runbook below only, once a read-only ElevenLabs API key (or equivalent
conversation-level evidence) becomes available.

## What is proven, and does not need re-checking

- Backend (`get_commitment_history` / `carson-commitment-history.ts`): implemented
  correctly, unit-tested, cannot structurally produce a clock-time answer.
  Merged to `main` across PRs #163, #164, #165, #166.
- Widget registration (`ElevenLabsAgentWidget.tsx`): `get_commitment_history`,
  `get_task_delivery_status`, `get_operations_summary`, `search_calendar_history`
  are all present, correctly named, correctly typed, wired identically to every
  working tool. Verified directly against the live production JS bundle
  (`www.ra7etbal.com`), not just the repo.
- Deployment: the deployed commit matches `origin/main` exactly; no stale-build
  or caching explanation is possible (`public/sw.js` has no fetch handler;
  `Cache-Control: no-store` on app routes).
- ElevenLabs Tool registration: all four tools are now registered in the
  ElevenLabs dashboard's Tools tab with the correct `keyword` (string,
  required) schema, confirmed by Sana directly.
- Prompt: `COMMITMENT HISTORY` section has been strengthened across four
  rounds (compression fix → narrow guardrail → broad guardrail → explicit
  "not an exception to it" clause for completed-looking matches). None of the
  four changed the observed behavior on a fresh-session live test.
- Supabase evidence: `pg_stat_statements` (tracking since project creation,
  2026-05-07) shows **zero** executions, ever, of the query fingerprint unique
  to `findCommitmentCandidates` (the `ILIKE` OR-search against
  `tasks.description`/`assigned_to` selecting `escalated_at`,
  `followup_sent_at`, `worker_reply`, `quality_review_note` together). Same
  zero result for `get_task_delivery_status`'s fingerprint. Re-checked
  immediately after the most recent live test — still zero.
- Observed symptom: on a genuinely fresh conversation, on the live site (not
  ElevenLabs dashboard Preview), asking "What happened with the blue pen?"
  produces an immediate answer ("...at 6:12 PM — it's marked done") with no
  pause, even though the ElevenLabs tool has "Wait for response" enabled
  (which should force a pause on any real tool round-trip). The clock time in
  the answer matches only the static `{{ra7etbal_state}}` "COMPLETED" block
  built by `carson-context.ts`, which `get_commitment_history` cannot produce.

**Conclusion of everything above: the remaining uncertainty is entirely on the
ElevenLabs side — whether the LLM ever decided to call the tool, and if so,
where in ElevenLabs' own dispatch chain it stopped. This cannot be resolved
further from source code, Supabase, or the deployed bundle. It requires
ElevenLabs conversation-level evidence.**

## What NOT to do until evidence is obtained

- Do not make further prompt changes.
- Do not make further frontend or backend changes.
- Do not re-research ElevenLabs documentation.
- Do not run another production test as a substitute for real evidence — it
  only reproduces the same ambiguity.

## Prerequisites once a read-only ElevenLabs API key is available

- Agent ID: `agent_3001kt3zzkcxfb3bwejd8yzzhnmy`
- Approximate time window of the failing test conversation (needed to find its `conversation_id`).

## Call 1 — Locate the conversation

```http
GET /v1/convai/conversations?agent_id=agent_3001kt3zzkcxfb3bwejd8yzzhnmy&call_start_after_unix=<window_start>&call_start_before_unix=<window_end>
```
Match by `start_time_unix_secs` to find the exact `conversation_id`.

## Call 2 — Confirm the configured LLM

```http
GET /v1/convai/agents/agent_3001kt3zzkcxfb3bwejd8yzzhnmy
```
Read the agent's configured model (`conversation_config.agent.prompt.llm` or
equivalent). Context for interpreting Stage 1 — fast/low-latency models
(Gemini Flash, Claude Haiku, GPT-4o-mini class) are documented by ElevenLabs
as the recommended choice for real-time voice, and are independently known to
be less reliable at consistently prioritizing one instruction inside a large
system prompt over directly-relevant injected context.

## Call 3 — Pull the full transcript (the decisive call)

```http
GET /v1/convai/conversations/{conversation_id}
```
In `transcript[]`, find the user turn asking about the blue pen, then take
every subsequent entry up to (not including) the next `role: "user"` turn —
this is the agent's complete response to that question, including any
tool_calls/tool_results attached anywhere within it, not just on the single
immediately-following turn. Inspect, across that whole slice, in order:
1. `tool_calls[]` — `tool_name`, `type`, `params_as_json`, `request_id`, `tool_has_been_called`.
2. `tool_results[]` — matching `request_id`, `result_value`, `is_error`, `tool_latency_secs`.
3. The agent's spoken `message` text (joined across the slice), compared against `result_value`.

## Stage definitions (success vs. failure evidence)

| Stage | Success evidence | Failure evidence |
|---|---|---|
| 1. LLM selected `get_commitment_history` | `tool_calls[]` entry with `tool_name: "get_commitment_history"` exists on the turn | `tool_calls[]` empty/absent — matches all prior evidence (zero DB trace, no pause) |
| 2. ElevenLabs dispatched the tool | `tool_has_been_called: true`, `type: "client"` | `tool_has_been_called: false` (matches a documented community bug: tool defined in agent config but not correctly passed/dispatched) |
| 3. Browser received the call | a `tool_results[]` entry exists for that `request_id` | no matching `tool_results[]` entry at all |
| 4. Browser executed the handler | non-trivial `tool_latency_secs`, `is_error: false` | `is_error: true`, or near-zero latency inconsistent with a real Supabase round-trip — if this stage looks successful, it directly contradicts the Supabase zero-trace finding and must be re-verified, not taken at face value |
| 5. Tool returned | `result_value` contains a formatted lifecycle answer | `result_value` empty/null or `is_error: true` |
| 6. LLM incorporated the result | spoken `message` matches `result_value` content | spoken `message` contains details the tool cannot produce (e.g. a clock time) — the signature already identified as context-improvisation rather than tool-result use |

## Decision tree

```text
tool_calls[] empty/absent?
  YES → STAGE 1 FAILURE. Root cause: LLM never selected the tool. Stop here.
  NO  → continue

tool_has_been_called == false?
  YES → STAGE 2 FAILURE. ElevenLabs dispatch problem.
  NO  → continue

no matching tool_results[] entry?
  YES → STAGE 3/4 FAILURE (undifferentiated from this API alone — would need
        the client-side /debug/carson local ring buffer on the exact device
        used, which is not remotely obtainable).
  NO  → continue

is_error == true OR result_value empty?
  YES → STAGE 4/5 FAILURE. Cross-check against Supabase pg_stat_statements —
        if that still shows zero DB traffic, this is a contradiction requiring
        re-verification, not a conclusion taken at face value.
  NO  → continue

spoken message matches result_value?
  YES → SUCCESS — all 6 stages passed for this conversation.
  NO  → STAGE 6 FAILURE. Tool succeeded; the LLM's response generation
        ignored or overrode the returned evidence.
```
