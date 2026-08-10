/**
 * carson-commitment-history.ts
 *
 * Historical Lookup — Phase 1, Q4 "Commitment History".
 *
 * Implements the frozen Historical Lookup Architecture (Carson's Memory
 * Retrieval Engine, Q4): given a keyword or person name, resolve the one
 * commitment (task/reminder/delegation) the owner means, then reconstruct
 * its full evidence-based lifecycle across every table that holds a piece
 * of that commitment's history — not just delivery status.
 *
 * Anchors on one task_id and merges, in chronological order:
 *   - tasks               (the commitment itself + its terminal status)
 *   - confirmations       (explicit completion confirmations)
 *   - whatsapp_deliveries (send/delivery/read/failure lifecycle)
 *   - quality_substitute_decisions (proof/substitution review cycle)
 *   - reminder_delivery_events     (reminder dispatch stage events)
 *   - staff_escalation_owner_decisions (owner decisions raised by this task)
 *
 * Conflict resolution: tasks.status / tasks.confirmed_at is the terminal,
 * authoritative record of "is it done" (structured lifecycle field). A
 * downstream event that contradicts it (e.g. the task is done but the
 * message never delivered, or done while an escalation is still open) is
 * never silently dropped or allowed to override the terminal state — it is
 * surfaced as an explicit caveat.
 *
 * Evidence-based answer: every claim traces to a real row and timestamp.
 * Zero matches never becomes a guess — Carson says so plainly.
 */

import { supabase } from "./supabase";
import type { Task } from "../types/task";

const TASK_COLUMNS =
  "id, user_id, description, type, assigned_to, status, due_at, confirmed_at, created_at, escalated_at, followup_sent_at, dismissed_at, archived_at, quality_review_status, quality_reviewed_at, quality_review_note, worker_reply";

/** Bounds free-text owner/system evidence before it goes into a spoken answer. */
function bound(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export interface CommitmentTimelineEvent {
  at: string;
  label: string;
  source:
    | "tasks"
    | "confirmations"
    | "whatsapp_deliveries"
    | "quality_substitute_decisions"
    | "reminder_delivery_events"
    | "staff_escalation_owner_decisions";
}

export interface CommitmentHistoryResult {
  task: Task;
  timeline: CommitmentTimelineEvent[];
  caveats: string[];
}

// ── Candidate resolution ──────────────────────────────────────────────────

/**
 * Finds candidate commitments matching a keyword against the task
 * description or assignee name. Deliberately searches every status and
 * archived state — Commitment History must find something regardless of
 * whether it is still active, done, cancelled, or archived.
 */
export async function findCommitmentCandidates(
  keyword: string,
  userId: string,
): Promise<Task[]> {
  const kw = keyword.trim();
  if (!kw) return [];

  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("user_id", userId)
    .or(`description.ilike.%${kw}%,assigned_to.ilike.%${kw}%`)
    .order("created_at", { ascending: false })
    .limit(6);

  if (error || !data) return [];
  return data as unknown as Task[];
}

// ── Timeline construction ─────────────────────────────────────────────────

async function fetchRelated<T>(
  table: string,
  taskId: string,
  columns: string,
  orderColumn: string,
): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq("task_id", taskId)
    .order(orderColumn, { ascending: true });
  if (error || !data) return [];
  return data as unknown as T[];
}

/**
 * Builds the full evidence-based lifecycle for one commitment: merges rows
 * from every related table into one chronological timeline, and flags any
 * conflict between the task's terminal state and a downstream event.
 */
export async function buildCommitmentHistory(
  task: Task,
): Promise<CommitmentHistoryResult> {
  const [confirmations, deliveries, qualityDecisions, reminderEvents, escalations] =
    await Promise.all([
      fetchRelated<{ confirmed_at: string; confirmed_by: string | null; source: string | null }>(
        "confirmations",
        task.id,
        "confirmed_at, confirmed_by, source",
        "confirmed_at",
      ),
      fetchRelated<{
        delivery_status: string | null;
        failure_reason: string | null;
        accepted_at: string | null;
        sent_at: string | null;
        delivered_at: string | null;
        read_at: string | null;
        failed_at: string | null;
        last_status_at: string | null;
      }>(
        "whatsapp_deliveries",
        task.id,
        "delivery_status, failure_reason, accepted_at, sent_at, delivered_at, read_at, failed_at, last_status_at",
        "last_status_at",
      ),
      fetchRelated<{
        decision: string | null;
        outcome: string | null;
        reviewed_at: string | null;
        completed_at: string | null;
      }>(
        "quality_substitute_decisions",
        task.id,
        "decision, outcome, reviewed_at, completed_at",
        "reviewed_at",
      ),
      task.type === "reminder"
        ? fetchRelated<{ stage: string; event_at: string }>(
            "reminder_delivery_events",
            task.id,
            "stage, event_at",
            "event_at",
          )
        : Promise.resolve([]),
      fetchRelated<{
        status: string | null;
        answered_at: string | null;
        created_at: string;
        review_type: string | null;
        owner_reply_text: string | null;
      }>(
        "staff_escalation_owner_decisions",
        task.id,
        "status, answered_at, created_at, review_type, owner_reply_text",
        "created_at",
      ),
    ]);

  const timeline: CommitmentTimelineEvent[] = [];

  timeline.push({ at: task.created_at, label: "Created", source: "tasks" });
  if (task.followup_sent_at) {
    timeline.push({ at: task.followup_sent_at, label: "Follow-up sent", source: "tasks" });
  }
  if (task.escalated_at) {
    timeline.push({ at: task.escalated_at, label: "Escalated to owner", source: "tasks" });
  }
  // A substitute-review escalation is the append-only record of "this task
  // needed an owner decision on a proposed substitute" — found via production
  // verification that task.quality_review_status is mutable and gets
  // overwritten once the owner decides (substitute_review -> approved), so
  // labeling an earlier timestamp with the CURRENT status misrepresents what
  // was actually true at that moment. When such an escalation exists, its own
  // two events below carry the real (correctly-timed) story instead.
  const substituteEscalation = escalations.find((e) => e.review_type === "substitute_review");

  // The automated Quality Intelligence proof review is stamped directly on
  // the task row (quality_reviewed_at/quality_review_status) and is not
  // guaranteed to have a matching quality_substitute_decisions row — that
  // table only exists for the substitute-review sub-flow's later owner
  // decision. Without this, a real reviewed-and-approved proof cycle went
  // missing from the reconstructed lifecycle entirely (found via production
  // verification against a real done+approved task with no substitute row).
  // Skipped when a substitute-review escalation exists (see above) — the
  // escalation's own events replace this one rather than duplicating it with
  // a mislabeled current-state snapshot.
  if (task.quality_reviewed_at && !substituteEscalation) {
    timeline.push({
      at: task.quality_reviewed_at,
      label: `Automated quality review: ${task.quality_review_status ?? "reviewed"}`,
      source: "tasks",
    });
  }

  for (const d of deliveries) {
    if (d.accepted_at) timeline.push({ at: d.accepted_at, label: "Accepted by WhatsApp", source: "whatsapp_deliveries" });
    if (d.sent_at) timeline.push({ at: d.sent_at, label: "Sent", source: "whatsapp_deliveries" });
    if (d.delivered_at) timeline.push({ at: d.delivered_at, label: "Delivered", source: "whatsapp_deliveries" });
    if (d.read_at) timeline.push({ at: d.read_at, label: "Read", source: "whatsapp_deliveries" });
    if (d.failed_at) {
      timeline.push({
        at: d.failed_at,
        label: `Delivery failed${d.failure_reason ? ` (${d.failure_reason})` : ""}`,
        source: "whatsapp_deliveries",
      });
    }
  }

  for (const e of reminderEvents) {
    timeline.push({ at: e.event_at, label: `Reminder ${e.stage}`, source: "reminder_delivery_events" });
  }

  for (const esc of escalations) {
    const isSubstitute = esc.review_type === "substitute_review";
    timeline.push({
      at: esc.created_at,
      label: isSubstitute ? "Substitute proposed — needed your review" : "Owner decision requested",
      source: "staff_escalation_owner_decisions",
    });
    if (esc.answered_at) {
      // Real evidence, not a generic label: the owner's own reply (append-only
      // on this row) plus, for a substitute review specifically, the app's own
      // outcome note on the task — both confirmed present for the real
      // production case this fix was written against ("Yes buy it" /
      // "Owner approved the alternative.").
      const reply = esc.owner_reply_text?.trim() || null;
      const note = isSubstitute ? task.quality_review_note?.trim() || null : null;
      const parts = [reply ? `"${bound(reply, 60)}"` : null, note ? bound(note, 80) : null].filter(
        (p): p is string => Boolean(p),
      );
      timeline.push({
        at: esc.answered_at,
        label: parts.length > 0 ? `Owner decided: ${parts.join(" — ")}` : "Owner decided",
        source: "staff_escalation_owner_decisions",
      });
    }
  }

  for (const q of qualityDecisions) {
    if (q.reviewed_at) {
      // Distinct label from the automated task-level review above — this is
      // the owner's own later decision on a proposed substitute, a separate
      // real event, not a duplicate of the automated pass.
      timeline.push({
        at: q.reviewed_at,
        label: `Owner quality decision: ${q.decision ?? "reviewed"}`,
        source: "quality_substitute_decisions",
      });
    }
  }

  // confirmations is the structured, first-party record of completion — always
  // included even when it duplicates tasks.confirmed_at, since it is per the
  // architecture's conflict ladder equally authoritative and may carry a
  // `source`/`confirmed_by` the task row itself does not.
  for (const c of confirmations) {
    timeline.push({
      at: c.confirmed_at,
      label: `Confirmed${c.confirmed_by ? ` by ${c.confirmed_by}` : ""}`,
      source: "confirmations",
    });
  }

  if (task.confirmed_at && confirmations.length === 0) {
    timeline.push({ at: task.confirmed_at, label: "Confirmed", source: "tasks" });
  }

  timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // ── Conflict resolution ──────────────────────────────────────────────────
  // tasks.status is the terminal, authoritative field for "is it done." A
  // downstream event that contradicts it is surfaced, never silently
  // resolved or allowed to override the terminal state.
  const caveats: string[] = [];

  if (task.status === "done") {
    const lastDelivery = deliveries[deliveries.length - 1];
    if (lastDelivery?.delivery_status === "failed") {
      caveats.push(
        "the task is marked done, though the most recent WhatsApp delivery attempt on it shows a failure — the original message may not have arrived",
      );
    }
    const openEscalation = escalations.find((e) => !e.answered_at);
    if (openEscalation) {
      caveats.push(
        "the task is marked done, though it has an owner decision on record that doesn't show as answered",
      );
    }
  }

  return { task, timeline, caveats };
}

// ── Evidence-based answer formatting ──────────────────────────────────────

function describeOutcome(task: Task): string {
  if (task.status === "cancelled") return "It was cancelled";
  if (task.status === "done") {
    const when = task.confirmed_at ? new Date(task.confirmed_at) : null;
    return when
      ? `It was confirmed done on ${when.toLocaleDateString([], { month: "short", day: "numeric" })}`
      : "It was marked done";
  }
  if (task.dismissed_at) return "It was dismissed";
  return "It's still pending";
}

/**
 * Formats the final evidence-based answer for Carson to speak or type.
 * Pure and network-free — takes an already-built history result.
 */
export function formatCommitmentHistoryAnswer(result: CommitmentHistoryResult): string {
  const { task, timeline, caveats } = result;
  const who = task.assigned_to ? ` (assigned to ${task.assigned_to})` : "";
  const lines = [`"${task.description}"${who}. ${describeOutcome(task)}.`];

  // One or two pivotal events, not the full raw log — evidence without noise.
  // The architecture's own examples are "sent on X, confirmed on Y": outcome-
  // relevant events (delivery/confirmation/decision) take priority over
  // administrative ones (escalation opened, automated review) so a real
  // Confirmed event never gets crowded out just because it happened last.
  const nonCreated = timeline.filter((e) => e.label !== "Created");
  const isOutcomeRelevant = (label: string) =>
    label === "Sent" ||
    label === "Delivered" ||
    label === "Read" ||
    label.startsWith("Delivery failed") ||
    label.startsWith("Owner decided") ||
    label === "Confirmed" ||
    label.startsWith("Confirmed by");
  const prioritized = nonCreated.filter((e) => isOutcomeRelevant(e.label));
  const filler = nonCreated.filter((e) => !isOutcomeRelevant(e.label));
  // CodeRabbit finding on PR #165: taking the first two outcome-relevant
  // events (chronologically) could crowd out a later one — e.g. an earlier
  // Sent/Delivered pair suppressing a later Owner-decided/Confirmed pair,
  // the exact class of bug this file was created to fix. Take the LATEST
  // two outcome-relevant events instead; only fall back to backfilling with
  // administrative (filler) events when fewer than two outcome-relevant
  // events exist at all.
  const pivotal = (prioritized.length >= 2 ? prioritized.slice(-2) : [...prioritized, ...filler].slice(0, 2))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (pivotal.length > 0) {
    const parts = pivotal.map((e) => {
      const d = new Date(e.at).toLocaleDateString([], { month: "short", day: "numeric" });
      return `${e.label} on ${d}`;
    });
    lines.push(parts.join(", then "));
  }

  for (const caveat of caveats) {
    lines.push(`Worth noting: ${caveat}.`);
  }

  return lines.join(" ");
}

function formatCandidateSnippet(task: Task): string {
  const text = task.description.slice(0, 45).trim();
  return `"${text}${task.description.length > 45 ? "…" : ""}"`;
}

// ── Top-level orchestrator (the client-tool entry point) ──────────────────

/**
 * Q4 Commitment History entry point. Resolves the commitment by keyword,
 * disambiguates when necessary (same UX convention as act_on_note: 0 matches
 * asks the user to clarify, >1 lists up to 4 snippets and asks which one,
 * exactly 1 proceeds), then returns an evidence-based answer.
 *
 * Never guesses between multiple plausible matches — this mirrors the
 * frozen architecture's rule that Carson must never guess when more than
 * one unresolved item is plausible.
 */
export async function lookupCommitmentHistory(keyword: string): Promise<string> {
  const kw = keyword?.trim();
  if (!kw) {
    return "I need a task description or a person's name to look up. Ask the user which commitment they mean.";
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "I couldn't look that up right now — not signed in.";

  const candidates = await findCommitmentCandidates(kw, user.id);

  if (candidates.length === 0) {
    return `I don't have a record of anything matching "${kw}".`;
  }

  if (candidates.length > 1) {
    const snippets = candidates.slice(0, 4).map(formatCandidateSnippet).join(", ");
    return `I found ${candidates.length} matching "${kw}": ${snippets}. Ask the user which one they mean.`;
  }

  const history = await buildCommitmentHistory(candidates[0]);
  return formatCommitmentHistoryAnswer(history);
}

// ── Historical Lookup — Phase 2, Person History ────────────────────────────
//
// Reuses findCommitmentCandidates() as-is — it already matches on
// assigned_to, so a bare person-name query already returns their tasks
// today. The one real gap Commitment History doesn't handle: a person-name
// match is *expected* to return many tasks, unlike a task-keyword match, so
// asking "which one do you mean" (lookupCommitmentHistory's multi-match
// behavior) is the wrong shape here. This summarizes instead of
// disambiguating. A single match still gets the identical full
// evidence-based lifecycle answer as lookupCommitmentHistory — reused, not
// reimplemented.

/**
 * Aggregate outcome counts only, never a raw per-task list — the same
 * data-minimization principle Option B established for ra7etbal_state's
 * COMPLETED block (see carson-context.ts): a count is safe to state as
 * fact; a full per-task dump is not, and isn't useful when there are many.
 *
 * Takes only the narrow {status, dismissed_at} shape — not a full Task —
 * so it can be fed either the bounded `candidates` list or the unbounded
 * full-history row set below without caring which.
 */
function summarizePersonOutcomes(rows: Array<{ status: string | null; dismissed_at: string | null }>): string {
  const counts = new Map<string, number>();
  for (const t of rows) {
    const outcome =
      t.status === "cancelled" ? "cancelled" : t.status === "done" ? "done" : t.dismissed_at ? "dismissed" : "pending";
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ");
}

/**
 * The true outcome counts for every task matching this person, with no
 * cap — deliberately separate from findCommitmentCandidates(), whose
 * .limit(6) exists for Phase 1's "which one do you mean" disambiguation
 * and must never silently double as a truncated stand-in for someone's
 * total history. Selects only the two columns outcome-counting needs, not
 * full task rows, keeping the extra query cheap even though it has no
 * limit.
 *
 * Root cause this fixes (found during live production verification,
 * 2026-08-10): lookupPersonHistory previously computed outcome counts
 * from the same capped `candidates` array used for the recent-items list,
 * so a person with more than 6 real tasks was reported as having exactly
 * 6 total — every individual fact stated was true, but the aggregate was
 * a truncated sample presented as a total.
 */
/**
 * Returns null on a genuine query failure — never [] for that case. This
 * function only ever runs after findCommitmentCandidates() has already
 * found 2+ real matching rows via the identical filter, so a legitimate
 * zero-row result here isn't structurally possible; an empty result is
 * always a failure signal, and the caller must not report a false "0
 * commitments" total that would contradict the recent items it's about
 * to list right next to it.
 */
async function fetchPersonOutcomeCounts(
  keyword: string,
  userId: string,
): Promise<Array<{ status: string | null; dismissed_at: string | null }> | null> {
  const kw = keyword.trim();
  if (!kw) return [];

  const { data, error } = await supabase
    .from("tasks")
    .select("status, dismissed_at")
    .eq("user_id", userId)
    .or(`description.ilike.%${kw}%,assigned_to.ilike.%${kw}%`);

  if (error) return null;
  return (data ?? []) as Array<{ status: string | null; dismissed_at: string | null }>;
}

/**
 * Historical Lookup Phase 2 entry point. Given a person's name, summarizes
 * their overall commitment history. Never guesses which specific task the
 * owner means the way lookupCommitmentHistory does for an ambiguous task
 * keyword — a person naturally has multiple commitments, so the answer is
 * an evidence-based overview (outcome counts plus the most recent items),
 * not a forced single-task pick.
 */
export async function lookupPersonHistory(personName: string): Promise<string> {
  const name = personName?.trim();
  if (!name) {
    return "I need a person's name to look up. Ask the user whose history they mean.";
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "I couldn't look that up right now — not signed in.";

  const candidates = await findCommitmentCandidates(name, user.id);

  if (candidates.length === 0) {
    return `I don't have a record of anything for "${name}".`;
  }

  if (candidates.length === 1) {
    const history = await buildCommitmentHistory(candidates[0]);
    return formatCommitmentHistoryAnswer(history);
  }

  // Total counts come from the full, unbounded match set — never from
  // `candidates`, which is capped at 6 for Phase 1's disambiguation needs
  // and must not double as this person's total history. Recent items stay
  // sourced from `candidates` (already ordered by created_at desc), so the
  // "which N are most recent" answer is unaffected by this fix.
  const allOutcomeRows = await fetchPersonOutcomeCounts(name, user.id);
  const recent = candidates
    .slice(0, 3)
    .map((t) => `${formatCandidateSnippet(t)} — ${describeOutcome(t)}`)
    .join("; ");

  // The full-history count failed — never state a false total (e.g. "0
  // commitments") that would contradict the real recent items right next
  // to it. Still give the recent items, which came from the separate,
  // already-succeeded candidates query.
  if (allOutcomeRows === null) {
    return `I can see recent commitments for ${name} but couldn't get an accurate total right now. Most recent: ${recent}.`;
  }

  const totalCount = allOutcomeRows.length;
  const outcomeSummary = summarizePersonOutcomes(allOutcomeRows);
  return `${name} total: ${totalCount} commitments (${outcomeSummary}). ${Math.min(3, candidates.length)} most recent: ${recent}.`;
}
