/**
 * EVIDENCE ONLY — Stage-A command line entry. Never run by tests. Run only by
 * the label-gated workflow .github/workflows/v3-stage-a-evidence.yml.
 * To be used only after separate owner authorization of a Stage-A run.
 *
 *   npx --no-install vite-node scripts/second-brain-consequential-v3-evidence/stage-a/cli.ts -- \
 *     --model <candidate> --out <dir> --owner-authorized
 *
 * Reads only OPENAI_EVIDENCE_KEY. Never prints it. This file is an entry
 * point only: nothing imports it, and it runs main() whenever it is executed.
 *
 * Exit codes: 0 only for ZERO_AUTOMATIC_UNSAFE_HAND_REVIEW_REQUIRED;
 * 1 FAIL_UNSAFE; 3 INCOMPLETE; 2 refused or setup error.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenAIEvidenceClient, type EvidenceEnv } from "./openai-evidence-adapter";
import { runStageA } from "./runner";

export async function main(argv: string[], env: EvidenceEnv): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!argv.includes("--owner-authorized")) {
    console.error("stage-a: refusing to run without --owner-authorized");
    return 2;
  }
  const model = arg("--model");
  const out = arg("--out");
  if (!model || !out) {
    console.error("stage-a: --model and --out are required");
    return 2;
  }
  const client = createOpenAIEvidenceClient({ model, env });
  mkdirSync(out, { recursive: true });
  const recordsPath = join(out, "stage-a-records.jsonl");
  writeFileSync(recordsPath, "");
  const summary = await runStageA(client, (r) => appendFileSync(recordsPath, `${JSON.stringify(r)}\n`));
  writeFileSync(join(out, "stage-a-summary.json"), `${JSON.stringify({ requestedModel: model, ...summary }, null, 2)}\n`);
  console.log(JSON.stringify({ requestedModel: model, verdict: summary.verdict, completed: summary.completed, planned: summary.planned, unsafe: summary.unsafe.length }));
  return summary.verdict === "ZERO_AUTOMATIC_UNSAFE_HAND_REVIEW_REQUIRED" ? 0 : summary.verdict === "FAIL_UNSAFE" ? 1 : 3;
}

main(process.argv.slice(2), { OPENAI_EVIDENCE_KEY: process.env.OPENAI_EVIDENCE_KEY }).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`stage-a: ${err instanceof Error ? err.name : "error"}: ${err instanceof Error ? err.message : ""}`);
    process.exit(2);
  },
);
