/**
 * EVIDENCE ONLY — dry-run Second Brain consequential skill evaluation.
 *
 * OWNER UTTERANCE → server-owned skill → ONE call to ONE named model →
 * narrow capability proposal → deterministic validation (guards.ts) →
 * dry-run result. No database, no WhatsApp, no task, no message, no app
 * state. No model cascade: a run is produced by exactly the requested
 * model or it is rejected.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx --no-install vite-node \
 *     scripts/second-brain-consequential-evidence/run.ts -- --model claude-sonnet-4-6 --runs 3
 * Prints one `RESULT {json}` line per run and a summary. Exit 0 only when
 * no executed proposal is structurally unsafe; content flags still need
 * hand review and never clear a run.
 */
import { CASES, type Case } from "./corpus";
import { autoGrade } from "./grade";
import { OWNER_NAME, OWNER_PEOPLE, validateProposal } from "./guards";
import { SKILL_VERSION, TOOL_NAME, TOOL_SCHEMA, buildSkillSystemPrompt, buildSkillUserMessage, type Proposal } from "./skill";

const CALL_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 600;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface CallResult {
  proposal: Proposal | null;
  producingModel?: string;
  stopReason?: string;
  latencyMs: number;
  attempts: number;
  inputTokens?: number;
  outputTokens?: number;
  error: string | null;
}

async function callSkill(model: string, utterance: string): Promise<CallResult> {
  const system = buildSkillSystemPrompt(OWNER_NAME, OWNER_PEOPLE.map((p) => p.name));
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const started = performance.now();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools: [TOOL_SCHEMA],
          tool_choice: { type: "tool", name: TOOL_NAME },
          messages: [{ role: "user", content: buildSkillUserMessage(utterance) }],
        }),
      });
      const latencyMs = Math.round(performance.now() - started);
      const body = (await res.json()) as {
        model?: string;
        stop_reason?: string;
        content?: Array<{ type: string; name?: string; input?: unknown }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { type?: string; message?: string };
      };
      // Transient provider capacity/rate errors produced no model output: retry the SAME model (never another).
      if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempts < 4) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempts - 1)));
        continue;
      }
      if (!res.ok || body.error) {
        const detail = (body.error?.message ?? "").replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 200);
        return { proposal: null, latencyMs, attempts, error: `HTTP ${res.status} ${body.error?.type ?? ""} ${detail}`.trim() };
      }
      const block = body.content?.find((b) => b.type === "tool_use" && b.name === TOOL_NAME);
      return {
        proposal: (block?.input as Proposal) ?? null,
        producingModel: body.model,
        stopReason: body.stop_reason,
        latencyMs,
        attempts,
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
        error: null,
      };
    } catch (e) {
      const latencyMs = Math.round(performance.now() - started);
      return { proposal: null, latencyMs, attempts, error: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message.slice(0, 200) };
    }
  }
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — no evidence was produced.");
    process.exit(2);
  }
  const model = arg("model", "");
  const runs = Math.max(3, Number(arg("runs", "3")) || 3);
  const concurrency = Math.max(1, Number(arg("concurrency", "4")) || 4);
  const only = arg("only", "");
  const cases: Case[] = only ? CASES.filter((c) => only.split(",").includes(c.id)) : CASES;
  console.log(`SKILL ${SKILL_VERSION} model=${model} runs=${runs} cases=${cases.length} concurrency=${concurrency}`);

  const jobs: Array<{ c: Case; run: number }> = [];
  for (const c of cases) for (let run = 1; run <= runs; run += 1) jobs.push({ c, run });

  const results: Array<ReturnType<typeof autoGrade> & { id: string; latencyMs: number; error: string | null }> = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { c, run } = jobs[next++];
      const call = await callSkill(model, c.u);
      const guard = call.proposal
        ? validateProposal({ proposal: call.proposal, utterance: c.u, requestedModel: model, producingModel: call.producingModel })
        : null;
      const grade = autoGrade(c, call.proposal, guard, call.error ?? (call.proposal ? null : call.stopReason === "max_tokens" ? "max_tokens" : null));
      results.push({ ...grade, id: c.id, latencyMs: call.latencyMs, error: call.error });
      console.log(
        `RESULT ${JSON.stringify({
          id: c.id, run, requested: model, produced: call.producingModel ?? null, ms: call.latencyMs, att: call.attempts,
          in: call.inputTokens, out: call.outputTokens, stop: call.stopReason ?? null, err: call.error,
          p: call.proposal, g: guard ? { o: guard.outcome, f: guard.failures, r: guard.resolvedRecipient } : null,
          grade: { s: grade.safety, u: grade.usability, c02: grade.c02, caught: grade.caughtByGuard, flags: grade.flags },
        })}`,
      );
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const count = (f: (r: (typeof results)[number]) => boolean) => results.filter(f).length;
  const lat = results.filter((r) => !r.error).map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log("\nSUMMARY " + JSON.stringify({
    model, skill: SKILL_VERSION, attempted: results.length,
    errored: count((r) => r.usability === "ERROR"), malformed: count((r) => r.usability === "MALFORMED"),
    unsafe_structural: count((r) => r.safety === "UNSAFE"), review_flagged: count((r) => r.safety === "REVIEW"),
    auto_ok: count((r) => r.safety === "OK"), no_send: count((r) => r.safety === "NO_SEND"),
    caught_by_guard: count((r) => r.caughtByGuard),
    unnecessary_clarification: count((r) => r.usability === "UNNECESSARY_CLARIFICATION"),
    unnecessary_hold: count((r) => r.usability === "UNNECESSARY_HOLD"), guard_no_send: count((r) => r.usability === "GUARD_NO_SEND"),
    c02_correct: count((r) => r.c02 === "CORRECT"), c02_wrong: count((r) => r.c02 === "WRONG"),
    latency_ms: { median: pct(lat, 50), p90: pct(lat, 90), p95: pct(lat, 95), max: lat[lat.length - 1] ?? 0 },
  }));
  console.log("NOTE: REVIEW/OK proposals are NOT cleared until hand review (GRADING_RULES.md).");
  process.exit(count((r) => r.safety === "UNSAFE") === 0 ? 0 : 1);
}

void main();
