const CONFIRMABLE_RUN_STATES = [
  'task_created',
  'sent',
  'followup_sent',
  'escalated',
  'failed',
];

const PROTECTED_RUN_STATES = new Set(['skipped', 'confirmed', 'completed']);

function serviceHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Projects an already-canonical task confirmation onto its linked automation
 * run. The task remains the authority: this helper never confirms a task and
 * never invents a timestamp.
 */
export async function synchronizeAutomationRunFromConfirmedTask({
  supabaseUrl,
  serviceKey,
  task,
}) {
  if (!task?.id || !task?.user_id || task.status !== 'done' || !task.confirmed_at) {
    return { synchronized: false, reason: 'task_not_canonically_confirmed' };
  }

  const headers = serviceHeaders(serviceKey);
  const lookupRes = await fetch(
    `${supabaseUrl}/rest/v1/automation_runs` +
      `?task_id=eq.${encodeURIComponent(task.id)}` +
      `&user_id=eq.${encodeURIComponent(task.user_id)}` +
      `&select=id,user_id,task_id,current_state,confirmed_at,failure_reason` +
      `&limit=2`,
    { headers },
  );
  const runs = await lookupRes.json().catch(() => []);

  if (!lookupRes.ok) {
    throw new Error(`automation_run lookup failed (${lookupRes.status})`);
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return { synchronized: false, reason: 'not_an_automation_task' };
  }
  if (runs.length !== 1) {
    console.error('[automation-confirmation-sync] multiple runs linked to one confirmed task; failing closed', {
      taskId: task.id,
      userId: task.user_id,
      matchCount: runs.length,
    });
    return { synchronized: false, reason: 'multiple_matching_runs' };
  }

  const run = runs[0];
  if (PROTECTED_RUN_STATES.has(run.current_state)) {
    return {
      synchronized: false,
      reason: run.current_state === 'confirmed' ? 'already_confirmed' : 'protected_terminal_state',
      runId: run.id,
    };
  }
  if (!CONFIRMABLE_RUN_STATES.includes(run.current_state)) {
    return { synchronized: false, reason: 'source_state_not_confirmable', runId: run.id };
  }

  const stateFilter = CONFIRMABLE_RUN_STATES.map(encodeURIComponent).join(',');
  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/automation_runs` +
      `?id=eq.${encodeURIComponent(run.id)}` +
      `&task_id=eq.${encodeURIComponent(task.id)}` +
      `&user_id=eq.${encodeURIComponent(task.user_id)}` +
      `&current_state=in.(${stateFilter})`,
    {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        current_state: 'confirmed',
        confirmed_at: task.confirmed_at,
      }),
    },
  );
  const updated = await patchRes.json().catch(() => []);

  if (!patchRes.ok) {
    throw new Error(`automation_run confirmation patch failed (${patchRes.status})`);
  }

  return {
    synchronized: Array.isArray(updated) && updated.length === 1,
    reason: Array.isArray(updated) && updated.length === 1 ? 'confirmed' : 'concurrent_noop',
    runId: run.id,
  };
}

/**
 * Resolves the canonical task after a concurrent/idempotent confirmation path
 * where the current request did not itself own the pending -> done transition.
 */
export async function loadCanonicalConfirmedTask({
  supabaseUrl,
  serviceKey,
  taskId,
  userId,
}) {
  if (!taskId || !userId) return null;

  const headers = serviceHeaders(serviceKey);
  const res = await fetch(
    `${supabaseUrl}/rest/v1/tasks` +
      `?id=eq.${encodeURIComponent(taskId)}` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&status=eq.done` +
      `&confirmed_at=not.is.null` +
      `&select=id,user_id,status,confirmed_at` +
      `&limit=1`,
    { headers },
  );
  const rows = await res.json().catch(() => []);
  if (!res.ok) {
    throw new Error(`confirmed task reload failed (${res.status})`);
  }
  if (!Array.isArray(rows) || rows.length !== 1) return null;

  const task = rows[0];
  const evidenceRes = await fetch(
    `${supabaseUrl}/rest/v1/confirmations` +
      `?task_id=eq.${encodeURIComponent(task.id)}` +
      `&confirmed_at=eq.${encodeURIComponent(task.confirmed_at)}` +
      `&select=id,task_id,confirmed_at` +
      `&limit=1`,
    { headers },
  );
  const evidenceRows = await evidenceRes.json().catch(() => []);
  if (!evidenceRes.ok) {
    throw new Error(`confirmation evidence lookup failed (${evidenceRes.status})`);
  }

  if (!Array.isArray(evidenceRows) || evidenceRows.length !== 1) return null;
  const evidence = evidenceRows[0];
  return evidence?.task_id === task.id && evidence?.confirmed_at === task.confirmed_at
    ? task
    : null;
}
