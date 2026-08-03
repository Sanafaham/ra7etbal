#!/usr/bin/env node
/**
 * Carson Reliability Engineering — ElevenLabs conversation diagnostic CLI.
 *
 * Wraps the exact evidence-gathering procedure in
 * docs/commitment-history-routing-investigation-runbook.md so a future
 * Carson tool-routing investigation starts from recorded facts, not
 * reconstruction.
 *
 * Requires ELEVENLABS_API_KEY. `list`/`inspect` only need convai_read scope.
 * `audit` also only reads (GET /agents/{id}) — no write scope is required for
 * any command in this script.
 *
 * Usage:
 *   node scripts/carson-diagnose.mjs list --after=<unix|iso> --before=<unix|iso>
 *   node scripts/carson-diagnose.mjs inspect --conversation-id=<id> [--keyword="blue pen"] [--tool=get_commitment_history]
 *   node scripts/carson-diagnose.mjs audit
 *
 * `audit` is the permanent tool-registration-drift check born from the Blue
 * Pen incident's true root cause: get_commitment_history existed in the
 * widget's clientTools and in the prompt text, but was never actually
 * registered on the live ElevenLabs agent, so the model could never call it.
 * Nothing in this repo alone could have caught that — it compares the
 * widget's source (what the app thinks it offers), the live agent's
 * registered tool_ids (what ElevenLabs will actually dispatch), and the live
 * prompt text (what the model is told about), and fails loudly on the first
 * mismatch in any direction. Run it by hand whenever a client tool is added,
 * renamed, or removed, or whenever Carson's behavior is under investigation
 * again — there is no stored credential to run it in CI (see
 * RA7ETBAL_STATE.md, Historical Lookup section).
 *
 * Optional: ELEVENLABS_AGENT_ID env var or --agent-id=<id> overrides the
 * default Carson agent ID below.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDGET_PATH = resolve(__dirname, "../src/components/home/ElevenLabsAgentWidget.tsx");

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

/**
 * Extracts the client tool names the widget itself offers, straight from
 * source — not a hand-maintained duplicate list that can silently drift out
 * of sync with the code, which is the exact failure mode this check exists
 * to catch. Scans the `clientTools: { ... }` object literal in
 * ElevenLabsAgentWidget.tsx and collects every top-level key.
 */
export function expectedClientTools() {
  const source = readFileSync(WIDGET_PATH, "utf8");
  const lines = source.split("\n");
  const startIdx = lines.findIndex((l) => /clientTools:\s*\{/.test(l));
  if (startIdx === -1) {
    throw new Error(`Could not find "clientTools: {" in ${WIDGET_PATH}`);
  }
  const indent = lines[startIdx].match(/^(\s*)/)[1];
  const closeLine = new RegExp(`^${indent}\\},?\\s*$`);
  const keyLine = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*):\s*(async\s+)?\(/;

  const names = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (closeLine.test(lines[i])) break;
    const m = lines[i].match(new RegExp(`^${indent}  ([a-zA-Z_][a-zA-Z0-9_]*):\\s*(async\\s+)?\\(`));
    if (m) names.push(m[1]);
  }
  if (names.length === 0) {
    throw new Error(
      `Found "clientTools: {" but extracted zero tool names — the widget's shape may have ` +
        "changed in a way this regex-based scan no longer handles. Do not trust an empty result.",
    );
  }
  return names;
}

/** Resolves the live agent's registered tool_ids to their names, and returns
 * the raw prompt text, defensively across the couple of response shapes
 * ElevenLabs has used for this field. */
async function fetchLiveAgentToolNames(args) {
  const agent = await elevenlabsGet(`/agents/${agentId(args)}`);
  const promptConfig = agent?.conversation_config?.agent?.prompt ?? {};
  const promptText = promptConfig.prompt ?? agent?.prompt?.prompt ?? "";
  const toolIds = promptConfig.tool_ids ?? agent?.tool_ids ?? [];
  const inlineTools = promptConfig.tools ?? agent?.tools ?? [];

  const resolved = [];
  for (const t of inlineTools) {
    const name = t?.tool_config?.name ?? t?.name;
    if (name) resolved.push({ id: t.id ?? t.tool_id ?? null, name });
  }

  const unresolvedIds = toolIds.filter((id) => !resolved.some((r) => r.id === id));
  for (const id of unresolvedIds) {
    try {
      const tool = await elevenlabsGet(`/tools/${id}`);
      const name = tool?.tool_config?.name ?? tool?.name ?? `(unnamed tool ${id})`;
      resolved.push({ id, name });
    } catch (err) {
      resolved.push({ id, name: `(could not resolve — ${err.message})` });
    }
  }

  return { agent, promptText, registeredTools: resolved };
}

/**
 * Permanent tool-registration-drift check. Compares three independent
 * sources of truth — the widget's actual clientTools, the live agent's
 * actual registered tool_ids, and the live prompt text — and fails loudly on
 * any mismatch. This is what would have caught the Blue Pen incident's true
 * root cause before it reached production: get_commitment_history was
 * correct in the widget and in the (locally saved) prompt, but simply never
 * registered on the live agent.
 */
async function audit(args) {
  const expected = expectedClientTools();
  const { promptText, registeredTools } = await fetchLiveAgentToolNames(args);
  const registeredNames = registeredTools.map((t) => t.name);

  const missing = expected.filter((name) => !registeredNames.includes(name));
  const orphaned = registeredNames.filter((name) => !expected.includes(name));
  const promptBlind = expected.filter(
    (name) => registeredNames.includes(name) && !promptText.includes(name),
  );

  console.log(`Expected client tools (from widget source): ${expected.length}`);
  console.log(`Registered tools on live agent: ${registeredNames.length}`);
  console.log();

  let failed = false;

  if (missing.length > 0) {
    failed = true;
    console.log("FAIL — registered on the agent but MISSING (widget offers these, agent cannot dispatch them):");
    for (const name of missing) console.log(`  - ${name}`);
  } else {
    console.log("PASS — every widget clientTool is registered on the live agent.");
  }
  console.log();

  if (orphaned.length > 0) {
    failed = true;
    console.log("FAIL — ORPHANED on the agent (registered but not offered by the widget — dead or stale):");
    for (const name of orphaned) console.log(`  - ${name}`);
  } else {
    console.log("PASS — no orphaned tools registered on the agent.");
  }
  console.log();

  if (promptBlind.length > 0) {
    failed = true;
    console.log(
      "FAIL — PROMPT-BLIND (registered and offered, but the tool's name never appears in the live prompt " +
        "text, so the model has no instruction for when to call it):",
    );
    for (const name of promptBlind) console.log(`  - ${name}`);
  } else {
    console.log("PASS — every expected tool name appears somewhere in the live prompt text.");
  }
  console.log();

  console.log(
    "NOTE: this checks tool presence and prompt mention only, not full JSON-schema parameter " +
      "diffing — that would require a second, hand-maintained schema definition that could itself " +
      "drift out of sync. Verify parameter shape manually (agent.conversation_config.agent.prompt.tools) " +
      "if a specific tool's behavior is under investigation.",
  );

  if (failed) {
    console.log("\nAUDIT RESULT: FAIL");
    process.exitCode = 1;
  } else {
    console.log("\nAUDIT RESULT: PASS");
  }
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (command === "list") return listConversations(args);
  if (command === "inspect") return inspect(args);
  if (command === "audit") return audit(args);

  console.log(
    "Usage:\n" +
      "  node scripts/carson-diagnose.mjs list --after=<unix|iso> --before=<unix|iso>\n" +
      '  node scripts/carson-diagnose.mjs inspect --conversation-id=<id> [--keyword="blue pen"] [--tool=get_commitment_history]\n' +
      "  node scripts/carson-diagnose.mjs audit\n",
  );
  process.exit(1);
}

// Only auto-run the CLI when this file is executed directly (`node
// scripts/carson-diagnose.mjs ...`), not when imported as a module — e.g. by
// scripts/carson-diagnose.test.mjs, which exercises expectedClientTools()
// without invoking the CLI's network calls.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
