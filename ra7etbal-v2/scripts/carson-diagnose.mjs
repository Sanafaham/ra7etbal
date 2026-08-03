#!/usr/bin/env node
/**
 * Carson Reliability Engineering — ElevenLabs conversation diagnostic CLI.
 *
 * Wraps the exact evidence-gathering procedure in
 * docs/commitment-history-routing-investigation-runbook.md so a future
 * Carson tool-routing investigation starts from recorded facts, not
 * reconstruction.
 *
 * Requires ELEVENLABS_API_KEY scoped to convai_read only (read-only, no
 * write/voice/model/workspace permissions needed or used).
 *
 * Usage:
 *   node scripts/carson-diagnose.mjs list --after=<unix|iso> --before=<unix|iso>
 *   node scripts/carson-diagnose.mjs inspect --conversation-id=<id> [--keyword="blue pen"] [--tool=get_commitment_history]
 *
 * Optional: ELEVENLABS_AGENT_ID env var or --agent-id=<id> overrides the
 * default Carson agent ID below.
 */

const API_BASE = "https://api.elevenlabs.io/v1/convai";
const DEFAULT_AGENT_ID = "agent_3001kt3zzkcxfb3bwejd8yzzhnmy";

function apiKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.error("Missing ELEVENLABS_API_KEY (must be scoped to convai_read).");
    process.exit(1);
  }
  return key;
}

function agentId(args) {
  return args["agent-id"] || process.env.ELEVENLABS_AGENT_ID || DEFAULT_AGENT_ID;
}

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function toUnix(value) {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Cannot parse time value: ${value}`);
  return Math.floor(ms / 1000);
}

async function elevenlabsGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "xi-api-key": apiKey() },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ElevenLabs API ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function listConversations(args) {
  const after = toUnix(args.after);
  const before = toUnix(args.before);

  const conversations = [];
  let cursor;
  do {
    const params = new URLSearchParams({ agent_id: agentId(args), page_size: "100" });
    if (after) params.set("call_start_after_unix", String(after));
    if (before) params.set("call_start_before_unix", String(before));
    if (cursor) params.set("cursor", cursor);

    const data = await elevenlabsGet(`/conversations?${params.toString()}`);
    conversations.push(...(data.conversations ?? data.items ?? []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  if (conversations.length === 0) {
    console.log("No conversations found in that window. Widen --after/--before.");
    return;
  }
  console.log(`Found ${conversations.length} conversation(s):\n`);
  for (const c of conversations) {
    console.log(
      `  ${c.conversation_id}  start=${c.start_time_unix_secs ?? "?"}  ` +
        `duration=${c.call_duration_secs ?? "?"}s`,
    );
  }
}

/** Returns the user turn matching `keyword` plus every turn up to (not
 * including) the next user turn — i.e. the agent's full response, including
 * any tool_calls/tool_results attached to it. Returns the whole transcript
 * if no keyword is given. */
function findTurns(transcript, keyword) {
  if (!keyword) return transcript;
  const kw = keyword.toLowerCase();
  const idx = transcript.findIndex(
    (t) => t.role === "user" && (t.message ?? "").toLowerCase().includes(kw),
  );
  if (idx === -1) return [];
  const end = transcript.findIndex((t, i) => i > idx && t.role === "user");
  return transcript.slice(idx, end === -1 ? transcript.length : end);
}

/** Applies the decision tree from the runbook to a slice of turns. */
function classifyStage(turns, toolName) {
  const allToolCalls = turns.flatMap((t) => t.tool_calls ?? []);
  const allToolResults = turns.flatMap((t) => t.tool_results ?? []);
  const matchingCalls = toolName
    ? allToolCalls.filter((c) => c.tool_name === toolName)
    : allToolCalls;

  if (matchingCalls.length === 0) {
    return {
      stage: 1,
      verdict: "FAIL",
      detail: toolName
        ? `No tool_calls entry for "${toolName}" on this turn — LLM never selected the tool.`
        : "No tool_calls at all on this turn.",
    };
  }

  const call = matchingCalls[0];
  if (call.tool_has_been_called === false) {
    return {
      stage: 2,
      verdict: "FAIL",
      detail: "tool_has_been_called is false — ElevenLabs did not dispatch it.",
      call,
    };
  }
  if (call.type !== "client") {
    return {
      stage: 2,
      verdict: "FAIL",
      detail: `tool_calls[].type is "${call.type}", not "client" — this is a distinct anomaly; this tool should never be dispatched as anything but a client tool.`,
      call,
    };
  }

  const result = allToolResults.find((r) => r.request_id === call.request_id);
  if (!result) {
    return {
      stage: 3,
      verdict: "FAIL (stage 3 or 4 — undifferentiated from this API alone)",
      detail: "No tool_results entry matches this call's request_id.",
      call,
    };
  }

  if (result.is_error || !result.result_value) {
    return {
      stage: 4,
      verdict: "FAIL",
      detail:
        `is_error=${result.is_error}, result_value=${JSON.stringify(result.result_value)}. ` +
        "Cross-check Supabase pg_stat_statements before trusting this — see runbook.",
      call,
      result,
    };
  }

  // A real Supabase round trip (auth check + ILIKE query, at minimum) takes
  // measurable time. Missing or implausibly low latency doesn't fail the
  // stage outright — result_value is present and not an error — but it's
  // not a clean pass either, so it's flagged for manual verification rather
  // than silently treated as a confirmed Stage 4 success.
  const latency = result.tool_latency_secs;
  const latencyIsPlausible = typeof latency === "number" && latency >= 0.05;
  if (!latencyIsPlausible) {
    return {
      stage: 4,
      verdict: "INDETERMINATE — manual verification required",
      detail:
        `tool_latency_secs=${JSON.stringify(latency)} is missing or implausibly low for a real ` +
        "Supabase round trip. result_value is present and not an error, but this latency value " +
        "does not on its own confirm the handler actually executed — verify manually before " +
        "treating this as a Stage 4/5 pass.",
      call,
      result,
    };
  }

  return { stage: 5, verdict: "PASS (through tool return)", call, result };
}

async function inspect(args) {
  const conversationId = args["conversation-id"];
  if (!conversationId) {
    console.error("Missing --conversation-id=<id>. Run `list` first to find it.");
    process.exit(1);
  }

  const [agent, conversation] = await Promise.all([
    elevenlabsGet(`/agents/${agentId(args)}`),
    elevenlabsGet(`/conversations/${conversationId}`),
  ]);

  const model =
    agent?.conversation_config?.agent?.prompt?.llm ??
    agent?.llm ??
    "(model field not found — inspect the raw agent response manually)";
  console.log(`Configured LLM: ${model}\n`);

  const transcript = conversation.transcript ?? [];
  const turns = findTurns(transcript, args.keyword);
  if (args.keyword && turns.length === 0) {
    console.log(
      `No user turn found containing "${args.keyword}". Full transcript has ${transcript.length} turns.`,
    );
    return;
  }

  console.log(
    `Analyzing ${turns.length} turn(s)${args.keyword ? ` following "${args.keyword}"` : ""}:\n`,
  );
  for (const t of turns) {
    console.log(`  [${t.role}] ${(t.message ?? "").slice(0, 200)}`);
  }
  console.log();

  const result = classifyStage(turns, args.tool);
  console.log(`STAGE RESULT: Stage ${result.stage} — ${result.verdict}`);
  console.log(result.detail ?? "");
  if (result.call) console.log("tool_call:", JSON.stringify(result.call, null, 2));
  if (result.result) console.log("tool_result:", JSON.stringify(result.result, null, 2));

  if (result.stage >= 5) {
    const spoken = turns
      .filter((t) => t.role === "agent")
      .map((t) => t.message)
      .join(" ");
    console.log("\nAgent's spoken reply, to compare against tool_result.result_value:");
    console.log(`  ${spoken}`);
    console.log(
      "\nCompare manually: if the spoken reply contains details the tool cannot produce, that is a Stage 6 failure (see runbook).",
    );
  }
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (command === "list") return listConversations(args);
  if (command === "inspect") return inspect(args);

  console.log(
    "Usage:\n" +
      "  node scripts/carson-diagnose.mjs list --after=<unix|iso> --before=<unix|iso>\n" +
      '  node scripts/carson-diagnose.mjs inspect --conversation-id=<id> [--keyword="blue pen"] [--tool=get_commitment_history]\n',
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
