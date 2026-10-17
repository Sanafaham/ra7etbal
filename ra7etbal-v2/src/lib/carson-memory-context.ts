/**
 * carson-memory-context.ts
 *
 * One loader for the memory Talk to Carson and Type to Carson receive at the
 * start of a session (`ra7etbal_state` user-memory block and
 * `persistent_instructions`). WhatsApp Carson builds the same blocks from the
 * same shared builder (api/_carson-agent-turn.js), so a memory taught on one
 * channel is used the same way on the others.
 *
 * Reads are RLS-scoped to the signed-in owner. Each store fails independently:
 * if facts cannot be loaded, standing instructions still load, and vice versa.
 */

import { MEMORY_STALE_THRESHOLD_DAYS } from "./carson-epistemic-gate";
import { loadActiveFactRows } from "./carson-facts";
import { loadPersistentInstructionRows } from "./carson-persistent-memory";
import {
  buildCarsonMemoryContext,
  type CarsonMemoryContext,
  type FactRow,
  type InstructionRow,
  type MemoryPersonRow,
} from "../../shared/carson-memory-selection.js";

export interface LoadCarsonMemoryContextInput {
  /** Current conversation/state text used to rank relevant facts. */
  contextText?: string;
  /** Household people (names) so person-specific memories can be matched. */
  people?: MemoryPersonRow[];
  factLimit?: number;
}

export interface LoadedCarsonMemoryContext extends CarsonMemoryContext {
  factsLoaded: boolean;
  instructionsLoaded: boolean;
}

export async function loadCarsonMemoryContext(
  input: LoadCarsonMemoryContextInput = {},
): Promise<LoadedCarsonMemoryContext> {
  const [instructionsResult, factsResult] = await Promise.allSettled([
    loadPersistentInstructionRows(),
    loadActiveFactRows(),
  ]);

  const instructions: InstructionRow[] =
    instructionsResult.status === "fulfilled" ? instructionsResult.value : [];
  const facts: FactRow[] = factsResult.status === "fulfilled" ? factsResult.value : [];
  if (instructionsResult.status === "rejected") {
    console.error("[carson-memory-context] instructions failed to load:", describe(instructionsResult.reason));
  }
  if (factsResult.status === "rejected") {
    console.error("[carson-memory-context] facts failed to load:", describe(factsResult.reason));
  }

  const context = buildCarsonMemoryContext({
    instructions,
    facts,
    people: input.people,
    contextText: input.contextText,
    factLimit: input.factLimit,
    staleDays: MEMORY_STALE_THRESHOLD_DAYS,
  });

  return {
    ...context,
    instructionsLoaded: instructionsResult.status === "fulfilled",
    factsLoaded: factsResult.status === "fulfilled",
  };
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  const message = (reason as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(reason);
}
