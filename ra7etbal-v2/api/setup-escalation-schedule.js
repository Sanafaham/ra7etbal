/**
 * POST /api/setup-escalation-schedule
 *
 * One-time setup: registers a QStash schedule that calls
 * /api/process-delegation-escalations every 10 minutes.
 *
 * NOTE: Escalation scheduling is handled by QStash, not Vercel cron,
 * because Vercel Hobby cron does not support frequent schedules (*/10 * * * *).
 *
 * Idempotent — deletes any existing schedule for the same destination
 * before creating a fresh one, so it is safe to call multiple times.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 *
 * Run once after each production deployment:
 *   curl -X POST https://ra7etbal-v2.vercel.app/api/setup-escalation-schedule \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 *
 * QStash will forward "Authorization: Bearer <CRON_SECRET>" on every
 * scheduled call so the escalation endpoint can verify the caller.
 */

const QSTASH_BASE = 'https://qstash.upstash.io/v2';
const ESCALATION_CRON = '*/10 * * * *';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const qstashToken = process.env.QSTASH_TOKEN;
  const cronSecret  = process.env.CRON_SECRET;
  const appBaseUrl  = (process.env.APP_BASE_URL || 'https://ra7etbal-v2.vercel.app').trim();

  const missing = [];
  if (!qstashToken) missing.push('QSTASH_TOKEN');
  if (!cronSecret)  missing.push('CRON_SECRET');

  if (missing.length > 0) {
    console.error('[setup-schedule] missing env vars:', missing.join(', '));
    return res.status(500).json({ error: `Missing config: ${missing.join(', ')}` });
  }

  const destination = `${appBaseUrl}/api/process-delegation-escalations`;
  console.log(`[setup-schedule] target destination: ${destination}`);

  // ── 1. Remove any existing schedules for this destination (idempotent) ──────
  const listRes = await fetch(`${QSTASH_BASE}/schedules`, {
    headers: { Authorization: `Bearer ${qstashToken}` },
  });
  const schedules = await listRes.json().catch(() => []);

  if (Array.isArray(schedules)) {
    for (const s of schedules) {
      if (s.destination === destination) {
        console.log(`[setup-schedule] deleting duplicate schedule ${s.scheduleId}`);
        await fetch(`${QSTASH_BASE}/schedules/${s.scheduleId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${qstashToken}` },
        }).catch(() => {});
      }
    }
  }

  // ── 2. Create the new schedule ───────────────────────────────────────────────
  // Upstash-Forward-Authorization tells QStash to include the Authorization
  // header in every outbound call, so the escalation endpoint can verify
  // the caller via its existing CRON_SECRET check.
  const createRes = await fetch(
    `${QSTASH_BASE}/schedules/${encodeURIComponent(destination)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${qstashToken}`,
        'Upstash-Cron': ESCALATION_CRON,
        'Upstash-Forward-Authorization': `Bearer ${cronSecret}`,
        'Upstash-Method': 'POST',
      },
    },
  );

  const data = await createRes.json().catch(() => ({}));

  if (!createRes.ok) {
    console.error('[setup-schedule] QStash create failed:', data);
    return res.status(500).json({ error: data?.error || `QStash schedule creation failed (${createRes.status})` });
  }

  const scheduleId = data.scheduleId ?? data.schedule_id ?? data.id ?? null;
  console.log(`[setup-schedule] schedule created scheduleId=${scheduleId} cron=${ESCALATION_CRON}`);

  return res.status(200).json({
    ok: true,
    scheduleId,
    cron: ESCALATION_CRON,
    destination,
  });
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization || req.headers.Authorization || '';
  return auth === `Bearer ${secret}`;
}
