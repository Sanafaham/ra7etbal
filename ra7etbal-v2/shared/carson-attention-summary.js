/**
 * Server/browser-safe attention-evidence composition and rendering.
 *
 * PURE RELOCATION from src/lib/carson-operations-center.ts (2026-08-28,
 * Second Brain typed hard-grounding slice) — no behavior change.
 *
 * composeAttentionEvidence() is the one shared place that turns already-
 * classified task buckets (from buildMorningBrief — see
 * carson-morning-brief-classifier.js), staff escalations, and unresolved
 * capture candidates into the final AttentionSummaryEvidence shape. Both
 * the browser (carson-operations-center.ts) and the server attention-read
 * path call this SAME function after doing their own (necessarily
 * different) I/O — this is what keeps the actual business rules single-
 * sourced. renderAttentionSummary() is a pure string builder with no LLM
 * step — it can never state an item that isn't present in the evidence it
 * was given.
 */

import { taskLabel } from "./carson-morning-brief-classifier.js";
import { classifyAttentionWorthyCaptures } from "./carson-unresolved-captures-classifier.js";

/**
 * Pure composition — takes buildMorningBrief()'s already-classified task
 * buckets plus the other two sources' raw results, and produces the exact
 * same AttentionSummaryEvidence shape carson-operations-center.ts's
 * fetchAttentionEvidence() produced inline before this extraction.
 */
export function composeAttentionEvidence({
  generatedAt,
  brief,
  tasksFailed,
  needsYou,
  needsYouFailed,
  captureCandidates,
  capturesFailed,
}) {
  const empty = {
    needsAttention: [],
    waiting: [],
    carsonCanHandle: [],
    safeToIgnore: [],
    unresolvedCaptures: [],
  };

  if (tasksFailed && needsYouFailed && capturesFailed) {
    return { ok: false, code: "attention_read_failed", generatedAt, completeness: "none", ...empty };
  }

  const needsAttention = [];
  const waiting = [];
  const unresolvedCaptures = [];

  if (brief) {
    for (const t of brief.overdueItems) {
      needsAttention.push({ id: t.id, label: taskLabel(t.description, t.assigned_to), reason: "overdue" });
    }
    for (const t of brief.needsAttention) {
      needsAttention.push({
        id: t.id,
        label: taskLabel(t.description, t.assigned_to),
        reason: t.type === "reminder" ? "reminder due today" : "owner task",
      });
    }
    for (const t of brief.waitingOn) {
      waiting.push({
        id: t.id,
        label: taskLabel(t.description, t.assigned_to),
        reason: t.escalated_at ? "escalated — needs your attention" : "awaiting confirmation",
      });
    }
  }

  if (needsYou) {
    for (const e of needsYou) {
      waiting.push({
        id: e.id,
        label: `${e.staffName}: ${e.escalationReason ?? "needs your decision"}`,
        reason: "needs your decision",
      });
    }
  }

  let selectedCaptures = [];
  if (captureCandidates) {
    selectedCaptures = classifyAttentionWorthyCaptures(captureCandidates);
    for (const c of selectedCaptures) {
      unresolvedCaptures.push({
        id: c.id,
        label: c.text,
        reason: c.kind === "todo" ? "on your to-do list" : "a note you made",
      });
    }
  }

  const completeness = tasksFailed || needsYouFailed || capturesFailed ? "partial" : "full";

  return {
    ok: true,
    code: completeness === "partial" ? "attention_read_partial" : "attention_read_succeeded",
    generatedAt,
    completeness,
    needsAttention,
    waiting,
    carsonCanHandle: [],
    safeToIgnore: [],
    unresolvedCaptures,
    // Exposed so a caller can persist last_surfaced_at for exactly the
    // capture ids actually rendered — same "only mark what was truly
    // surfaced" contract as before this extraction.
    selectedCaptureIds: selectedCaptures.map((c) => ({ id: c.id, kind: c.kind })),
  };
}

export function renderAttentionSummary(evidence) {
  if (!evidence.ok) {
    if (evidence.code === "attention_auth_failed") {
      return "I couldn't check what needs your attention right now — not signed in.";
    }
    return "I couldn't check what needs your attention right now — the live check didn't complete.";
  }

  const partialNote =
    evidence.completeness === "partial"
      ? "I couldn't check everything just now, so this may be incomplete."
      : "";

  if (
    evidence.needsAttention.length === 0 &&
    evidence.waiting.length === 0 &&
    evidence.unresolvedCaptures.length === 0
  ) {
    return partialNote
      ? `Nothing needs your attention based on what I could check. ${partialNote}`
      : "Nothing needs your attention right now.";
  }

  const lines = [];
  if (evidence.needsAttention.length > 0) {
    lines.push(`Needs your attention: ${evidence.needsAttention.map((i) => i.label).join("; ")}.`);
  }
  if (evidence.waiting.length > 0) {
    lines.push(`Waiting: ${evidence.waiting.map((i) => `${i.label} (${i.reason})`).join("; ")}.`);
  }
  if (evidence.unresolvedCaptures.length > 0) {
    lines.push(
      `Also on your mind: ${evidence.unresolvedCaptures.map((i) => `${i.label} (${i.reason})`).join("; ")}.`,
    );
  }
  if (partialNote) lines.push(partialNote);

  return lines.join(" ");
}

// ── renderAttentionDecision — Second Brain stateful reasoning slice (2026-08-28) ──

/**
 * Deterministic renderer for a VALIDATED reasoning decision (see
 * api/_carson-attention-reasoning.js's validateAttentionDecision). This is
 * additive — renderAttentionSummary above is completely unchanged and
 * remains the base-case/fallback renderer. The model never supplies the
 * final text; it only selects/ranks/classifies which already-known
 * evidence (label/reason) to include, and this function is the only place
 * that turns that selection into a sentence. Callers must validate the
 * decision against the authorized evidence set BEFORE calling this — it
 * does not re-validate ids itself (that would duplicate the security
 * boundary in two places).
 */
function findEvidenceItem(evidence, id) {
  const all = [
    ...(evidence.needsAttention ?? []),
    ...(evidence.waiting ?? []),
    ...(evidence.unresolvedCaptures ?? []),
  ];
  return all.find((item) => item.id === id) ?? null;
}

export function renderAttentionDecision(evidence, decision) {
  const { responseIntent, selectedEvidenceIds, rankedEvidenceIds, needsClarification } = decision;

  if (responseIntent === "nothing_new") {
    return "Nothing else needs your attention beyond what I already mentioned.";
  }

  if (responseIntent === "clarify") {
    return needsClarification
      ? needsClarification.slice(0, 200)
      : "Could you clarify what you'd like to know?";
  }

  const orderedIds =
    Array.isArray(rankedEvidenceIds) && rankedEvidenceIds.length > 0 ? rankedEvidenceIds : selectedEvidenceIds;
  const items = orderedIds.map((id) => findEvidenceItem(evidence, id)).filter(Boolean);

  if (items.length === 0) {
    return "Nothing matches that right now.";
  }

  if (responseIntent === "explain" && items.length === 1) {
    return `${items[0].label} needs your attention because it's ${items[0].reason}.`;
  }

  if (responseIntent === "prioritize" && Array.isArray(rankedEvidenceIds) && rankedEvidenceIds.length > 0) {
    return `In order: ${items.map((item) => item.label).join("; then ")}.`;
  }

  // list / filter_urgent / explain-with-multiple-items default.
  return `${items.map((item) => `${item.label} (${item.reason})`).join("; ")}.`;
}
