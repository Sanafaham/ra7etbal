export const ACCOUNT_DELETION_BLOCK_CODE = 'account_deletion_in_progress';

const FROZEN_STATUSES = new Set([
  'in_progress',
  'failed_retryable',
  'failed_requires_review',
]);

const SERVICE_HEADERS = (serviceKey) => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
});

/**
 * The single server-side read contract for the Slice A freeze. A failed state
 * read is a denial, never permission to perform an external side effect.
 */
export async function checkAccountConsequentialAccess({
  supabaseUrl,
  serviceKey,
  userId,
  fetchImpl = fetch,
}) {
  if (!supabaseUrl || !serviceKey || !userId) {
    return { allowed: false, code: 'account_state_unavailable' };
  }
  try {
    const response = await fetchImpl(
      `${supabaseUrl}/rest/v1/account_deletion_requests` +
        `?user_id=eq.${encodeURIComponent(userId)}` +
        `&status=in.(in_progress,failed_retryable,failed_requires_review)` +
        `&select=status&limit=1`,
      { headers: SERVICE_HEADERS(serviceKey) },
    );
    if (!response.ok) return { allowed: false, code: 'account_state_unavailable' };
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) return { allowed: false, code: 'account_state_unavailable' };
    const status = rows[0]?.status ?? null;
    if (FROZEN_STATUSES.has(status)) {
      return { allowed: false, code: ACCOUNT_DELETION_BLOCK_CODE, status };
    }
    return { allowed: true, code: 'allowed' };
  } catch {
    return { allowed: false, code: 'account_state_unavailable' };
  }
}

export async function assertAccountMayExecuteConsequentialAction(options) {
  const result = await checkAccountConsequentialAccess(options);
  if (!result.allowed) {
    const error = new Error(result.code);
    error.code = result.code;
    error.accountDeletionStatus = result.status ?? null;
    throw error;
  }
}

export function accountDeletionBlockedResponse(res, shape = 'default') {
  const payload = shape === 'calendar'
    ? { ok: false, code: ACCOUNT_DELETION_BLOCK_CODE, error: 'Account deletion is in progress. New actions are unavailable.' }
    : { success: false, code: ACCOUNT_DELETION_BLOCK_CODE, error: 'Account deletion is in progress. New actions are unavailable.' };
  return res.status(409).json(payload);
}

const REFERENCE_TABLES = [
  ['taskId', 'tasks'],
  ['messageRecordId', 'messages'],
  ['routineId', 'routines'],
  ['automationRunId', 'automation_runs'],
  ['personId', 'people'],
];

/** Resolve internal-call ownership only from existing server-side records. */
export async function resolveConsequentialOwnerFromReferences({
  supabaseUrl,
  serviceKey,
  references,
  fetchImpl = fetch,
}) {
  const owners = new Set();
  for (const [field, table] of REFERENCE_TABLES) {
    const id = references?.[field];
    if (!id) continue;
    const response = await fetchImpl(
      `${supabaseUrl}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=user_id&limit=1`,
      { headers: SERVICE_HEADERS(serviceKey) },
    ).catch(() => null);
    if (!response?.ok) return null;
    const rows = await response.json().catch(() => null);
    const owner = Array.isArray(rows) ? rows[0]?.user_id : null;
    if (!owner) return null;
    owners.add(owner);
  }
  return owners.size === 1 ? [...owners][0] : null;
}
