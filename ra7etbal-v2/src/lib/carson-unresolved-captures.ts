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

import { loadUnresolvedNotes, type CarsonNote } from "./carson-notes";
import { listActiveTodosWithSurfaceState, type CarsonTodo } from "./carson-todos";

export interface UnresolvedCapture {
  id: string;
  kind: "note" | "todo";
  /** note text, or todo title (+ description if present) */
  text: string;
  ageDays: number;
  /** last_surfaced_at IS NULL — never included in a rendered attention response before */
  neverSurfaced: boolean;
  /**
   * Action-oriented wording signal. To-dos are always true (the user
   * explicitly categorized it as something to do, not a note). Notes are
   * true only when the text leads with a recognized action verb — see
   * ACTION_LEAD_PATTERN. This is a shallow, bounded heuristic, not
   * semantic understanding — documented, not disguised.
   */
  actionable: boolean;
}

/**
 * Small, explicit, bounded list of leading action verbs. Deliberately not
 * an attempt at semantic classification — matches the same "verb-agnostic
 * but bounded, explicit list" convention already used elsewhere in this
 * codebase (e.g. morning-brief.ts's LABEL_PATTERNS). Case-insensitive,
 * matched only at the start of the trimmed note text.
 */
const ACTION_LEAD_PATTERN =
  /^(check|call|follow[\s-]?up|renew|confirm|book|pay|review|buy|email|text|message|cancel|schedule|arrange|sort out|deal with|sign|send|return|fix|finish|complete|submit|apply|chase|ask|order|reply|respond)\b/i;

function isActionLedText(text: string): boolean {
  return ACTION_LEAD_PATTERN.test(text.trim());
}

function ageInDays(createdAt: string, now: Date): number {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return 0;
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
}

function noteToCapture(note: CarsonNote, now: Date): UnresolvedCapture {
  return {
    id: note.id,
    kind: "note",
    text: note.note,
    ageDays: ageInDays(note.created_at, now),
    neverSurfaced: !note.last_surfaced_at,
    actionable: isActionLedText(note.note),
  };
}

function todoToCapture(todo: CarsonTodo, now: Date): UnresolvedCapture {
  const text = todo.description ? `${todo.title} — ${todo.description}` : todo.title;
  return {
    id: todo.id,
    kind: "todo",
    text,
    ageDays: ageInDays(todo.created_at, now),
    neverSurfaced: !todo.last_surfaced_at,
    // A to-do is, by the user's own explicit categorization, something to
    // do — no wording heuristic needed or applied.
    actionable: true,
  };
}

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

/**
 * CLASSIFICATION — pure, deterministic, and the only place that decides
 * which unresolved captures are worth mentioning right now. Bounded output
 * (default 3) so a large backlog of old notes/todos can never flood a
 * single attention response — noise control is a hard requirement, not a
 * nice-to-have.
 *
 * Included only when: actionable AND neverSurfaced. Age is used only to
 * order among already-eligible candidates (oldest first) — never to
 * include or exclude one on its own, per the locked product correction
 * that age must not become the definition of relevance.
 *
 * Notes that don't match the action-wording heuristic (e.g. "Restaurant I
 * liked in Paris") are retrieved (Carson "knows" they exist — they remain
 * queryable via act_on_note's keyword lookup) but are deliberately not
 * included in this bounded, spoken-aloud list in Phase 1.
 */
export function classifyAttentionWorthyCaptures(
  candidates: UnresolvedCapture[],
  maxItems = 3,
): UnresolvedCapture[] {
  return candidates
    .filter((c) => c.actionable && c.neverSurfaced)
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, maxItems);
}
