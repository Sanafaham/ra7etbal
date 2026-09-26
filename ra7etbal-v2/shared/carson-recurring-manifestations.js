/**
 * Server/browser-safe recurring-manifestation source resolution and derived
 * supersession — P3 5b.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * A recurring source (an automation or a routine) creates one new
 * `tasks` row every time it fires. Nothing ever closes those rows: closure
 * depends on an owner confirmation that, for owner-only recurring reminders,
 * never happens. They accrue at a fixed rate per day with zero attrition, and
 * because every operational surface reads pending tasks newest-first, the
 * stale history crowds out the owner's genuine responsibilities. Measured in
 * Production on 2026-09-26: 143 pending rows, of which 133 were recurring
 * manifestations of just five daily sources, leaving all 10 genuine
 * responsibilities outside the bounded 15-row operational window.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Answers exactly one question per task, with no I/O and no writes:
 *
 *   "Which recurring source produced this task, and is it that source's
 *    CURRENT manifestation or a superseded historical one?"
 *
 * A recurring manifestation is CURRENT only when no strictly newer unresolved
 * manifestation from the same recurring source exists for the same user.
 *
 * Supersession is DERIVED ONLY. Nothing here writes, and callers must not turn
 * a derived `superseded` into a stored fact: it never means done, confirmed,
 * dismissed, archived or deleted. The historical rows stay exactly as they
 * are and remain fully visible to history surfaces.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It does not decide whether a CURRENT manifestation is worth telling the
 * owner about. That is each consuming surface's own pre-existing rule — for
 * example Morning Brief's and the attention summary's `routineAutomationTaskIds`
 * exclusion, which suppresses tasks linked to an open automation run and is
 * stricter than supersession. Those rules are unchanged and run downstream of
 * this one. CURRENT-ness and briefing-worthiness are separate questions, and
 * keeping them separate is what stops this from becoming a second, competing
 * definition of either.
 *
 * SOURCE IDENTITY
 * ---------------
 * Automation-backed: the authoritative `automation_runs.task_id ->
 * automation_runs.automation_id` relationship. The run row is inserted with
 * its `automation_id` before any task, push or message exists, and
 * `automation_id` is `NOT NULL` with a foreign key, so identity is written at
 * birth and cannot be null, malformed or invented. A notification's
 * `metadata.automation_id`, where one exists, is corroborating evidence only.
 *
 * Routine-backed: `owner_notifications.target_id -> metadata.routine_id`.
 * Routines create no run record, so this is the only relationship available.
 *
 * Task title and description are never used as identity. Two manifestations of
 * the same source share their text, which is exactly why text is worthless as
 * a key: it cannot distinguish a recurrence from two genuinely separate
 * obligations that happen to read alike.
 *
 * FAIL-SAFE
 * ---------
 * Every path that cannot establish a single trustworthy source resolves to
 * `unresolved` or `ambiguous`, and an unresolved or ambiguous task is NEVER
 * superseded — it stays visible. The cost of being wrong in that direction is
 * a cluttered list; the cost of being wrong in the other direction is hiding
 * real work the owner is accountable for. Truthfulness beats tidiness.
 */

/** A task's source could not be tied to any recurring source. Not recurring, or evidence missing. */
export const RESOLUTION_UNRESOLVED = "unresolved";
/** Two authoritative signals disagree, or two channels both claim the task. Never superseded. */
export const RESOLUTION_AMBIGUOUS = "ambiguous";
/** Exactly one trustworthy recurring source. Eligible for supersession. */
export const RESOLUTION_RESOLVED = "resolved";

/**
 * Build the automation-backed source index from `automation_runs` rows.
 *
 * Accepts runs in ANY `current_state`, deliberately. A failed run still names
 * the source that produced its task — identity and execution outcome are
 * different columns on the same row. Narrowing this read to "successful" states
 * would make a task's recurring identity depend on whether its delivery worked,
 * which is how the 2026-09-13 orphan (a `failed` run whose owner push never
 * landed, so no notification row was ever written) became unresolvable under a
 * notifications-only design.
 *
 * A task claimed by more than one distinct automation is ambiguous, not
 * arbitrated.
 */
export function indexAutomationSourceLinks(runRows) {
  /** @type {Map<string, { automationId: string | null, userId: string | null, conflict: boolean }>} */
  const byTask = new Map();

  for (const row of runRows ?? []) {
    const taskId = row?.task_id;
    const automationId = row?.automation_id;
    if (!taskId || !automationId) continue;

    const existing = byTask.get(taskId);
    if (!existing) {
      byTask.set(taskId, {
        automationId,
        userId: row?.user_id ?? null,
        conflict: false,
      });
      continue;
    }
    // Several run rows for one task are fine as long as they agree on the
    // source. Only a genuine disagreement is a conflict.
    if (existing.automationId !== automationId) existing.conflict = true;
  }

  return byTask;
}

/**
 * Build the routine-backed source index from `owner_notifications` rows.
 *
 * Only `routine_reminder` notifications carry routine provenance; any other
 * kind mentioning a routine is not a manifestation record and is ignored. A
 * task whose notifications name two different routines is ambiguous.
 */
export function indexRoutineSourceLinks(notificationRows) {
  /** @type {Map<string, { routineId: string | null, userId: string | null, conflict: boolean }>} */
  const byTask = new Map();

  for (const row of notificationRows ?? []) {
    const taskId = row?.target_id;
    if (!taskId) continue;
    if (row?.kind !== "routine_reminder") continue;

    const routineId = readRoutineId(row?.metadata);
    if (!routineId) continue;

    const existing = byTask.get(taskId);
    if (!existing) {
      byTask.set(taskId, {
        routineId,
        userId: row?.user_id ?? null,
        conflict: false,
      });
      continue;
    }
    if (existing.routineId !== routineId) existing.conflict = true;
  }

  return byTask;
}

/**
 * Corroborating automation ids a task's notifications claim, keyed by task id.
 *
 * Used only to detect disagreement with the authoritative run relationship.
 * Absence of a notification is NOT disagreement — see the 2026-09-13 orphan.
 */
export function indexNotificationAutomationClaims(notificationRows) {
  /** @type {Map<string, Set<string>>} */
  const byTask = new Map();

  for (const row of notificationRows ?? []) {
    const taskId = row?.target_id;
    if (!taskId) continue;
    const automationId = readAutomationId(row?.metadata);
    if (!automationId) continue;

    const existing = byTask.get(taskId);
    if (existing) existing.add(automationId);
    else byTask.set(taskId, new Set([automationId]));
  }

  return byTask;
}

/**
 * Resolve one task's recurring source.
 *
 * @returns {{ sourceKey: string | null, resolution: string }}
 */
export function resolveRecurringSource(task, indexes) {
  const taskId = task?.id;
  if (!taskId) return { sourceKey: null, resolution: RESOLUTION_UNRESOLVED };

  const automationLink = indexes?.automationLinks?.get(taskId) ?? null;
  const routineLink = indexes?.routineLinks?.get(taskId) ?? null;

  // Two channels both claiming one task should be impossible: routines create
  // no run record. If it ever happens, one of the two writers is wrong and
  // neither may be silently trusted.
  if (automationLink && routineLink) {
    return { sourceKey: null, resolution: RESOLUTION_AMBIGUOUS };
  }

  if (automationLink) {
    if (automationLink.conflict) {
      return { sourceKey: null, resolution: RESOLUTION_AMBIGUOUS };
    }
    // Tenant agreement between the run and the task it claims.
    if (!tenantAgrees(automationLink.userId, task?.user_id)) {
      return { sourceKey: null, resolution: RESOLUTION_AMBIGUOUS };
    }
    // Corroboration check. Only a present-and-different claim is a
    // disagreement; a missing claim is not.
    const claims = indexes?.notificationAutomationClaims?.get(taskId) ?? null;
    if (claims && claims.size > 0 && !claimsAgreeWith(claims, automationLink.automationId)) {
      return { sourceKey: null, resolution: RESOLUTION_AMBIGUOUS };
    }
    return {
      sourceKey: `automation:${automationLink.automationId}`,
      resolution: RESOLUTION_RESOLVED,
    };
  }

  if (routineLink) {
    if (routineLink.conflict) {
      return { sourceKey: null, resolution: RESOLUTION_AMBIGUOUS };
    }
    if (!tenantAgrees(routineLink.userId, task?.user_id)) {
      return { sourceKey: null, resolution: RESOLUTION_AMBIGUOUS };
    }
    return {
      sourceKey: `routine:${routineLink.routineId}`,
      resolution: RESOLUTION_RESOLVED,
    };
  }

  return { sourceKey: null, resolution: RESOLUTION_UNRESOLVED };
}

/**
 * Derive recurring-source identity and CURRENT-ness for a task list.
 *
 * Pure: reads the tasks and the indexes, returns a new Map, writes nothing and
 * mutates neither its arguments nor the task objects.
 *
 * Only unresolved-at-rest tasks take part. A task that is already done,
 * cancelled, dismissed or archived is finished history and neither supersedes
 * anything nor needs superseding — which also keeps a genuine owner
 * confirmation, if one ever arrives, from being reinterpreted here.
 *
 * @returns {Map<string, { sourceKey: string | null, resolution: string, isCurrent: boolean }>}
 */
export function deriveRecurringManifestationState(tasks, indexes) {
  const list = tasks ?? [];

  /** @type {Map<string, { sourceKey: string | null, resolution: string, isCurrent: boolean }>} */
  const state = new Map();
  /** Newest createdAt seen per `${userId}\u0000${sourceKey}`. */
  const newestBySource = new Map();

  const resolvedEntries = [];

  for (const task of list) {
    if (!task?.id) continue;

    const eligible = isSupersessionCandidate(task);
    const { sourceKey, resolution } = eligible
      ? resolveRecurringSource(task, indexes)
      : { sourceKey: null, resolution: RESOLUTION_UNRESOLVED };

    // Default every task to CURRENT. Supersession is only ever subtracted
    // below, and only from a task with a single trustworthy source — so any
    // gap in evidence leaves the task visible.
    state.set(task.id, { sourceKey, resolution, isCurrent: true });

    if (resolution !== RESOLUTION_RESOLVED || !sourceKey) continue;

    const createdAtMs = toTimeMs(task.created_at);
    if (createdAtMs === null) continue; // unusable timestamp — cannot order, so never supersede

    const groupKey = `${task.user_id ?? ""}\u0000${sourceKey}`;
    resolvedEntries.push({ taskId: task.id, groupKey, createdAtMs });

    const newest = newestBySource.get(groupKey);
    if (newest === undefined || createdAtMs > newest) {
      newestBySource.set(groupKey, createdAtMs);
    }
  }

  for (const entry of resolvedEntries) {
    const newest = newestBySource.get(entry.groupKey);
    // Strictly newer only. An exact tie leaves both CURRENT rather than
    // picking one arbitrarily.
    if (newest !== undefined && entry.createdAtMs < newest) {
      const current = state.get(entry.taskId);
      if (current) current.isCurrent = false;
    }
  }

  return state;
}

/**
 * Task ids that are superseded historical manifestations of a recurring source.
 *
 * This is the set operational surfaces subtract from their input membership.
 */
export function collectSupersededManifestationIds(tasks, indexes) {
  const state = deriveRecurringManifestationState(tasks, indexes);
  const ids = new Set();
  for (const [taskId, entry] of state) {
    if (!entry.isCurrent) ids.add(taskId);
  }
  return ids;
}

/**
 * Drop superseded historical manifestations from a task list, preserving order.
 *
 * Returns the same array instance when nothing is superseded, so a caller with
 * no recurring history pays nothing and cannot observe a behavior change.
 */
export function withoutSupersededManifestations(tasks, supersededIds) {
  if (!supersededIds || supersededIds.size === 0) return tasks ?? [];
  return (tasks ?? []).filter((t) => !(t?.id && supersededIds.has(t.id)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a task is unresolved at rest, and therefore part of the current
 * operational picture that supersession reasons about.
 */
function isSupersessionCandidate(task) {
  if (task?.archived_at != null) return false;
  if (task?.dismissed_at != null) return false;
  if (task?.status !== "pending") return false;
  return true;
}

function tenantAgrees(linkUserId, taskUserId) {
  // A link that carries no user id cannot contradict the task. Both indexes
  // are built from owner-scoped reads under RLS, so a missing value means the
  // column was not projected, not that the row belongs to someone else.
  if (linkUserId == null || taskUserId == null) return true;
  return linkUserId === taskUserId;
}

function claimsAgreeWith(claims, automationId) {
  if (claims.size !== 1) return false;
  return claims.has(automationId);
}

function readRoutineId(metadata) {
  const value = readMetadataString(metadata, "routine_id");
  return value;
}

function readAutomationId(metadata) {
  return readMetadataString(metadata, "automation_id");
}

function readMetadataString(metadata, key) {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = metadata[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toTimeMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
