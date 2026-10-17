/**
 * carson-persistent-memory.ts
 *
 * Stores and retrieves explicit behavioral instructions the user has asked
 * Carson to follow permanently across all sessions.
 *
 * Distinct from carson_facts (inferred key/value data) and carson_memory
 * (session summaries). These rows are user-triggered imperatives:
 *   "always ask before delegating"
 *   "never use the word tasks"
 *   "from now on, keep responses under two sentences"
 *
 * Schema:
 *   carson_persistent_memory (id, user_id, category, instruction,
 *     source, confirmed_at, created_at, updated_at)
 *   — source and confirmed_at added in migration 20260801_memory_governance_phase_1a.sql
 *   RLS: authenticated users select / insert / delete their own rows only
 *
 * Constitutional basis: COS Ch. 19.4 — writes route through the Epistemic Gate.
 * COS Ch. 19.5 — freshness is evaluated before memory is used for reasoning.
 */

import { supabase } from "./supabase";
import {
  validateMemoryWrite,
  MEMORY_STALE_THRESHOLD_DAYS,
  type MemorySource,
} from "./carson-epistemic-gate";
import { loadActiveFactRows } from "./carson-facts";
import {
  buildCarsonMemoryContext,
  type InstructionRow,
} from "../../shared/carson-memory-selection.js";

/** Columns every persistent-memory reader needs for correction resolution. */
export const PERSISTENT_MEMORY_COLUMNS = "id, category, instruction, source, confirmed_at, created_at";

/**
 * Raw persistent-instruction rows for the signed-in user (RLS-scoped),
 * oldest first. Throws on a database error so callers can tell "no
 * instructions" apart from "could not load".
 */
export async function loadPersistentInstructionRows(): Promise<InstructionRow[]> {
  const { data, error } = await supabase
    .from("carson_persistent_memory")
    .select(PERSISTENT_MEMORY_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as InstructionRow[];
}

/**
 * Load the CURRENT persistent instructions for the signed-in user, formatted
 * as a ready-to-inject string for the `persistent_instructions` variable.
 *
 * Corrections: when the owner restates an instruction about the same
 * subject with a new value ("before 4 PM" → "before 3 PM"), only the newer
 * one is returned. Older versions stay stored (no destructive delete) but are
 * never handed to Carson as guidance. See shared/carson-memory-selection.js.
 *
 * Freshness evaluation (COS Ch. 19.5): instructions older than 90 days are
 * labeled as potentially stale so Epistemic Governance can flag them for
 * re-confirmation rather than blindly using them.
 *
 * Returns an empty string when there are no instructions or on error —
 * the dynamic variable always has a safe value.
 */
export async function loadPersistentMemory(): Promise<string> {
  // Facts are read too so an instruction the owner later corrected in
  // conversation is not handed back here (same rule as session start).
  const [rowsResult, factsResult] = await Promise.allSettled([
    loadPersistentInstructionRows(),
    loadActiveFactRows(),
  ]);
  if (rowsResult.status === "rejected") {
    const error = rowsResult.reason;
    console.error(
      "[persistent-memory] loadPersistentMemory failed:",
      error instanceof Error ? error.message : (error as { message?: string })?.message ?? error,
    );
    return "";
  }
  if (rowsResult.value.length === 0) return "";
  return buildCarsonMemoryContext({
    instructions: rowsResult.value,
    facts: factsResult.status === "fulfilled" ? factsResult.value : [],
    staleDays: MEMORY_STALE_THRESHOLD_DAYS,
  }).persistentInstructions;
}

/**
 * Save a persistent behavioral instruction for the signed-in user.
 *
 * Routes through the Epistemic Gate (COS Ch. 19.4) before writing.
 * Throws a typed error on gate rejection or DB failure so the caller
 * can surface a meaningful message to the user.
 */
export async function savePersistentInstruction(
  category: string,
  instruction: string,
  source: MemorySource = "owner_directive",
): Promise<void> {
  const gate = validateMemoryWrite({ instruction, category, source });

  if (!gate.ok) {
    const msg = gateRejectionMessage(gate.reason);
    console.warn("[persistent-memory] gate rejected write:", gate.reason, instruction.slice(0, 80));
    throw Object.assign(new Error(msg), { code: gate.reason });
  }

  const { payload } = gate;

  const { error } = await supabase
    .from("carson_persistent_memory")
    .insert({
      category: payload.category,
      instruction: payload.instruction,
      source: payload.source,
      confirmed_at: payload.confirmed_at,
    });

  if (error) {
    console.error("[persistent-memory] savePersistentInstruction failed:", error.message);
    throw error;
  }
}

function gateRejectionMessage(reason: string): string {
  switch (reason) {
    case "instruction_too_short":
      return "That instruction is too short to save. Please say the full rule.";
    case "instruction_too_long":
      return "That instruction is too long to save. Please shorten it.";
    case "ephemeral_task_not_a_rule":
      return "That sounds like a one-time task, not a standing rule. Use a reminder or delegation instead.";
    default:
      return "That instruction couldn't be saved.";
  }
}
