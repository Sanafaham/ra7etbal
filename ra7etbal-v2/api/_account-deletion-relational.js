const headers = (serviceKey) => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
});

async function rpc({ supabaseUrl, serviceKey, name, body, fetchImpl }) {
  return fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: headers(serviceKey), body: JSON.stringify(body),
  });
}

/** Process at most one atomic Slice C deletion transaction per scheduler run. */
export async function processAccountDeletionRelational({
  supabaseUrl, serviceKey, fetchImpl = fetch,
}) {
  const result = { claimed: 0, completed: 0, failed: 0 };
  if (!supabaseUrl || !serviceKey) return result;

  const claim = await rpc({
    supabaseUrl, serviceKey, name: 'claim_account_deletion_relational',
    body: { p_lease_seconds: 120 }, fetchImpl,
  }).catch(() => null);
  if (!claim?.ok) return result;
  const rows = await claim.json().catch(() => []);
  const work = Array.isArray(rows) ? rows[0] : null;
  if (!work?.request_id || !work?.lease_token) return result;
  result.claimed = 1;

  try {
    const execution = await rpc({
      supabaseUrl, serviceKey, name: 'execute_account_deletion_relational',
      body: { p_request_id: work.request_id, p_lease_token: work.lease_token }, fetchImpl,
    });
    if (execution.ok && await execution.json().catch(() => false) === true) {
      result.completed = 1;
      return result;
    }
  } catch {
    // The separate failure transition releases the lease for a safe retry.
  }

  result.failed = 1;
  await rpc({
    supabaseUrl, serviceKey, name: 'fail_account_deletion_relational',
    body: {
      p_request_id: work.request_id,
      p_lease_token: work.lease_token,
      p_failure_code: 'relational_execution_failed',
      p_requires_review: false,
    },
    fetchImpl,
  }).catch(() => null);
  return result;
}
