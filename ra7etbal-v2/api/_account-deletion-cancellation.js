const serviceHeaders = (serviceKey) => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
});

async function finish({ supabaseUrl, serviceKey, id, leaseToken, outcome, failureCode, fetchImpl }) {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/finish_account_deletion_cancellation`, {
    method: 'POST',
    headers: serviceHeaders(serviceKey),
    body: JSON.stringify({
      p_id: id,
      p_lease_token: leaseToken,
      p_outcome: outcome,
      p_failure_code: failureCode,
    }),
  });
  return response.ok;
}

/** Process a bounded number of deletion cancellations from the existing cron. */
export async function processAccountDeletionCancellations({
  supabaseUrl,
  serviceKey,
  qstashToken,
  fetchImpl = fetch,
  maxItems = 10,
}) {
  const stats = { claimed: 0, confirmed: 0, unknown: 0, failed: 0 };
  if (!supabaseUrl || !serviceKey || !qstashToken) return stats;

  for (let index = 0; index < maxItems; index += 1) {
    const claim = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/claim_account_deletion_cancellation`, {
      method: 'POST', headers: serviceHeaders(serviceKey), body: JSON.stringify({ p_lease_seconds: 60 }),
    }).catch(() => null);
    if (!claim?.ok) break;
    const rows = await claim.json().catch(() => []);
    const work = Array.isArray(rows) ? rows[0] : null;
    if (!work) break;
    stats.claimed += 1;

    let outcome = 'failed_requires_review';
    let failureCode = 'unsupported_cancellation_provider';
    if (work.provider === 'qstash' && work.provider_work_id) {
      try {
        const provider = await fetchImpl(
          `https://qstash.upstash.io/v2/messages/${encodeURIComponent(work.provider_work_id)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${qstashToken}` } },
        );
        if (provider.ok || provider.status === 404) {
          outcome = 'external_cancellation_confirmed';
          failureCode = null;
          stats.confirmed += 1;
        } else if (provider.status === 408 || provider.status === 429 || provider.status >= 500) {
          outcome = work.attempt_count >= 5 ? 'failed_requires_review' : 'failed_retryable';
          failureCode = `qstash_http_${provider.status}`;
          stats.failed += 1;
        } else {
          outcome = 'failed_requires_review';
          failureCode = `qstash_http_${provider.status}`;
          stats.failed += 1;
        }
      } catch {
        outcome = work.attempt_count >= 5 ? 'failed_requires_review' : 'external_outcome_unknown';
        failureCode = 'qstash_outcome_unknown';
        stats.unknown += 1;
      }
    }
    await finish({
      supabaseUrl, serviceKey, id: work.id, leaseToken: work.lease_token,
      outcome, failureCode, fetchImpl,
    });
  }
  return stats;
}
