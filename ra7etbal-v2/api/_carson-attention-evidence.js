/**
 * Server-side evidence retrieval for the attention_summary_read capability
 * (Second Brain typed hard-grounding slice, 2026-08-28).
 *
 * Ports the exact same PostgREST queries src/lib/tasks.ts, staff-messages.ts,
 * carson-notes.ts, carson-todos.ts, and automation-context.ts's
 * routineAutomationTaskIds slice already use — no new query shape, no new
 * table, no broadened data model. The only genuine difference from the
 * browser path is HOW the request authenticates: here it's a per-request
 * fetch call authorized with the caller's own verified JWT (apikey = anon
 * key, Authorization = the caller's own Bearer token) so PostgREST executes
 * — and RLS scopes — exactly as it would for the authenticated browser
 * client. Never the service-role key; never a caller-supplied account id
 * used for filtering (accountId here is for logging/dedup only — every
 * actual row-scoping decision is left to RLS via the JWT).
 *
 * Business classification (what counts as needsAttention/overdue/waiting,
 * which captures are attention-worthy, how the final evidence/text is
 * composed) is NOT reimplemented here — it all comes from shared/, the
 * exact same functions src/lib/carson-operations-center.ts calls.
 */

import { buildMorningBrief } from "../shared/carson-morning-brief-classifier.js";
import { composeAttentionEvidence, renderAttentionSummary } from "../shared/carson-attention-summary.js";
import { noteToCapture, todoToCapture } from "../shared/carson-unresolved-captures-classifier.js";
import { isSupportedOperationalAutomation } from "../shared/automation-support-classifier.js";

// Mirrors carson-operations-center.ts's ATTENTION_SOURCE_TIMEOUT_MS. A
// literal duplicate of a tuning constant, not a business rule — see that
// file's own comment for the 2026-08-25 incident this guards against.
const ATTENTION_SOURCE_TIMEOUT_MS = 8_000;

function withTimeout(promise, ms = ATTENTION_SOURCE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
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

/**
 * Minimal PostgREST GET helper, authorized as the caller's own JWT (never
 * service-role) — same shape as api/carson-turn.js's own auth pattern, just
 * for data reads instead of /auth/v1/user. Throws on a non-2xx response so
 * callers' existing try/catch-per-source semantics apply unchanged.
 */
async function restGet({ supabaseUrl, anonKey, authorization, table, query }) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
    headers: { apikey: anonKey, Authorization: authorization },
  });
  if (!response.ok) throw new Error(`${table} read failed (${response.status})`);
  const rows = await response.json().catch(() => null);
  return Array.isArray(rows) ? rows : [];
}

const TASKS_COLUMNS =
  "id,user_id,description,type,assigned_to,status,needs_follow_up,confirmation_url,confirmed_at,due_at,dismissed_at,archived_at,created_at,qstash_message_id,followup_sent_at,escalated_at,image_path,proof_image_path,quality_review_status,quality_review_note,quality_reviewed_at,worker_reply";

async function fetchTasks(ctx) {
  return restGet({
    ...ctx,
    table: "tasks",
    query: `select=${TASKS_COLUMNS}&archived_at=is.null&order=created_at.desc`,
  });
}

const OPEN_ESCALATION_COLUMNS =
  "id,staff_name,inbound_text,escalation_reason,received_at,task_id,escalation_resolved_at,owner_attention_required,user_facing_state,decision:staff_escalation_owner_decisions(id,status,deep_link_token)";

async function fetchOpenStaffEscalations(ctx) {
  const rows = await restGet({
    ...ctx,
    table: "staff_messages",
    query: `select=${OPEN_ESCALATION_COLUMNS}&escalation_resolved_at=is.null&order=received_at.desc`,
  });

  // Same filtering as src/lib/staff-messages.ts's listOpenStaffEscalationsForNeedsYou().
  const result = [];
  for (const row of rows) {
    const needsOwner = row.owner_attention_required || row.user_facing_state === "Needs You";
    if (!needsOwner) continue;
    const decision = Array.isArray(row.decision) ? row.decision[0] : row.decision;
    if (!decision) continue;
    if (decision.status !== "open" && decision.status !== "failed") continue;
    result.push({
      id: row.id,
      staffName: row.staff_name,
      inboundText: row.inbound_text,
      escalationReason: row.escalation_reason,
      receivedAt: row.received_at,
      taskId: row.task_id,
      decisionId: decision.id,
      deepLinkToken: decision.deep_link_token,
    });
  }
  return result;
}

async function fetchUnresolvedCaptureCandidates(ctx, now) {
  const [notes, todos] = await Promise.all([
    restGet({
      ...ctx,
      table: "carson_notes",
      query:
        "select=id,note,category,source,created_at,updated_at,dismissed_at,last_surfaced_at&dismissed_at=is.null&order=created_at.desc&limit=50",
    }),
    restGet({
      ...ctx,
      table: "carson_todos",
      query:
        "select=id,title,description,status,source,created_at,updated_at,completed_at,last_surfaced_at&status=eq.active&order=created_at.desc&limit=50",
    }),
  ]);
  return [
    ...notes.map((n) => noteToCapture(n, now)),
    ...todos.map((t) => todoToCapture(t, now)),
  ];
}

/**
 * Best-effort, non-blocking — mirrors markCarsonNotesSurfaced()/
 * markCarsonTodosSurfaced()'s exact contract: a failed write here must
 * never fail or delay the read the caller is waiting on.
 */
async function markSurfaced(ctx, table, ids) {
  if (ids.length === 0) return;
  try {
    await fetch(
      `${ctx.supabaseUrl}/rest/v1/${table}?id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})`,
      {
        method: "PATCH",
        headers: {
          apikey: ctx.anonKey,
          Authorization: ctx.authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ last_surfaced_at: new Date().toISOString() }),
      },
    );
  } catch {
    // Best-effort — see doc comment above.
  }
}

async function fetchRoutineAutomationTaskIds(ctx) {
  const rows = await restGet({
    ...ctx,
    table: "automation_runs",
    query:
      "select=task_id,automations!inner(automation_type,assignee_id,cadence_type,status)&current_state=in.(sent,followup_sent)&task_id=not.is.null",
  });
  const ids = rows
    .filter((r) => r.automations && isSupportedOperationalAutomation(r.automations))
    .filter((r) => r.automations?.automation_type !== "message")
    .map((r) => r.task_id)
    .filter(Boolean);
  return new Set(ids);
}

/**
 * Server-side equivalent of src/lib/carson-operations-center.ts's
 * fetchAttentionEvidence(). Same per-source concurrency/timeout/partial-
 * failure semantics; same shared composition — see that file's own header
 * comment for the full rationale.
 */
export async function fetchAttentionEvidenceForServer({ supabaseUrl, anonKey, authorization }) {
  const generatedAt = new Date().toISOString();
  const now = new Date();
  const ctx = { supabaseUrl, anonKey, authorization };

  const tasksPromise = withTimeout(fetchTasks(ctx));
  const needsYouPromise = withTimeout(fetchOpenStaffEscalations(ctx));
  const capturesPromise = withTimeout(fetchUnresolvedCaptureCandidates(ctx, now));
  // Never throws (mirrors fetchAutomationDigest()'s own contract) — a
  // failed automation-runs read degrades to "no routine exclusions" rather
  // than failing the whole attention read.
  const routineIdsPromise = withTimeout(fetchRoutineAutomationTaskIds(ctx)).catch(() => new Set());

  let tasks = null;
  let tasksFailed = false;
  try {
    tasks = await tasksPromise;
  } catch {
    tasksFailed = true;
  }

  let needsYou = null;
  let needsYouFailed = false;
  try {
    needsYou = await needsYouPromise;
  } catch {
    needsYouFailed = true;
  }

  let captureCandidates = null;
  let capturesFailed = false;
  try {
    captureCandidates = await capturesPromise;
  } catch {
    capturesFailed = true;
  }

  const routineAutomationTaskIds = await routineIdsPromise;

  const brief = tasks ? buildMorningBrief(tasks, [], now, routineAutomationTaskIds) : null;

  const evidence = composeAttentionEvidence({
    generatedAt,
    brief,
    tasksFailed,
    needsYou,
    needsYouFailed,
    captureCandidates,
    capturesFailed,
  });

  // Same "only mark what was truly surfaced" contract as the browser path
  // (see carson-operations-center.ts) — best-effort, never blocks the read.
  if (evidence.selectedCaptureIds && evidence.selectedCaptureIds.length > 0) {
    const noteIds = evidence.selectedCaptureIds.filter((c) => c.kind === "note").map((c) => c.id);
    const todoIds = evidence.selectedCaptureIds.filter((c) => c.kind === "todo").map((c) => c.id);
    if (noteIds.length > 0) markSurfaced(ctx, "carson_notes", noteIds).catch(() => {});
    if (todoIds.length > 0) markSurfaced(ctx, "carson_todos", todoIds).catch(() => {});
  }

  return evidence;
}

export async function fetchAttentionSummaryForServer(ctx) {
  try {
    const evidence = await fetchAttentionEvidenceForServer(ctx);
    return { evidence, text: renderAttentionSummary(evidence) };
  } catch {
    const generatedAt = new Date().toISOString();
    const evidence = {
      ok: false,
      code: "attention_read_failed",
      generatedAt,
      completeness: "none",
      needsAttention: [],
      waiting: [],
      carsonCanHandle: [],
      safeToIgnore: [],
      unresolvedCaptures: [],
    };
    return { evidence, text: renderAttentionSummary(evidence) };
  }
}
