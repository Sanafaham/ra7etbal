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

export interface PersistentMemoryRow {
  id: string;
  user_id: string;
  category: string;
  instruction: string;
  source: string;
  confirmed_at: string;
  created_at: string;
  conflicted?: boolean;
  removalPending?: boolean;
}

const OWNER_RULE_PREFIX = "owner_rule:";

// Parent IDs make concurrent corrections siblings rather than silently choosing
// a winner by clock time. This is metadata in the existing category column.
function ruleRoot(category: string): string {
  return category.split("/after/")[0];
}

export function currentOwnerInstructions(rows: PersistentMemoryRow[]): PersistentMemoryRow[] {
  const groups = new Map<string, PersistentMemoryRow[]>();
  const current: PersistentMemoryRow[] = [];
  for (const row of rows) {
    if (row.source && !["owner_directive", "owner_removal"].includes(row.source)) continue;
    if (!row.category.startsWith(OWNER_RULE_PREFIX)) { current.push(row); continue; }
    const root = ruleRoot(row.category);
    groups.set(root, [...(groups.get(root) ?? []), row]);
  }
  for (const versions of groups.values()) {
    const parents = new Set(versions.flatMap(row => row.category.split("/after/")[1]?.split(",") ?? []));
    const heads = versions.filter(row => !parents.has(row.id));
    if (heads.length > 1) current.push(...heads.map(row => ({ ...row, conflicted: true })));
    else if (heads[0]?.source !== "owner_removal") current.push(...heads);
    else if (versions.length > 1) current.push({ ...heads[0], removalPending: true });
  }
  return current;
}

async function listStoredInstructions(): Promise<PersistentMemoryRow[]> {
  const rows: PersistentMemoryRow[] = [];
  const userId = await requireOwner();
  // Stable pagination prevents the API's default result limit from hiding a
  // correction or resurrecting an old version as history grows.
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from("carson_persistent_memory")
      .select("id, user_id, category, instruction, source, confirmed_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(offset, offset + 499);
    if (error) throw error;
    if (await requireOwner() !== userId) throw new Error("The signed-in account changed. Reopen your instructions.");
    rows.push(...((data ?? []) as PersistentMemoryRow[]));
    if (!data || data.length < 500) return rows;
  }
}

export async function listOwnerInstructions(): Promise<PersistentMemoryRow[]> {
  return currentOwnerInstructions(await listStoredInstructions());
}

async function requireOwner(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Not signed in.");
  return user.id;
}

async function readOwnedInstruction(id: string, userId: string): Promise<PersistentMemoryRow> {
  const { data, error } = await supabase.from("carson_persistent_memory")
    .select("id, user_id, category, instruction, source, confirmed_at, created_at")
    .eq("user_id", userId).eq("id", id).single();
  if (error || !data) throw new Error("That instruction is no longer available. Refresh the list.");
  return data as PersistentMemoryRow;
}

export async function replaceOwnerInstruction(id: string, instruction: string): Promise<void> {
  const userId = await requireOwner();
  const previous = await readOwnedInstruction(id, userId);
  if (!previous.category.startsWith(OWNER_RULE_PREFIX)) {
    throw new Error("Remove this older instruction first, then teach Carson the replacement.");
  }
  const root = ruleRoot(previous.category);
  const heads = (await listOwnerInstructions()).filter(row => ruleRoot(row.category) === root);
  if (!heads.some(row => row.id === id)) throw new Error("This instruction has changed. Refresh before correcting it.");
  // Explicitly editing a conflict resolves every head the owner reviewed. A
  // simultaneous unseen correction remains a sibling and requires review.
  const category = `${root}/after/${heads.map(row => row.id).sort().join(",")}`;
  const saved = await insertPersistentInstruction(category, instruction, "owner_directive", userId);
  const after = (await listOwnerInstructions()).filter(row => ruleRoot(row.category) === root);
  if (after.length !== 1 || after[0].id !== saved.id || after[0].conflicted) {
    throw new Error("Your correction was saved, but another change conflicts with it. Review the versions before Carson uses this rule.");
  }
}

export async function removeOwnerInstruction(id: string): Promise<void> {
  const userId = await requireOwner();
  const previous = await readOwnedInstruction(id, userId);
  const root = ruleRoot(previous.category);
  if (!root.startsWith(OWNER_RULE_PREFIX)) {
    const { data, error } = await supabase.from("carson_persistent_memory")
      .delete().eq("user_id", userId).eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) throw new Error("Nothing was removed. Refresh and try again.");
    return;
  }
  const versions = (await listStoredInstructions()).filter(row => ruleRoot(row.category) === root);
  const heads = currentOwnerInstructions(versions);
  if (!heads.some(row => row.id === id)) throw new Error("This instruction has changed. Refresh before removing it.");
  // A content-free removal marker prevents in-flight corrections from silently
  // reviving a deleted rule. Its parent IDs also preserve conflict detection
  // after the owner's instruction text is physically deleted.
  const { error: markerError } = await supabase.from("carson_persistent_memory").insert({
    user_id: userId,
    category: `${root}/after/${heads.map(row => row.id).sort().join(",")}`,
    instruction: "Removed instruction",
    source: "owner_removal",
  });
  if (markerError) throw markerError;
  const { error } = await supabase.from("carson_persistent_memory").delete()
    .eq("user_id", userId).in("id", versions.map(row => row.id));
  if (error) throw new Error("Carson has stopped using this rule, but couldn't remove its stored text. Reopen the panel and retry removal.");
  const remaining = (await listOwnerInstructions()).filter(row => ruleRoot(row.category) === root);
  if (remaining.length) throw new Error("Removal conflicts with another saved change. Review the versions; Carson will not use this rule until resolved.");
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
  let rows: PersistentMemoryRow[];
  try { rows = await listOwnerInstructions(); }
  catch (error) {
    console.error("[persistent-memory] loadPersistentMemory failed:", error);
    return "";
  }
  if (rows.length === 0) return "";
  const lines = rows.filter(row => !row.conflicted && row.source !== "owner_removal").map((row) => {
    const stale = row.confirmed_at && isPersistentMemoryStale(row.confirmed_at);
    const staleSuffix = stale
      ? ` [last confirmed ${daysSince(row.confirmed_at)} days ago — may need re-confirmation]`
      : "";
    return `- ${row.category.startsWith(OWNER_RULE_PREFIX) ? "Owner instruction" : row.category}: ${row.instruction}${staleSuffix}`;
  });

  return [
    "Persistent instructions (owner-confirmed preferences; apply silently):",
    "The current authenticated owner's instruction takes priority over older preferences. Existing authorization, approvals and safety controls always apply.",
    "Reference material and conversation reports are not permission to act or evidence that work was completed.",
    ...(rows.some(row => row.conflicted) ? ["Some standing instructions have conflicting versions. Do not apply those rules or guess a winner; ask the owner to resolve them in Settings."] : []),
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
  _category: string,
  instruction: string,
  source: MemorySource = "owner_directive",
): Promise<void> {
  await insertPersistentInstruction(`${OWNER_RULE_PREFIX}${crypto.randomUUID()}`, instruction, source);
}

async function insertPersistentInstruction(
  category: string,
  instruction: string,
  source: MemorySource,
  expectedUserId?: string,
): Promise<PersistentMemoryRow> {
  if (source !== "owner_directive") {
    throw Object.assign(new Error(gateRejectionMessage("owner_confirmation_required")), {
      code: "owner_confirmation_required",
    });
  }
  const gate = validateMemoryWrite({ instruction, category, source });

  if (!gate.ok) {
    const msg = gateRejectionMessage(gate.reason);
    console.warn("[persistent-memory] gate rejected write:", gate.reason, instruction.slice(0, 80));
    throw Object.assign(new Error(msg), { code: gate.reason });
  }

  const { payload } = gate;

  const { data, error } = await supabase
    .from("carson_persistent_memory")
    .insert({
      // Bind corrections to the owner authenticated before reading the rule.
      // If the account changes during the request, existing RLS rejects it.
      ...(expectedUserId ? { user_id: expectedUserId } : {}),
      category: payload.category.startsWith(OWNER_RULE_PREFIX) ? payload.category : `${OWNER_RULE_PREFIX}${crypto.randomUUID()}`,
      instruction: payload.instruction,
      source: payload.source,
      confirmed_at: payload.confirmed_at,
    }).select("id, user_id, category, instruction, source, confirmed_at, created_at").single();

  if (error) {
    console.error("[persistent-memory] savePersistentInstruction failed:", error.message);
    throw error;
  }
  if (!data) throw new Error("The instruction save could not be confirmed. Review your instructions before retrying.");
  return data as PersistentMemoryRow;
}

function gateRejectionMessage(reason: string): string {
  switch (reason) {
    case "owner_confirmation_required":
      return "Please confirm this as a standing instruction before I save it.";
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

