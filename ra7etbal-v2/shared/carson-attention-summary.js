/**
 * Server/browser-safe structured operational evidence composition and
 * rendering.
 *
 * 2026-08-28 — Structured Second Brain operational evidence (replaces the
 * prior flat needsAttention/waiting shape). Root cause of the prior shape:
 * a flat "needsAttention" bucket pre-filtered away everything except
 * already-urgent items (overdue + due-today reminders), leaving the
 * reasoning model with no genuine "can wait" candidates to contrast
 * against — see the read-only investigation this session for full
 * evidence. composeAttentionEvidence() now exposes Ra7etBal's actual
 * canonical operational categories, reusing existing production
 * classifiers exactly (never redefining their membership):
 *
 *   - needsYou            — daily-brief.ts's isNeedsYouTask (via the
 *                            shared duplicate, see carson-daily-brief-
 *                            classifier.js) — the SAME "Needs You" the
 *                            Home/Updates UI shows. Canonical, narrow.
 *   - overdueReminders     — buildMorningBrief()'s overdueItems.
 *   - upcomingReminders    — the same getUpcomingReminderTasks() window
 *                            Updates' own "Upcoming reminders" uses
 *                            (via a local port, see below).
 *   - waiting               — daily-brief.ts's isWaitingTask (Home/Updates'
 *                            own "Waiting"), plus open staff escalations
 *                            (unchanged from the prior shape).
 *   - later                 — daily-brief.ts's isLaterTask, minus anything
 *                            already claimed by the categories above.
 *   - unresolvedCaptures    — unchanged, independent Second Brain Phase 1
 *                            source.
 *
 * No invented urgency/priority field. No "ownerActionRequired" boolean —
 * there is no existing canonical signal for that (see fetchAttentionEvidence's
 * own prior doc comment on carsonCanHandle/safeToIgnore, same reasoning).
 * Each item carries only facts already true of it: id, label, type, status,
 * dueAt, dueDescription (formatReminderDue(), reused verbatim), assignee,
 * and which category it was actually filed under.
 */

import { taskLabel, formatReminderDue } from "./carson-morning-brief-classifier.js";
import { buildDailyBriefBuckets } from "./carson-daily-brief-classifier.js";
import { classifyAttentionWorthyCaptures } from "./carson-unresolved-captures-classifier.js";

const MS_14_DAYS = 14 * 24 * 60 * 60 * 1000;

/**
 * Port of src/lib/updates-reminders.ts's getUpcomingReminderTasks() —
 * same DELIBERATE DUPLICATION pattern as the other files in this slice
 * (updates-reminders.ts is a small, browser-only Home/Updates UI file with
 * no reason to be relocated). Same window (strictly future, within 14
 * days), same exclusion of anything already claimed elsewhere.
 */
function getUpcomingReminderTasksDup(tasks, excludedIds, now) {
  const nowMs = now.getTime();
  return tasks.filter((t) => {
    if (excludedIds.has(t.id)) return false;
    if (t.archived_at != null) return false;
    if (t.status !== "pending") return false;
    if (t.type !== "reminder") return false;
    if (!t.due_at) return false;
    const dueMs = new Date(t.due_at).getTime();
    if (Number.isNaN(dueMs)) return false;
    return dueMs > nowMs && dueMs <= nowMs + MS_14_DAYS;
  });
}

function toAttentionItem(t, category, now) {
  return {
    id: t.id,
    label: taskLabel(t.description, t.assigned_to),
    type: t.type,
    status: t.status,
    dueAt: t.due_at ?? null,
    dueDescription: t.due_at ? formatReminderDue(t.due_at, now) : null,
    assignee: t.assigned_to ?? null,
    category,
  };
}

/**
 * Pure composition — takes plain Task[] (already RLS-scoped by the
 * caller's own retrieval) plus the other two sources' raw results, and
 * produces the structured multi-category evidence shape.
 */
export function composeAttentionEvidence({
  generatedAt,
  now,
  tasks,
  tasksFailed,
  needsYou: staffNeedsYou,
  needsYouFailed,
  captureCandidates,
  capturesFailed,
  routineAutomationTaskIds,
}) {
  const empty = {
    needsYou: [],
    overdueReminders: [],
    upcomingReminders: [],
    waiting: [],
    later: [],
    unresolvedCaptures: [],
  };

  if (tasksFailed && needsYouFailed && capturesFailed) {
    return { ok: false, code: "attention_read_failed", generatedAt, completeness: "none", ...empty };
  }

  const needsYou = [];
  const overdueReminders = [];
  const upcomingReminders = [];
  const waiting = [];
  const later = [];
  const unresolvedCaptures = [];

  if (tasks) {
    const daily = buildDailyBriefBuckets(tasks, now);
    for (const t of daily.needsYou) needsYou.push(toAttentionItem(t, "needsYou", now));
    for (const t of daily.waitingOnOthers) waiting.push(toAttentionItem(t, "waiting", now));

    const claimedIds = new Set([...daily.needsYou, ...daily.waitingOnOthers].map((t) => t.id));

    const overdueTasks = tasks.filter((t) => {
      if (claimedIds.has(t.id)) return false;
      if (routineAutomationTaskIds?.has(t.id)) return false;
      if (t.archived_at != null) return false;
      if (t.status !== "pending") return false;
      return t.type === "reminder" && t.due_at && new Date(t.due_at).getTime() < now.getTime();
    });
    for (const t of overdueTasks) overdueReminders.push(toAttentionItem(t, "overdueReminders", now));
    for (const t of overdueTasks) claimedIds.add(t.id);

    const upcomingExcludedIds = routineAutomationTaskIds
      ? new Set([...claimedIds, ...routineAutomationTaskIds])
      : claimedIds;
    const upcomingTasks = getUpcomingReminderTasksDup(tasks, upcomingExcludedIds, now);
    for (const t of upcomingTasks) upcomingReminders.push(toAttentionItem(t, "upcomingReminders", now));
    for (const t of upcomingTasks) claimedIds.add(t.id);

    for (const t of daily.later) {
      if (claimedIds.has(t.id)) continue;
      later.push(toAttentionItem(t, "later", now));
    }
  }

  if (staffNeedsYou) {
    for (const e of staffNeedsYou) {
      waiting.push({
        id: e.id,
        label: `${e.staffName}: ${e.escalationReason ?? "needs your decision"}`,
        type: "staff_escalation",
        status: "pending",
        dueAt: null,
        dueDescription: null,
        assignee: e.staffName ?? null,
        category: "waiting",
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
        type: c.kind,
        status: "pending",
        dueAt: null,
        dueDescription: null,
        assignee: null,
        category: "unresolvedCaptures",
      });
    }
  }

  const completeness = tasksFailed || needsYouFailed || capturesFailed ? "partial" : "full";

  return {
    ok: true,
    code: completeness === "partial" ? "attention_read_partial" : "attention_read_succeeded",
    generatedAt,
    completeness,
    needsYou,
    overdueReminders,
    upcomingReminders,
    waiting,
    later,
    unresolvedCaptures,
    selectedCaptureIds: selectedCaptures.map((c) => ({ id: c.id, kind: c.kind })),
  };
}

function allItems(evidence) {
  return [
    ...(evidence.needsYou ?? []),
    ...(evidence.overdueReminders ?? []),
    ...(evidence.upcomingReminders ?? []),
    ...(evidence.waiting ?? []),
    ...(evidence.later ?? []),
    ...(evidence.unresolvedCaptures ?? []),
  ];
}

/**
 * Deterministic, narrow direct-query renderer. Preserves Needs You's
 * canonical meaning: if it's empty, this NEVER dumps every reminder — it
 * says so plainly and, where useful, mentions other categories only by
 * count (their own truthful label, never folded into "needs your
 * attention").
 */
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

  const total = allItems(evidence).length;
  if (total === 0) {
    return partialNote
      ? `Nothing needs your attention based on what I could check. ${partialNote}`
      : "Nothing needs your attention right now.";
  }

  const lines = [];

  if (evidence.needsYou.length > 0) {
    lines.push(`Needs your decision: ${evidence.needsYou.map((i) => i.label).join("; ")}.`);
  } else {
    lines.push("Nothing needs your direct decision right now.");
  }

  const countClause = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const otherCounts = [];
  if (evidence.overdueReminders.length > 0) otherCounts.push(countClause(evidence.overdueReminders.length, "overdue reminder"));
  if (evidence.upcomingReminders.length > 0) otherCounts.push(countClause(evidence.upcomingReminders.length, "upcoming reminder"));
  if (evidence.waiting.length > 0) otherCounts.push(countClause(evidence.waiting.length, "thing you're waiting on"));
  if (otherCounts.length > 0) {
    lines.push(`You do have ${otherCounts.join(" and ")}.`);
  }

  if (evidence.unresolvedCaptures.length > 0) {
    lines.push(
      `Also on your mind: ${evidence.unresolvedCaptures
        .map((i) => `${i.label} (${i.type === "todo" ? "on your to-do list" : "a note you made"})`)
        .join("; ")}.`,
    );
  }
  if (partialNote) lines.push(partialNote);

  return lines.join(" ");
}

// ── renderAttentionDecision — Second Brain stateful reasoning (2026-08-28) ──

const CATEGORY_LABELS = {
  needsYou: "Needs your decision",
  overdueReminders: "Overdue",
  upcomingReminders: "Coming up",
  waiting: "Waiting on others",
  later: "Other active items",
  unresolvedCaptures: "On your mind",
};

function findEvidenceItem(evidence, id) {
  return allItems(evidence).find((item) => item.id === id) ?? null;
}

function describeItem(item) {
  return item.dueDescription ? `${item.label} (${item.dueDescription})` : item.label;
}

function hasComparableDueAt(item) {
  return typeof item.dueAt === "string" && !Number.isNaN(new Date(item.dueAt).getTime());
}

function renderByCategory(items) {
  const byCategory = new Map();
  for (const item of items) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(item);
  }
  const sentences = [];
  for (const [category, group] of byCategory) {
    const label = CATEGORY_LABELS[category] ?? category;
    sentences.push(`${label}: ${group.map(describeItem).join("; ")}.`);
  }
  return sentences.join(" ");
}

/**
 * Deterministic renderer for a VALIDATED reasoning decision (see
 * api/_carson-attention-reasoning.js's validateAttentionDecision). The
 * model never supplies final text or category labels — it only
 * selects/ranks/contrasts ids; every label shown here comes from the
 * evidence item's own already-known category/label/reason, never from
 * the model.
 */
export function renderAttentionDecision(evidence, decision) {
  // rankedEvidenceIds is intentionally not destructured here — kept on the
  // decision contract for schema compatibility, but never used to author
  // temporal order (see the rank branch below).
  const { responseIntent, selectedEvidenceIds, contrastedEvidenceIds, needsClarification } = decision;

  if (responseIntent === "nothing_new") {
    return "Nothing else needs your attention beyond what I already mentioned.";
  }

  if (responseIntent === "clarify") {
    return needsClarification ? needsClarification.slice(0, 200) : "Could you clarify what you'd like to know?";
  }

  const selectedItems = selectedEvidenceIds.map((id) => findEvidenceItem(evidence, id)).filter(Boolean);

  if (selectedItems.length === 0 && responseIntent !== "contrast") {
    return "Nothing matches that right now.";
  }

  if (responseIntent === "explain" && selectedItems.length === 1) {
    const item = selectedItems[0];
    const reasonPhrase = item.dueDescription ?? (CATEGORY_LABELS[item.category] ?? item.category).toLowerCase();
    return `${item.label} is in ${CATEGORY_LABELS[item.category] ?? item.category} — ${reasonPhrase}.`;
  }

  // rankedEvidenceIds (the model's own proposed order) is NOT trusted as
  // the temporal order — dueAt is an authorized fact already on the
  // evidence, so precedence between dated items is computed here
  // deterministically rather than left to model judgment (2026-08-28,
  // Turn 3 canary: the model was observed producing an incoherent order
  // once two items rounded to the same dueDescription bucket, e.g. two
  // "Overdue by 3 days" items with different real dueAt values).
  if (responseIntent === "rank") {
    if (selectedItems.every(hasComparableDueAt)) {
      const sorted = [...selectedItems].sort(
        (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
      );
      return `In order: ${sorted.map(describeItem).join("; then ")}.`;
    }
    return `I don't have a reliable way to put those in order — here's what's active: ${renderByCategory(selectedItems)}`;
  }

  if (responseIntent === "contrast") {
    const contrastedItems = Array.isArray(contrastedEvidenceIds)
      ? contrastedEvidenceIds.map((id) => findEvidenceItem(evidence, id)).filter(Boolean)
      : [];
    const parts = [];
    if (selectedItems.length > 0) parts.push(renderByCategory(selectedItems));
    if (contrastedItems.length > 0) parts.push(renderByCategory(contrastedItems));
    if (parts.length === 0) return "Nothing matches that right now.";
    return parts.join(" ");
  }

  // list / explain-with-multiple-items default — grouped by true category.
  return renderByCategory(selectedItems);
}
