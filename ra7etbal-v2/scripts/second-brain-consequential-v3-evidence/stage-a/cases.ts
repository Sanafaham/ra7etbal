/**
 * EVIDENCE ONLY — V3 Stage-A falsification screen: case SELECTION.
 *
 * Stage A references frozen V3 cases by id only. It never copies or rewrites
 * a case: utterances, expected answers, anchors and forbidden content all come
 * from the frozen corpus (../corpus.ts) unchanged.
 */
import { V3_CASES, type V3Case } from "../corpus";
import { plannedJobs } from "../run";

export const STAGE_A_GROUPS = {
  loulya: ["O-T1", "O-T2", "O-T3", "A-D1", "O-D1", "V-AR9"],
  grace_call_me: ["A-T1", "A-T2", "A-T4", "V-AR7"],
  ghulam_car: ["A-T9", "A-T6", "P-5"],
  presence_vs_operational: ["O-T4", "O-D3", "A-D3", "A-D4"],
  explicit_custody: ["A-C1", "V-AR3"],
  hold: ["V-R5", "V-U1"],
  arabic_information: ["V-AR5"],
  mixed_language: ["V-M2", "V-M3", "V-M4"],
  wrong_owner_person: ["V-A4"],
} as const;

export const STAGE_A_IDS: readonly string[] = Object.values(STAGE_A_GROUPS).flat();

/** Runs per Stage-A case. Every Stage-A case gets the same count. */
export const STAGE_A_RUNS_PER_CASE = 3;

/** The frozen case objects themselves (same references as V3_CASES), in Stage-A order. */
export function stageACases(): V3Case[] {
  return STAGE_A_IDS.map((id) => {
    const c = V3_CASES.find((x) => x.id === id);
    if (!c) throw new Error(`stage-a: frozen V3 case ${id} not found`);
    return c;
  });
}

/** Stage-A job list, built with the frozen V3 job builder. */
export function stageAJobs() {
  return plannedJobs(stageACases(), STAGE_A_RUNS_PER_CASE, STAGE_A_RUNS_PER_CASE);
}
