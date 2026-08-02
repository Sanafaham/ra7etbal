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
  isPersistentMemoryStale,
  daysSince,
  type MemorySource,
} from "./carson-epistemic-gate";

interface PersistentMemoryRow {
  category: string;
  instruction: string;
  confirmed_at: string;
}

/**
 * Load all persistent instructions for the signed-in user, formatted as a
 * ready-to-inject string for the `persistent_instructions` dynamic variable.
 *
 * Freshness evaluation (COS Ch. 19.5): instructions older than 90 days are
 * labeled as potentially stale so Epistemic Governance can flag them for
 * re-confirmation rather than blindly using them.
 *
 * Returns an empty string when there are no instructions or on error —
 * the dynamic variable always has a safe value.
 */
export async function loadPersistentMemory(): Promise<string> {
  const { data, error } = await supabase
    .from("carson_persistent_memory")
    .select("category, instruction, confirmed_at")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[persistent-memory] loadPersistentMemory failed:", error.message);
    return "";
  }

  if (!data || data.length === 0) return "";

  const rows = data as PersistentMemoryRow[];
  const lines = rows.map((row) => {
    const stale = row.confirmed_at && isPersistentMemoryStale(row.confirmed_at);
    const staleSuffix = stale
      ? ` [last confirmed ${daysSince(row.confirmed_at)} days ago — may need re-confirmation]`
      : "";
    return `- ${row.category}: ${row.instruction}${staleSuffix}`;
  });

  return [
    "Persistent instructions (follow these always, silently, without announcing them):",
    ...lines,
  ].join("\n");
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
