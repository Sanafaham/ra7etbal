/**
 * EVIDENCE ONLY — future V2 model-gate runner. NOT RUN in the design-freeze
 * step. Running it requires separate owner authorization of the model gate.
 *
 * One named model per invocation, no fallback. 3 runs per case, 10 per
 * C-02-critical case. Prints one `RESULT {json}` line per run and a summary.
 * No database, no WhatsApp, no Production state.
 */
import { V2_CASES, OTHER_OWNER_PEOPLE, OWNER_NAME, OWNER_PEOPLE } from "./corpus";
import { gradePlan } from "./grade";
import { planFromProposal } from "./plan";
import { SKILL_VERSION, TOOL_NAME, buildSkillRequest } from "./skill";

const CALL_TIMEOUT_MS = 60_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function callOnce(model: string, utterance: string) {
  const body = buildSkillRequest(
    { utterance, ownerName: OWNER_NAME, people: OWNER_PEOPLE.map(({ name, relationship }) => ({ name, relationship })) },
    model,
  );
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const started = performance.now();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      const ms = Math.round(performance.now() - started);
      const json = (await res.json()) as { model?: string; stop_reason?: string; content?: Array<{ type: string; name?: string; input?: unknown }>; error?: { type?: string } };
      // Capacity/rate errors produced no output: retry the SAME model only.
      if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempts < 4) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempts - 1)));
        continue;
      }
      if (!res.ok || json.error) return { ms, attempts, producingModel: undefined, proposal: undefined, error: `HTTP ${res.status} ${json.error?.type ?? ""}`.trim() };
      const block = json.content?.find((b) => b.type === "tool_use" && b.name === TOOL_NAME);
      return { ms, attempts, producingModel: json.model, proposal: block?.input, stop: json.stop_reason, error: block ? null : "no_tool_use" };
    } catch (e) {
      return { ms: Math.round(performance.now() - started), attempts, producingModel: undefined, proposal: undefined, error: (e as Error).name === "TimeoutError" ? "timeout" : "fetch_error" };
    }
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — no evidence was produced.");
    process.exit(2);
  }
  const model = arg("model", "");
  const baseRuns = Math.max(3, Number(arg("runs", "3")) || 3);
  const criticalRuns = Math.max(10, Number(arg("critical-runs", "10")) || 10);
  const concurrency = Math.max(1, Number(arg("concurrency", "4")) || 4);
  const jobs = V2_CASES.flatMap((c) => Array.from({ length: c.critical ? criticalRuns : baseRuns }, (_, k) => ({ c, run: k + 1 })));
  console.log(`SKILL ${SKILL_VERSION} model=${model} cases=${V2_CASES.length} runs=${jobs.length}`);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { c, run } = jobs[next++];
      const call = await callOnce(model, c.u);
      const plan = planFromProposal({
        proposal: call.proposal, utterance: c.u, ownerName: OWNER_NAME, people: OWNER_PEOPLE, otherOwnerPeople: OTHER_OWNER_PEOPLE,
        requestedModel: model, producingModel: call.producingModel,
      });
      const grade = call.error ? null : gradePlan(c, plan);
      console.log(`RESULT ${JSON.stringify({ id: c.id, lang: c.lang, critical: c.critical, run, model, produced: call.producingModel ?? null, ms: call.ms, att: call.attempts, err: call.error, p: call.proposal ?? null, plan, grade })}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log("NOTE: REVIEW results are not cleared until hand review (GATE_SPEC.md).");
}

void main();
