/**
 * carson-operations-center.ts
 *
 * P1 #3 — Operations Center V1 (COS Ch. 10, 15, 17, 20)
 *
 * Constitutional gap: `ra7etbal_state` is injected once at ElevenLabs session
 * start and never refreshed. If a WhatsApp delivery fails or a reminder is
 * not delivered after the session begins, Carson cannot see it and cannot
 * answer "did Ahmed get the message?" truthfully.
 *
 * Minimum constitutional slice (read-only, no new schema):
 *   get_task_delivery_status  — per-task delivery timeline on demand
 *   get_operations_summary    — fresh operational snapshot on demand
 *
 * Both functions query existing tables (tasks, whatsapp_deliveries) and return
 * plain text strings Carson can read aloud. They never assume success; they
 * report only what the database contains (COS Ch. 15 observation principle).
 */

import { supabase } from "./supabase";
import { listTasks } from "./tasks";
import { fetchAutomationDigest } from "./automation-context";
import { listOpenStaffEscalationsForNeedsYou } from "./staff-messages";
import { fetchUnresolvedCaptureCandidates, type UnresolvedCapture } from "./carson-unresolved-captures";
import { markCarsonNotesSurfaced } from "./carson-notes";
import { markCarsonTodosSurfaced } from "./carson-todos";
import type { Task } from "../types/task";
// PURE RELOCATION (2026-08-28, Second Brain typed hard-grounding slice):
// evidence composition + rendering moved to shared/ so the server-side
// attention read path calls the exact same functions after doing its own
// (necessarily different) I/O. Re-exported so every existing caller's
// import path (`./carson-operations-center`) and behavior are unchanged.
import { composeAttentionEvidence, renderAttentionSummary, renderAlsoOnYourMindLine } from "../../shared/carson-attention-summary.js";
import type { AttentionItem, AttentionSummaryEvidence } from "../../shared/carson-attention-summary";
export { renderAttentionSummary };
export type { AttentionItem, AttentionSummaryEvidence };

// ── Internal helpers ──────────────────────────────────────────────────────────

// 2026-08-25 production investigation: fetchAttentionEvidence()'s per-source
// calls had no timeout anywhere in the chain (confirmed: none of listTasks,
// listOpenStaffEscalationsForNeedsYou, fetchUnresolvedCaptureCandidates, or
// their own dependencies wrap in a timeout) — a stalled connection could
// leave this hanging indefinitely rather than resolving or rejecting,
// leaving both the ElevenLabs tool call and carson-attention-intent-guard.ts's
// grounded-result check waiting with no bound. Bounded per-source, not
// per-request, so one slow source degrades to that source's own existing
// partial-failure handling instead of blocking the other two.
const ATTENTION_SOURCE_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms = ATTENTION_SOURCE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("attention evidence source timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function msToAgo(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.round(ms / 60_000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ${Math.round((h % 24))}h ago`;
}

// ── fetchTaskDeliveryStatus ───────────────────────────────────────────────────

/**
 * Searches tasks by description keyword, then fetches the WhatsApp delivery
 * timeline for each matching task.
 *
 * Returns a plain-text string Carson can read aloud. Reports only what the
 * database contains — never assumes the message was delivered (COS Ch. 15).
 */
export async function fetchTaskDeliveryStatus(keyword: string): Promise<string> {
  if (!keyword?.trim()) {
    return "Please tell me which task or person to look up.";
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "I couldn't check delivery status right now — not signed in.";

  const kw = keyword.trim().toLowerCase();

  // Search tasks matching the keyword in description or assigned_to
  const { data: tasks, error: taskError } = await supabase
    .from("tasks")
    .select("id, description, assigned_to, status, type, reminder_delivery_status, reminder_delivery_error, created_at")
    .eq("user_id", user.id)
    .or(`description.ilike.%${kw}%,assigned_to.ilike.%${kw}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  if (taskError || !tasks || tasks.length === 0) {
    return `No tasks found matching "${keyword}".`;
  }

  const lines: string[] = [];

  // Fetch every matched task's WhatsApp delivery timeline concurrently
  // instead of one-at-a-time in the loop below. Same query per task (filter,
  // order, limit all unchanged) — only the network round trips are now
  // concurrent, not sequential. Promise.all preserves index-to-task
  // correspondence regardless of which query resolves first, so output
  // order below is unaffected.
  const deliveriesByTask = await Promise.all(
    (tasks as Record<string, unknown>[]).map((task) =>
      supabase
        .from("whatsapp_deliveries")
        .select("delivery_status, failure_reason, failure_code, failure_stage, accepted_at, sent_at, delivered_at, read_at, failed_at, last_status_at")
        .eq("task_id", task.id as string)
        .order("last_status_at", { ascending: false })
        .limit(3),
    ),
  );

  (tasks as Record<string, unknown>[]).forEach((task, index) => {
    const desc = (task.description as string | null) ?? "(no description)";
    const assignedTo = (task.assigned_to as string | null) ?? "unassigned";
    const taskType = (task.type as string | null) ?? "task";
    const taskStatus = (task.status as string | null) ?? "unknown";

    lines.push(`Task: "${desc.slice(0, 80)}" — assigned to ${assignedTo} (${taskType}, ${taskStatus})`);

    // Reminder delivery status
    const reminderStatus = task.reminder_delivery_status as string | null;
    if (reminderStatus && reminderStatus !== "scheduled") {
      const reminderError = task.reminder_delivery_error as string | null;
      lines.push(`  Reminder delivery: ${reminderStatus}${reminderError ? ` — ${reminderError}` : ""}`);
    }

    // WhatsApp delivery timeline from whatsapp_deliveries
    const { data: deliveries } = deliveriesByTask[index];

    if (!deliveries || deliveries.length === 0) {
      if (taskType === "delegation") {
        lines.push("  WhatsApp: no delivery record found.");
      }
    } else {
      for (const d of deliveries as Record<string, unknown>[]) {
        const status = d.delivery_status as string | null;
        const nowMs = Date.now();

        if (status === "read") {
          const readAt = d.read_at as string | null;
          lines.push(`  WhatsApp: read${readAt ? ` (${msToAgo(nowMs - new Date(readAt).getTime())})` : ""}`);
        } else if (status === "delivered") {
          const delivAt = d.delivered_at as string | null;
          lines.push(`  WhatsApp: delivered${delivAt ? ` (${msToAgo(nowMs - new Date(delivAt).getTime())})` : ""}, not yet read`);
        } else if (status === "sent") {
          const sentAt = d.sent_at as string | null;
          lines.push(`  WhatsApp: sent${sentAt ? ` (${msToAgo(nowMs - new Date(sentAt).getTime())})` : ""}, awaiting delivery`);
        } else if (status === "accepted") {
          const accAt = d.accepted_at as string | null;
          lines.push(`  WhatsApp: accepted by Meta${accAt ? ` (${msToAgo(nowMs - new Date(accAt).getTime())})` : ""}, not yet sent`);
        } else if (status === "failed") {
          const failedAt = d.failed_at as string | null;
          const reason = (d.failure_reason as string | null) ?? (d.failure_code as string | null) ?? "unknown reason";
          const stage = d.failure_stage as string | null;
          lines.push(`  WhatsApp: FAILED${failedAt ? ` (${msToAgo(nowMs - new Date(failedAt).getTime())})` : ""} — ${reason}${stage ? ` [stage: ${stage}]` : ""}`);
        } else {
          lines.push(`  WhatsApp: ${status ?? "unknown status"}`);
        }
      }
    }
  });

  return lines.join("\n");
}

// ── fetchOperationsSummary ────────────────────────────────────────────────────

/**
 * Returns a fresh operational snapshot — equivalent to the WhatsApp failures
 * block in ra7etbal_state but current at the moment of the call.
 *
 * Includes:
 *   - WhatsApp delivery failures (last 48h)
 *   - Reminders with failed or unconfirmed delivery (last 48h)
 *   - Recent delegations with no delivery record
 *
 * Carson can call this when asked "what's going on" or "is everything working."
 */
export async function fetchOperationsSummary(): Promise<string> {
  try {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      return "I couldn't load the operations summary right now — authentication check failed.";
    }
    if (!user) return "I couldn't load the operations summary right now — not signed in.";

    const window48hAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();

    // These reads are independent once the authenticated owner is known.
    // Run them concurrently so a fresh voice session does not pay two
    // sequential Supabase round trips before returning the summary.
    const [waResult, reminderResult] = await Promise.all([
      supabase
        .from("whatsapp_deliveries")
        .select("recipient_name, source_type, failure_reason, failure_code, failed_at")
        .eq("delivery_status", "failed")
        .gte("failed_at", window48hAgo)
        .order("failed_at", { ascending: false })
        .limit(10),
      supabase
        .from("tasks")
        .select("description, assigned_to, reminder_delivery_status, reminder_delivery_error, created_at")
        .eq("user_id", user.id)
        .eq("type", "reminder")
        .in("reminder_delivery_status", ["failed", "delivery_unconfirmed"])
        .gte("created_at", window48hAgo)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

    if (waResult.error || reminderResult.error) {
      return "I couldn't load the operations summary right now — one or more live status checks failed.";
    }

    const waFailures = waResult.data;
    const reminderIssues = reminderResult.data;
    const lines: string[] = ["OPERATIONS SUMMARY (live):"];
    const nowMs = Date.now();

    if (waFailures && waFailures.length > 0) {
      lines.push(`WhatsApp delivery failures (${waFailures.length}):`);
      for (const f of waFailures as Record<string, unknown>[]) {
        const who = (f.recipient_name as string | null) ? ` to ${f.recipient_name as string}` : "";
        const failedAt = f.failed_at as string | null;
        const age = failedAt ? msToAgo(nowMs - new Date(failedAt).getTime()) : "unknown time";
        const reason = (f.failure_reason as string | null) ?? (f.failure_code as string | null) ?? "unknown reason";
        lines.push(`  - Failed${who} (${age}): ${reason}`);
      }
    } else {
      lines.push("No WhatsApp delivery failures in the last 48 hours.");
    }

    if (reminderIssues && reminderIssues.length > 0) {
      lines.push(`Reminder delivery issues (${reminderIssues.length}):`);
      for (const r of reminderIssues as Record<string, unknown>[]) {
        const desc = ((r.description as string | null) ?? "(no description)").slice(0, 60);
        const status = r.reminder_delivery_status as string;
        const error = r.reminder_delivery_error as string | null;
        lines.push(`  - "${desc}" — ${status}${error ? `: ${error}` : ""}`);
      }
    } else {
      lines.push("No reminder delivery issues in the last 48 hours.");
    }

    return lines.join("\n");
  } catch {
    return "I couldn't load the operations summary right now — the live status check did not complete.";
  }
}

// ── fetchAttentionSummary ─────────────────────────────────────────────────────

/**
 * get_items_needing_attention — the Second Brain grounded-attention proof.
 *
 * Structured-first: fetchAttentionEvidence() produces a narrow evidence
 * object containing only fields the actually-retrieved data supports;
 * renderAttentionSummary() is a pure, deterministic string builder with no
 * LLM step. This split is the enforcement point — the render function can
 * never state an item that isn't present in the evidence it was given.
 *
 * "needsAttention" and "waiting" deliberately reuse morning-brief.ts's
 * buildMorningBrief() classification (the same relevance-tuned classifier
 * that already powers the live spoken Morning Brief/Night Sweep) rather
 * than daily-brief.ts's older, separately-tested isNeedsYouTask() —
 * morning-brief.ts is the classifier actually answering this exact
 * question today. "waiting" also folds in open staff escalations via
 * listOpenStaffEscalationsForNeedsYou(), the same read-only source
 * proactive_opening_brief already uses for its own Needs You slot.
 *
 * carsonCanHandle and safeToIgnore are intentionally always empty in this
 * slice: no existing signal in the data model currently distinguishes
 * "Carson could act on this" or "this is safe to ignore" from the other
 * buckets, and inventing one here would fabricate a classification the
 * retrieved data does not support. Documented, not silently omitted.
 */
// AttentionItem, AttentionSummaryEvidence, renderAttentionSummary: see
// shared/carson-attention-summary.js — imported and re-exported above,
// pure relocation, no behavior change.

export async function fetchAttentionEvidence(): Promise<AttentionSummaryEvidence> {
  return (await readAttentionEvidence()).evidence;
}

/**
 * The one attention read, plus each task's original wording by id (P3 Step 3 /
 * S3). The shared evidence carries shortened labels ("bill task", "car task")
 * and stays exactly as it is for every other consumer; only the legacy voice
 * view uses the owner's own wording.
 */
async function readAttentionEvidence(): Promise<{
  evidence: AttentionSummaryEvidence;
  taskWording: Map<string, string>;
}> {
  const generatedAt = new Date().toISOString();
  const empty = {
    needsYou: [] as AttentionItem[],
    overdueReminders: [] as AttentionItem[],
    upcomingReminders: [] as AttentionItem[],
    waiting: [] as AttentionItem[],
    later: [] as AttentionItem[],
    unresolvedCaptures: [] as AttentionItem[],
  };

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return {
      evidence: { ok: false, code: "attention_auth_failed", generatedAt, completeness: "none", ...empty },
      taskWording: new Map(),
    };
  }

  const now = new Date();

  // Kick off all three independent, fallible sources concurrently — each
  // wrapped in its own bounded timeout — rather than awaiting them one at a
  // time. Each promise is created (starting its underlying request) before
  // any of them is awaited, so they genuinely run in parallel; each is then
  // awaited with its own try/catch, preserving the exact same per-source
  // failure semantics as before (a slow/failed source degrades only its own
  // *Failed flag, never blocks or fails the other two).
  const tasksPromise = withTimeout(listTasks());
  const needsYouPromise = withTimeout(listOpenStaffEscalationsForNeedsYou());
  const capturesPromise = withTimeout(fetchUnresolvedCaptureCandidates(now));
  // fetchAutomationDigest never throws — it returns an empty digest on
  // auth failure or query error, so routineAutomationTaskIds below is
  // always defined (possibly empty), never undefined-because-it-threw.
  //
  // Deliberately NOT under withTimeout, unlike the three sources above.
  //
  // A timeout here would empty routineAutomationTaskIds, and that set SUPPRESSES
  // tasks tied to an open automation run — so degrading it re-admits those tasks
  // into overdueReminders/upcomingReminders. That is a change to protected
  // attention membership on the degraded path, and it is not P3 5b's to make.
  // An earlier revision of this slice did add the timeout; review caught that it
  // traded a latency risk for a correctness regression, so it was reverted.
  //
  // The unbounded await is pre-existing behavior. The latency exposure it
  // represents is real and recorded as a carried finding for a separate,
  // properly scoped change — not fixed here.
  const digestPromise = fetchAutomationDigest();

  let tasks: Task[] | null = null;
  let tasksFailed = false;
  try {
    tasks = await tasksPromise;
  } catch {
    tasksFailed = true;
  }

  let needsYou: Awaited<ReturnType<typeof listOpenStaffEscalationsForNeedsYou>> | null = null;
  let needsYouFailed = false;
  try {
    needsYou = await needsYouPromise;
  } catch {
    needsYouFailed = true;
  }

  let captureCandidates: UnresolvedCapture[] | null = null;
  let capturesFailed = false;
  try {
    captureCandidates = await capturesPromise;
  } catch {
    capturesFailed = true;
  }

  const digest = await digestPromise;

  const evidence = composeAttentionEvidence({
    generatedAt,
    now,
    tasks,
    tasksFailed,
    needsYou,
    needsYouFailed,
    captureCandidates,
    routineAutomationTaskIds: digest.routineAutomationTaskIds,
    recurringSourceIndexes: digest.recurringSourceIndexes,
    // Explicit flag, not inferred from absent indexes: a digest that loaded fine
    // for an owner with no automations must still count as complete, while a
    // failed auth/read must not — the membership below would be pre-correction.
    recurringSourceFailed: digest.recurringSourceLinksLoaded !== true,
    capturesFailed,
  });

  // Retrieval never writes last_surfaced_at (P3 Step 3 / S2). Retrieved or
  // prefetched is not surfaced: the guard prefetch and a tool result sent
  // only to the model may never reach the owner. Marking happens only at
  // the owner-visible presentation boundary — markAttentionCapturesSurfaced.
  return { evidence, taskWording: new Map((tasks ?? []).map((t) => [t.id, t.description])) };
}

export type AttentionCaptureRef = { id: string; kind: "note" | "todo" };

/**
 * A rendered attention answer plus the captures that text includes.
 * assignees: the people with an open item in this live evidence (P3 Step 3 /
 * S3) — lets a "What about <name>?" follow-up be recognised only for a person
 * the owner was just told about.
 */
export type AttentionPresentation = {
  text: string;
  captureIds: AttentionCaptureRef[];
  assignees?: string[];
  /** Voice only: the live read succeeded (P3 Step 3 / S3). */
  evidenceOk?: boolean;
  /** Voice only: the tool result for the model — the text plus how to use it. */
  modelText?: string;
  /** Voice only: the background note offered after a successful read. */
  contextNote?: string;
  /** Voice only: what this answer gave the model, for a later "the rest" / "continue". */
  page?: { givenIds: string[]; person: string | null; remaining: number };
};

/**
 * P3 Step 3 / S3 — legacy voice only. What the owner asked for this turn:
 * - summary: the initial answer (at most five names, owner decision);
 * - all: every item of the summary's categories ("Which ones?");
 * - rest: the items the previous attention answer did not give the model
 *   ("Tell me the rest", "What else?", "Continue"), followed by the ones it
 *   did, because the app cannot know which of those Carson actually said.
 *   previouslyGivenIds and person come from that previous answer; person
 *   keeps a split person list going;
 * - person: one person's open items in any category ("What about Christopher?").
 */
export type VoiceAttentionRequest =
  | { kind: "summary" }
  | { kind: "all" }
  | { kind: "rest"; previouslyGivenIds?: readonly string[]; person?: string | null }
  | { kind: "person"; name: string };

/** Owner decision (2026-10-09): at most five item names in a voice summary. */
export const VOICE_ATTENTION_NAME_LIMIT = 5;

/**
 * P3 Step 3 / S3 (2026-10-09 canary): an explicit list request names every
 * item. Past this many entries in one answer it is split, the answer says so,
 * and "continue" gives the next part — never a silent "and N more".
 */
export const VOICE_FULL_LIST_PAGE_SIZE = 10;

const VOICE_NAMED_CATEGORIES = [
  ["overdueReminders", "Overdue reminders"],
  ["upcomingReminders", "Upcoming reminders"],
  ["waiting", "Waiting on others"],
] as const;

const VOICE_PERSON_CATEGORIES = ["needsYou", "overdueReminders", "upcomingReminders", "waiting", "later"] as const;

const VOICE_WORDING_MAX = 120;

/** One spoken entry: one record, or several separate records with the same wording. */
type VoiceEntry = { text: string; ids: string[] };

/**
 * The owner's own wording for an item (2026-10-09 canary: shortened labels
 * such as "bill task" and "car task" were spoken back as the session-start
 * names instead). Falls back to the shared label when no wording is known.
 */
function fullWording(item: AttentionItem, taskWording: ReadonlyMap<string, string>): string {
  const text = (taskWording.get(item.id) ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
  return text || item.label;
}

function voiceWording(item: AttentionItem, taskWording: ReadonlyMap<string, string>): string {
  let text = fullWording(item, taskWording);
  if (text.length > VOICE_WORDING_MAX) {
    const cut = text.slice(0, VOICE_WORDING_MAX);
    const lastSpace = cut.lastIndexOf(" ");
    text = `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return text;
}

/**
 * Same-wording records stay separate records, grouped naturally:
 * "Call Loulya (3 separate reminders)". Different people are never merged.
 */
function voiceEntries(
  items: readonly AttentionItem[],
  taskWording: ReadonlyMap<string, string>,
  withAssignee: boolean,
): VoiceEntry[] {
  const groups = new Map<string, { name: string; reminder: boolean; ids: string[] }>();
  for (const item of items) {
    const wording = voiceWording(item, taskWording);
    const name = withAssignee && item.assignee ? `${item.assignee}: ${wording}` : wording;
    const reminder = item.type === "reminder";
    // Same person, same full wording and same kind only: a reminder and a
    // task, or two long items sharing a cut-off prefix, stay apart.
    const key = `${reminder}|${withAssignee ? (item.assignee ?? "").toLowerCase() : ""}|${fullWording(item, taskWording).toLowerCase()}`;
    const group = groups.get(key) ?? { name, reminder, ids: [] };
    group.ids.push(item.id);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    text:
      group.ids.length > 1
        ? `${group.name} (${group.ids.length} separate ${group.reminder ? "reminders" : "tasks"})`
        : group.name,
    ids: group.ids,
  }));
}

const countIds = (entries: readonly VoiceEntry[]) => entries.reduce((sum, entry) => sum + entry.ids.length, 0);

/** What the voice model is given for one request, and what it names. */
export type VoiceAttentionView = {
  text: string;
  /**
   * Item ids GIVEN TO THE MODEL by this answer and, for "the rest", the
   * answers before it in the same chain. Not proof they were spoken: the app
   * has no record of what Carson actually said aloud.
   */
  givenIds: string[];
  /** An explicit list request: the model must name every item given. */
  listRequest: boolean;
  /** Items left for "continue" when the list was split for length. */
  remaining: number;
  /** The person a person list (or its continuation) is about. */
  person: string | null;
  /** A "the rest" / "continue" answer that re-lists what was already given. */
  continuation?: boolean;
  /** Captures whose "Also on your mind" line is in this answer's text. */
  shownCaptureIds?: string[];
};

/**
 * P3 Step 3 / S3 — legacy voice only. Production (conv_1501m3fmxeh4eknvqy7m07n55qat,
 * 2026-09-26): the live voice result gave counts only, so every item Carson
 * then named came from the session-start {{ra7etbal_state}} list. Production
 * (conv_4501m4gfrsgyfdztjms1ypbdt8jp, 2026-10-09): the live list was correct,
 * but its shortened labels and a "Which ones?" answer reduced to "four more
 * unspecified tasks". This names the live items in the owner's own wording.
 *
 * - summary: the decisions line, then overdue / upcoming / waiting with exact
 *   counts and at most VOICE_ATTENTION_NAME_LIMIT entries in total, one per
 *   category in turn; "and N more" for the rest (owner decision 2026-10-09).
 * - all / rest / person: every requested item, VOICE_FULL_LIST_PAGE_SIZE
 *   entries at most per answer; a split list says so and how to continue.
 *
 * Failed and empty lines are exactly renderAttentionSummary's, and a partial
 * read always says it may be incomplete. Typed never calls this.
 */
export function buildVoiceAttentionView(
  evidence: AttentionSummaryEvidence,
  request: VoiceAttentionRequest = { kind: "summary" },
  taskWording: ReadonlyMap<string, string> = new Map(),
): VoiceAttentionView {
  const none = { givenIds: [], listRequest: false, remaining: 0, person: null };
  if (!evidence.ok) return { text: renderAttentionSummary(evidence), ...none };
  const partialNote =
    evidence.completeness === "partial" ? "I couldn't check everything just now, so this may be incomplete." : "";
  const withPartial = (lines: string[]) => (partialNote ? [...lines, partialNote] : lines).join(" ");

  if (request.kind === "summary") {
    const named = VOICE_NAMED_CATEGORIES.filter(([category]) => evidence[category].length > 0);
    if (named.length === 0) {
      return {
        text: renderAttentionSummary(evidence),
        ...none,
        shownCaptureIds: evidence.unresolvedCaptures.map((item) => item.id),
      };
    }
    const entries = new Map(named.map(([category]) => [category, voiceEntries(evidence[category], taskWording, true)]));
    const shown = new Map<string, number>(named.map(([category]) => [category, 0]));
    let budget = VOICE_ATTENTION_NAME_LIMIT;
    while (budget > 0 && named.some(([category]) => shown.get(category)! < entries.get(category)!.length)) {
      for (const [category] of named) {
        if (budget === 0) break;
        if (shown.get(category)! < entries.get(category)!.length) {
          shown.set(category, shown.get(category)! + 1);
          budget -= 1;
        }
      }
    }
    const givenIds: string[] = [];
    const lines = [
      evidence.needsYou.length > 0
        ? `Needs your decision: ${evidence.needsYou.map((item) => item.label).join("; ")}.`
        : "Nothing needs your direct decision right now.",
      ...named.map(([category, title]) => {
        const listed = entries.get(category)!.slice(0, shown.get(category)!);
        givenIds.push(...listed.flatMap((entry) => entry.ids));
        const more = evidence[category].length - countIds(listed);
        return `${title} (${evidence[category].length}): ${listed.map((entry) => entry.text).join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
      }),
    ];
    givenIds.push(...evidence.needsYou.map((item) => item.id));
    if (evidence.unresolvedCaptures.length > 0) {
      lines.push(renderAlsoOnYourMindLine(evidence.unresolvedCaptures));
      givenIds.push(...evidence.unresolvedCaptures.map((item) => item.id));
    }
    return {
      text: withPartial(lines),
      ...none,
      givenIds,
      shownCaptureIds: evidence.unresolvedCaptures.map((item) => item.id),
    };
  }

  // An explicit list: all, rest, or person.
  const person = request.kind === "person" ? request.name : request.kind === "rest" ? (request.person ?? null) : null;
  const excluded = new Set(request.kind === "rest" ? (request.previouslyGivenIds ?? []) : []);
  const keep = (item: AttentionItem) =>
    !excluded.has(item.id) && (person === null || (item.assignee ?? "").trim().toLowerCase() === person.trim().toLowerCase());

  const sections: Array<{ title: string | null; entries: VoiceEntry[]; total: number }> = [];
  if (person !== null) {
    const items = VOICE_PERSON_CATEGORIES.flatMap((category) => evidence[category]).filter(keep);
    sections.push({ title: null, entries: voiceEntries(items, taskWording, false), total: items.length });
  } else {
    for (const [category, title] of VOICE_NAMED_CATEGORIES) {
      const items = evidence[category].filter(keep);
      if (items.length > 0) sections.push({ title, entries: voiceEntries(items, taskWording, true), total: items.length });
    }
  }
  const total = sections.reduce((sum, section) => sum + section.total, 0);
  const decisions = person === null ? evidence.needsYou.filter(keep) : [];
  const captures = person === null ? evidence.unresolvedCaptures.filter((item) => !excluded.has(item.id)) : [];
  const continuing = request.kind === "rest" && excluded.size > 0;
  // The app knows what it GAVE the model last time, not what Carson SAID.
  // Those items are listed again, separately, so the model (which can see
  // its own earlier words) can repeat any it did not actually say.
  const inScope = (item: AttentionItem) =>
    person === null || (item.assignee ?? "").trim().toLowerCase() === person.trim().toLowerCase();
  const previouslyGiven = continuing
    ? (person !== null
        ? VOICE_PERSON_CATEGORIES.flatMap((category) => evidence[category])
        : [...evidence.needsYou, ...VOICE_NAMED_CATEGORIES.flatMap(([category]) => evidence[category])]
      ).filter((item) => excluded.has(item.id) && inScope(item))
    : [];
  // "Also on your mind" captures given earlier are re-offered too (whole list only).
  const previouslyGivenCaptures =
    continuing && person === null ? evidence.unresolvedCaptures.filter((item) => excluded.has(item.id)) : [];
  const previousNames = [
    ...voiceEntries(previouslyGiven, taskWording, person === null).map((entry) => entry.text),
    ...previouslyGivenCaptures.map((item) => item.label),
  ];
  const previousLine = previousNames.length > 0 ? `Already given in my last answer: ${previousNames.join("; ")}.` : "";
  const chainIds = continuing ? [...excluded] : [];

  if (person === null && !continuing && total === 0 && decisions.length === 0) {
    return {
      text: renderAttentionSummary(evidence),
      givenIds: [],
      listRequest: true,
      remaining: 0,
      person,
      shownCaptureIds: evidence.unresolvedCaptures.map((item) => item.id),
    };
  }
  if (total === 0 && decisions.length === 0 && captures.length === 0) {
    // "That's everything" only after a complete read; a partial one never claims it.
    const full = evidence.completeness === "full";
    const text =
      person !== null
        ? continuing
          ? full
            ? `Nothing else is open with ${person} beyond my last answer.`
            : `Nothing else came up for ${person} beyond my last answer.`
          : `Nothing is open with ${person} right now.`
        : continuing
          ? full
            ? "Nothing else is open beyond my last answer."
            : "Nothing else came up beyond my last answer."
          : renderAttentionSummary(evidence);
    return {
      text: withPartial(previousLine ? [text, previousLine] : [text]),
      givenIds: chainIds,
      listRequest: true,
      remaining: 0,
      person,
      continuation: previousLine !== "",
    };
  }

  let budget = VOICE_FULL_LIST_PAGE_SIZE;
  let listedCount = 0;
  const givenIds: string[] = [];
  const lines: string[] = [];
  if (continuing) lines.push(person !== null ? `Not in my last answer, open with ${person}:` : "Not in my last answer:");
  if (person === null) {
    if (decisions.length > 0) {
      lines.push(`Needs your decision: ${decisions.map((item) => item.label).join("; ")}.`);
      givenIds.push(...decisions.map((item) => item.id));
    } else if (!continuing) {
      lines.push("Nothing needs your direct decision right now.");
    }
  }
  for (const section of sections) {
    if (budget === 0) break;
    const listed = section.entries.slice(0, budget);
    budget -= listed.length;
    listedCount += countIds(listed);
    givenIds.push(...listed.flatMap((entry) => entry.ids));
    const names = listed.map((entry) => entry.text).join("; ");
    lines.push(
      section.title === null
        ? `${continuing ? "" : `Open with ${person} (${section.total}): `}${names}.`
        : `${section.title} (${section.total}): ${names}.`,
    );
  }
  const remaining = total - listedCount;
  if (remaining > 0) {
    lines.push(`That's ${listedCount} of ${total}${continuing ? " left" : ""}; ${remaining} more after these. Say "continue" for the rest.`);
  } else if (captures.length > 0) {
    lines.push(renderAlsoOnYourMindLine(captures));
    givenIds.push(...captures.map((item) => item.id));
  }
  if (previousLine) lines.push(previousLine);
  return {
    text: withPartial(lines),
    givenIds: [...new Set([...chainIds, ...givenIds])],
    listRequest: true,
    remaining,
    person,
    continuation: previousLine !== "",
    shownCaptureIds: remaining === 0 ? captures.map((item) => item.id) : [],
  };
}

/** Text-only form, kept for callers that need only the words. */
export function renderVoiceAttentionSummary(
  evidence: AttentionSummaryEvidence,
  request: VoiceAttentionRequest = { kind: "summary" },
  taskWording: ReadonlyMap<string, string> = new Map(),
): string {
  return buildVoiceAttentionView(evidence, request, taskWording).text;
}

function openAssignees(evidence: AttentionSummaryEvidence): string[] {
  if (!evidence.ok) return [];
  const names = VOICE_PERSON_CATEGORIES.flatMap((category) => evidence[category])
    .map((item) => (item.assignee ?? "").trim())
    .filter(Boolean);
  return [...new Set(names)];
}

const ATTENTION_READ_FAILED_TEXT =
  "I couldn't check what needs your attention right now — the live check didn't complete.";

// renderAttentionSummary renders every unresolvedCaptures item of an ok
// evidence object ("Also on your mind: …") and none of a failed one.
function renderedCaptureIds(evidence: AttentionSummaryEvidence): AttentionCaptureRef[] {
  if (!evidence.ok) return [];
  return evidence.unresolvedCaptures
    .filter((item) => item.type === "note" || item.type === "todo")
    .map((item) => ({ id: item.id, kind: item.type as "note" | "todo" }));
}

export async function fetchAttentionPresentation(): Promise<AttentionPresentation> {
  try {
    const evidence = await fetchAttentionEvidence();
    return { text: renderAttentionSummary(evidence), captureIds: renderedCaptureIds(evidence) };
  } catch {
    return { text: ATTENTION_READ_FAILED_TEXT, captureIds: [] };
  }
}

/**
 * How the voice model must use a view (P3 Step 3 / S3). Guidance only: the
 * model is not bound by it, and a background note may not arrive before it
 * speaks. A failed read gets none, so nothing is ever called complete.
 */
export function voiceAttentionUseNote(evidence: AttentionSummaryEvidence, view: VoiceAttentionView): string {
  if (!evidence.ok) return "";
  const notes: string[] = [];
  if (view.listRequest && view.continuation) {
    notes.push(
      "Say the items not in your last answer by name, in this wording. The app cannot tell what you actually said aloud: " +
        'if your last answer did not name every item under "Already given in my last answer", name those too.',
    );
  }
  if (view.listRequest && view.remaining > 0) {
    notes.push(
      `The owner asked for the items themselves: say every item above by name, in this wording, then say there are ${view.remaining} more and that they can say "continue".`,
    );
  } else if (view.listRequest) {
    notes.push(
      'The owner asked for the items themselves: say every item above by name, in this wording. Do not shorten it to "and N more" or "among others".',
    );
  }
  if (evidence.completeness !== "full") {
    notes.push("This live check was incomplete: say the list may be incomplete and never call it everything.");
  }
  return notes.length > 0 ? `[For Carson: ${notes.join(" ")}]` : "";
}

/**
 * P3 Step 3 / S3 — the legacy voice attention read: a fresh, owner-scoped
 * attention read on every call (never the session-start list), rendered by
 * buildVoiceAttentionView. A person view shows no captures, so it marks none.
 */
export async function fetchVoiceAttentionPresentation(
  request: VoiceAttentionRequest = { kind: "summary" },
): Promise<AttentionPresentation> {
  try {
    const { evidence, taskWording } = await readAttentionEvidence();
    const view = buildVoiceAttentionView(evidence, request, taskWording);
    const useNote = voiceAttentionUseNote(evidence, view);
    const person = request.kind === "person" ? request.name : view.person;
    return {
      text: view.text,
      // Only the captures this answer's text shows (voice never marks them; S2).
      captureIds: renderedCaptureIds(evidence).filter((capture) => (view.shownCaptureIds ?? []).includes(capture.id)),
      assignees: openAssignees(evidence),
      evidenceOk: evidence.ok,
      modelText: useNote ? `${view.text} ${useNote}` : view.text,
      contextNote: !evidence.ok
        ? undefined
        : person !== null
          ? `[Live attention check: ${person} only] ${view.text} This covers only ${person}'s open items, not everything that is open.${useNote ? ` ${useNote}` : ""}`
          : `[Live attention check] ${view.text} ` +
            "Use only this live result for which items are open, and for their names and counts. " +
            `The OPEN list given at the start of this session may be out of date.${useNote ? ` ${useNote}` : ""}`,
      page: evidence.ok ? { givenIds: view.givenIds, person: view.person, remaining: view.remaining } : undefined,
    };
  } catch {
    return { text: ATTENTION_READ_FAILED_TEXT, captureIds: [] };
  }
}

export async function fetchAttentionSummary(): Promise<string> {
  return (await fetchAttentionPresentation()).text;
}

/**
 * Records that these captures reached the owner. Call only at the
 * owner-visible presentation boundary, with exactly the captures that
 * presentation showed. Best-effort: a failed write never affects the answer.
 */
export function markAttentionCapturesSurfaced(captureIds: AttentionCaptureRef[]): void {
  const noteIds = captureIds.filter((c) => c.kind === "note").map((c) => c.id);
  const todoIds = captureIds.filter((c) => c.kind === "todo").map((c) => c.id);
  if (noteIds.length > 0) markCarsonNotesSurfaced(noteIds).catch(() => {});
  if (todoIds.length > 0) markCarsonTodosSurfaced(todoIds).catch(() => {});
}
