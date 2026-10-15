/**
 * EVIDENCE ONLY — future V3 model-gate runner STRUCTURE. It contains no
 * provider code and makes no network calls. A provider adapter implementing
 * `ModelClient` is added only after a separate owner provider/model decision
 * and gate authorization. Nothing in this file is invoked by tests or CI.
 */
import { OTHER_OWNER_PEOPLE, OWNER_NAME, OWNER_PEOPLE, V3_CASES, type V3Case } from "./corpus";
import { gradeRun, type Grade } from "./grade";
import { planFromExtraction, validateShape, type Plan } from "./plan";
import { buildSkillRequest } from "./skill";

export interface ModelClient {
  /** The single named model this client calls. No fallback model. */
  readonly requestedModel: string;
  extract(request: ReturnType<typeof buildSkillRequest>): Promise<{ producingModel?: string; extraction?: unknown; error?: string; ms: number }>;
}

export interface RunRecord {
  id: string;
  lang: V3Case["lang"];
  critical: boolean;
  run: number;
  requestedModel: string;
  producingModel: string | null;
  ms: number;
  error: string | null;
  extraction: unknown;
  plan: Plan | null;
  grade: Grade;
}

/** Frozen matrix: 3 runs per case, 10 per C-02-critical case. */
export function plannedJobs(cases: readonly V3Case[] = V3_CASES, baseRuns = 3, criticalRuns = 10) {
  return cases.flatMap((c) => Array.from({ length: c.critical ? criticalRuns : baseRuns }, (_, k) => ({ c, run: k + 1 })));
}

export async function runGate(client: ModelClient, candidateModels: readonly string[], onRecord: (r: RunRecord) => void, concurrency = 4): Promise<void> {
  const jobs = plannedJobs();
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { c, run } = jobs[next++];
      const request = buildSkillRequest({ utterance: c.u, people: OWNER_PEOPLE.map(({ name, relationship }) => ({ name, relationship })) });
      const res = await client.extract(request);
      const plan = res.error
        ? null
        : planFromExtraction({
            extraction: res.extraction, utterance: c.u, ownerName: OWNER_NAME, people: OWNER_PEOPLE, otherOwnerPeople: OTHER_OWNER_PEOPLE,
            requestedModel: client.requestedModel, producingModel: res.producingModel, candidateModels,
          });
      const { extraction } = validateShape(res.extraction);
      onRecord({
        id: c.id, lang: c.lang, critical: c.critical, run, requestedModel: client.requestedModel, producingModel: res.producingModel ?? null,
        ms: res.ms, error: res.error ?? null, extraction: res.extraction ?? null, plan, grade: gradeRun(c, plan, extraction, res.error ?? null),
      });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}
