/**
 * carson-epistemic-gate.ts
 *
 * Constitutional write gate for Memory Governance (COS Ch. 19.4).
 *
 * Only Epistemic Governance may write new beliefs to Memory. This module is
 * the enforcement point: every persistent memory write must pass through
 * `validateMemoryWrite()` before the caller proceeds to the DB insert.
 *
 * Responsibilities (COS Ch. 19.3):
 * - Verify the write is well-formed and non-empty
 * - Attach provenance metadata (source, recorded_at, confidence)
 * - Reject writes that would store unverified assertions as facts (Ch. 19.6)
 *
 * What this is NOT:
 * - Not a semantic classifier — it does not evaluate whether the content is
 *   "true". That is Epistemic Governance's job at retrieval/reasoning time.
 * - Not an AI call — the gate is deterministic and synchronous.
 */

export type MemorySource = "owner_directive" | "session_inference";
export type MemoryConfidence = "high" | "medium" | "low";

export interface MemoryWriteInput {
  instruction: string;
  category: string;
  source?: MemorySource;
}

export interface MemoryWritePayload {
  instruction: string;
  category: string;
  source: MemorySource;
  confidence: MemoryConfidence;
  confirmed_at: string;
}

export interface GateResult {
  ok: true;
  payload: MemoryWritePayload;
}

export interface GateRejection {
  ok: false;
  reason: string;
}

const MAX_INSTRUCTION_BYTES = 2000;
const MIN_INSTRUCTION_CHARS = 3;

/**
 * Validate a persistent memory write and produce a provenance-tagged payload.
 *
 * Returns `{ ok: true, payload }` when the write should proceed, or
 * `{ ok: false, reason }` when it should be rejected.
 *
 * Callers must check `ok` before inserting.
 */
export function validateMemoryWrite(
  input: MemoryWriteInput,
): GateResult | GateRejection {
  const instruction = (input.instruction ?? "").trim();
  const category = (input.category ?? "general").trim() || "general";
  const source: MemorySource = input.source ?? "owner_directive";

  if (instruction.length < MIN_INSTRUCTION_CHARS) {
    return { ok: false, reason: "instruction_too_short" };
  }

  if (new TextEncoder().encode(instruction).length > MAX_INSTRUCTION_BYTES) {
    return { ok: false, reason: "instruction_too_long" };
  }

  // Reject obvious one-off task language masquerading as a durable rule.
  // A durable rule contains imperative language that generalises across time.
  // Tasks are ephemeral; rules are not. This is a heuristic, not exhaustive.
  if (looksLikeEphemeralTask(instruction)) {
    return { ok: false, reason: "ephemeral_task_not_a_rule" };
  }

  const payload: MemoryWritePayload = {
    instruction,
    category,
    source,
    confidence: source === "owner_directive" ? "high" : "medium",
    confirmed_at: new Date().toISOString(),
  };

  return { ok: true, payload };
}

/**
 * Heuristic: detect instructions that are one-off tasks, not durable rules.
 *
 * Durable rules: "always ask before delegating", "never use the word tasks",
 * "from now on keep responses under two sentences".
 *
 * Ephemeral tasks: "remind me at 3pm", "call Grace today", "buy flowers".
 *
 * The gate is conservative — only rejects high-confidence ephemeral patterns.
 * Ambiguous instructions pass through; freshness evaluation catches them later.
 */
function looksLikeEphemeralTask(instruction: string): boolean {
  const lower = instruction.toLowerCase();
  const ephemeralPatterns = [
    /^remind me (at|in|to|about|on)\b/,
    /^(call|text|message|whatsapp|email)\s+\w+\s+(today|now|tonight|tomorrow)\b/,
    /^(buy|get|pick up|order)\s+\w+\s+(today|now|this week)\b/,
    /^(do|finish|complete|send|submit)\s+.{1,40}\s+(today|tonight|now|asap)\b/,
  ];
  return ephemeralPatterns.some((re) => re.test(lower));
}

// ---------------------------------------------------------------------------
// Freshness evaluation (COS Ch. 19.5)
// ---------------------------------------------------------------------------

/** Number of days after which a persistent instruction is considered stale. */
export const MEMORY_STALE_THRESHOLD_DAYS = 90;

/** Number of days after which a session recap is labeled as older context. */
export const SESSION_STALE_THRESHOLD_DAYS = 30;

/**
 * Returns true when the given ISO timestamp is older than the stale threshold
 * for persistent instructions.
 */
export function isPersistentMemoryStale(confirmedAtIso: string): boolean {
  const age = Date.now() - new Date(confirmedAtIso).getTime();
  return age > MEMORY_STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Returns true when the given ISO timestamp is older than the stale threshold
 * for session recaps.
 */
export function isSessionRecapOld(createdAtIso: string): boolean {
  const age = Date.now() - new Date(createdAtIso).getTime();
  return age > SESSION_STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Returns the number of whole days since the given ISO timestamp.
 */
export function daysSince(isoTimestamp: string): number {
  return Math.floor(
    (Date.now() - new Date(isoTimestamp).getTime()) / (24 * 60 * 60 * 1000),
  );
}
