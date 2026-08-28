/**
 * Server/browser-safe classification of unresolved Notes/To-dos worth
 * mentioning in an attention response.
 *
 * PURE RELOCATION from src/lib/carson-unresolved-captures.ts (2026-08-28,
 * Second Brain typed hard-grounding slice) — no behavior change. Only the
 * pure, I/O-free construction/classification logic moved here; the actual
 * Supabase retrieval (loadUnresolvedNotes / listActiveTodosWithSurfaceState)
 * stays browser-only in carson-unresolved-captures.ts, which now re-exports
 * these from here.
 */

// Small, explicit, bounded list of leading action verbs — not semantic
// classification. See original file's header comment for full rationale.
const ACTION_LEAD_PATTERN =
  /^(check|call|follow[\s-]?up|renew|confirm|book|pay|review|buy|email|text|message|cancel|schedule|arrange|sort out|deal with|sign|send|return|fix|finish|complete|submit|apply|chase|ask|order|reply|respond)\b/i;

export function isActionLedText(text) {
  return ACTION_LEAD_PATTERN.test(text.trim());
}

export function ageInDays(createdAt, now) {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return 0;
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
}

export function noteToCapture(note, now) {
  return {
    id: note.id,
    kind: "note",
    text: note.note,
    ageDays: ageInDays(note.created_at, now),
    neverSurfaced: !note.last_surfaced_at,
    actionable: isActionLedText(note.note),
  };
}

export function todoToCapture(todo, now) {
  const text = todo.description ? `${todo.title} — ${todo.description}` : todo.title;
  return {
    id: todo.id,
    kind: "todo",
    text,
    ageDays: ageInDays(todo.created_at, now),
    neverSurfaced: !todo.last_surfaced_at,
    actionable: true,
  };
}

/**
 * CLASSIFICATION — pure, deterministic. See original file's header comment
 * for the full product-decision rationale (age is a tie-break, never the
 * definition of relevance).
 */
export function classifyAttentionWorthyCaptures(candidates, maxItems = 3) {
  return candidates
    .filter((c) => c.actionable && c.neverSurfaced)
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, maxItems);
}
