/**
 * carson-unresolved-captures.ts
 *
 * Second Brain Phase 1 — grounded retrieval of Notes and To-dos the owner
 * has genuinely entrusted to Ra7etBal but that Carson has never brought
 * back into operational awareness, plus deterministic classification of
 * which of those are worth mentioning in an attention response right now.
 *
 * RETRIEVAL vs CLASSIFICATION are deliberately two separate functions, per
 * the locked product decision: Carson should KNOW about everything the
 * user entrusted to the app (retrieval), but that knowledge must not
 * become an interruption merely because it exists (classification). Age
 * alone is never the definition of relevance here — it is one input signal,
 * mirroring the existing precedent in morning-brief.ts's
 * isMaterialWaitingItem() (explicit signals, not elapsed time).
 *
 * Deterministic signals used, and only these — nothing invented:
 *   - record type (note vs to-do)
 *   - lifecycle state (carson_notes.dismissed_at / carson_todos.status)
 *   - age since created_at
 *   - whether already surfaced before (last_surfaced_at)
 *   - action-oriented wording (a small, explicit, bounded verb-lead
 *     heuristic — see ACTION_LEAD_PATTERN below)
 *
 * What this does NOT attempt: true semantic understanding of whether a
 * note is "reference" vs "actionable" beyond the shallow wording heuristic.
 * That would require either an LLM classification pass or a materially
 * larger architecture — explicitly out of scope for Phase 1 per product
 * decision; flagged as a known limitation, not silently approximated.
 */

import { loadUnresolvedNotes } from "./carson-notes";
import { listActiveTodosWithSurfaceState } from "./carson-todos";
// PURE RELOCATION (2026-08-28, Second Brain typed hard-grounding slice):
// classification logic moved to shared/ so the server-side attention read
// path can reuse the exact same rules. Only the Supabase retrieval below
// stays browser-only. Re-exported so every existing caller's import path
// (`./carson-unresolved-captures`) and behavior are unchanged.
import {
  noteToCapture,
  todoToCapture,
  classifyAttentionWorthyCaptures,
  type UnresolvedCapture,
} from "../../shared/carson-unresolved-captures-classifier.js";
export { classifyAttentionWorthyCaptures };
export type { UnresolvedCapture };

/**
 * RETRIEVAL — every unresolved note and active to-do the owner has, mapped
 * to a common shape with the deterministic signals above computed. Does NOT
 * decide what's worth mentioning; that's classifyAttentionWorthyCaptures().
 * Bounded to 50 of each at the query layer (loadUnresolvedNotes/
 * listActiveTodosWithSurfaceState defaults) so this can never grow
 * unbounded into the caller's context.
 */
export async function fetchUnresolvedCaptureCandidates(now = new Date()): Promise<UnresolvedCapture[]> {
  const [notes, todos] = await Promise.all([
    loadUnresolvedNotes(),
    listActiveTodosWithSurfaceState(),
  ]);
  return [
    ...notes.map((n) => noteToCapture(n, now)),
    ...todos.map((t) => todoToCapture(t, now)),
  ];
}

// classifyAttentionWorthyCaptures: see
// shared/carson-unresolved-captures-classifier.js — imported and
// re-exported above, pure relocation, no behavior change.
