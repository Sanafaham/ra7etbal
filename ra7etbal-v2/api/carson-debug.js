const ALLOWED_FIELDS = new Set([
  'userExists',
  'transcriptCount',
  'userTurnCount',
  'extractCalled',
  'apiStarted',
  'apiResponseOk',
  'jsonParseOk',
  'validatedFactsCount',
  'upsertAttemptedCount',
  'upsertSuccess',
  'errorMessage',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const event = sanitizeEvent(req.body?.event);
  const data = sanitizeData(req.body?.data);

  console.log(`[carson-facts:v3-server] ${event}`, data);
  return res.status(200).json({ ok: true });
}

function sanitizeEvent(value) {
  if (typeof value !== 'string') return 'unknown';
  const cleaned = value.trim().replace(/[^a-zA-Z0-9:_-]+/g, '_').slice(0, 80);
  return cleaned || 'unknown';
}

function sanitizeData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const safe = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (typeof raw === 'boolean' || typeof raw === 'number') {
      safe[key] = raw;
      continue;
    }
    if (typeof raw === 'string') {
      safe[key] = raw.trim().replace(/\s+/g, ' ').slice(0, 160);
    }
  }
  return safe;
}
