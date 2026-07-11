/**
 * /api/automations
 *
 * CRUD for the automations table (Agent Automation Layer V1).
 *
 * This file replaces api/send-morning-brief-push.js, which had its QStash
 * schedule deleted and has no active callers. Replacement keeps the project
 * within the Vercel Hobby 12-function limit.
 *
 * Routes:
 *   GET    /api/automations   — list current user's automations + latest run summary
 *   POST   /api/automations   — create a new automation
 *   PATCH  /api/automations   — update fields or apply a lifecycle action
 *   DELETE /api/automations   — permanently delete one current user's automation
 *
 * Auth:    All routes require Authorization: Bearer <supabase-jwt>.
 * Ownership: users can only read/write their own automations.
 */

const VALID_CADENCE_TYPES = ['once', 'daily', 'weekly', 'every_n_days', 'monthly'];
const VALID_PROOF_TYPES   = ['photo', 'confirmation', 'text'];
const VALID_STATUSES      = ['active', 'paused', 'stopped', 'archived'];

const VALID_AUTOMATION_TYPES = ['delegation', 'message'];
const UNSUPPORTED_RECURRING_WHATSAPP_MESSAGE =
  'Recurring WhatsApp automations are currently disabled. Use one-time delegations or owner reminders instead.';

const ALLOWED_UPDATE_FIELDS = new Set([
  'title', 'instruction', 'assignee_id',
  'cadence_type', 'cadence_value', 'timezone', 'next_run_at',
  'proof_required', 'proof_type',
  'followup_after_min', 'escalate_after_min',
  'status', 'paused_reason', 'automation_type',
]);

// Sort order: active → paused → stopped → archived
const STATUS_ORDER = { active: 0, paused: 1, stopped: 2, archived: 3 };

/**
 * Privacy-safe rejection diagnostics for POST /api/automations. A production
 * incident (a live create_automation call rejected with 400) was
 * undiagnosable from server logs alone, because none of this handler's
 * validation branches logged anything before returning — only structural
 * signals are logged here, never title/instruction text, tokens, or the raw
 * body, so a future rejection can be root-caused without exposing reminder
 * content. automation_type/cadence_type are client-controlled strings — only
 * logged when they match a known allowlisted value, never copied verbatim,
 * so an arbitrary/oversized/malformed value can't land in server logs.
 */
function logAutomationPostRejection(reasonCode, uid, body) {
  const automationType = VALID_AUTOMATION_TYPES.includes(body?.automation_type)
    ? body.automation_type
    : null;
  const cadenceType = VALID_CADENCE_TYPES.includes(body?.cadence_type)
    ? body.cadence_type
    : null;
  console.warn('[automations POST] rejected', {
    reasonCode,
    ownerId: uid ?? null,
    automationType,
    cadenceType,
    hasAssigneeId: Boolean(body?.assignee_id),
    hasTitle: Boolean(body?.title?.trim?.()),
    hasInstruction: Boolean(body?.instruction?.trim?.()),
    hasNextRunAt: Boolean(body?.next_run_at),
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET')   return handleGet(req, res);
  if (req.method === 'POST')  return handlePost(req, res);
  if (req.method === 'PATCH') return handlePatch(req, res);
  if (req.method === 'DELETE') return handleDelete(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/automations
//
// Query params:
//   status  — filter by status (active|paused|stopped|archived)
//   limit   — max results (default 100)
//
// Returns automations sorted active-first then by next_run_at asc.
// Each automation includes a latest_run object (null if no runs yet).
// ═══════════════════════════════════════════════════════════════════════════

async function handleGet(req, res) {
  const { uid, config, error } = await requireUser(req);
  if (error) return res.status(401).json({ error });

  const limitN = Math.min(parseInt(req.query?.limit, 10) || 100, 500);
  const statusFilter = req.query?.status;

  // ── Fetch automations ─────────────────────────────────────────────────────
  let url =
    `${config.supabaseUrl}/rest/v1/automations` +
    `?user_id=eq.${e(uid)}` +
    `&limit=${limitN}` +
    `&select=*`;

  if (statusFilter && VALID_STATUSES.includes(statusFilter)) {
    url += `&status=eq.${e(statusFilter)}`;
  }

  const autoRes = await sbFetch(config, url);
  if (!autoRes.ok) {
    return res.status(500).json({ error: 'Failed to load automations.' });
  }

  const automations = await autoRes.json().catch(() => []);
  if (!Array.isArray(automations) || automations.length === 0) {
    return res.status(200).json({ automations: [] });
  }

  // ── Fetch most recent run per automation ──────────────────────────────────
  const ids = automations.map(a => a.id);
  const runRes = await sbFetch(
    config,
    `${config.supabaseUrl}/rest/v1/automation_runs` +
    `?automation_id=in.(${ids.map(e).join(',')})` +
    `&order=run_for.desc` +
    `&limit=${ids.length * 5}` +   // generous window; we pick top-1 per automation below
    `&select=id,automation_id,current_state,run_for,sent_at,confirmed_at,completed_at,failure_reason,created_at`,
  );
  const allRuns = runRes.ok ? await runRes.json().catch(() => []) : [];

  // Keep only the most recent run per automation (results are DESC by run_for)
  const latestRun = {};
  for (const run of (Array.isArray(allRuns) ? allRuns : [])) {
    if (!latestRun[run.automation_id]) {
      latestRun[run.automation_id] = run;
    }
  }

  // ── Merge + sort ──────────────────────────────────────────────────────────
  const result = automations.map(a => ({
    ...a,
    latest_run: latestRun[a.id] ?? null,
  }));

  result.sort((a, b) => {
    const sd = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (sd !== 0) return sd;
    return new Date(a.next_run_at) - new Date(b.next_run_at);
  });

  return res.status(200).json({ automations: result });
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/automations
//
// Required body fields:
//   title, instruction, cadence_type, cadence_value, next_run_at
//
// Optional body fields:
//   assignee_id, timezone, proof_required, proof_type,
//   followup_after_min, escalate_after_min, created_by
//
// Returns: { automation: <created row> }
// ═══════════════════════════════════════════════════════════════════════════

async function handlePost(req, res) {
  const { uid, config, error } = await requireUser(req);
  if (error) return res.status(401).json({ error });

  const body = req.body ?? {};

  // ── Required field validation ─────────────────────────────────────────────
  const { title, instruction, cadence_type, cadence_value, next_run_at } = body;

  if (!title?.trim()) {
    logAutomationPostRejection('title_missing', uid, body);
    return res.status(400).json({ error: 'title is required.' });
  }
  if (!instruction?.trim()) {
    logAutomationPostRejection('instruction_missing', uid, body);
    return res.status(400).json({ error: 'instruction is required.' });
  }
  if (!cadence_type || !VALID_CADENCE_TYPES.includes(cadence_type)) {
    logAutomationPostRejection('cadence_type_invalid', uid, body);
    return res.status(400).json({
      error: `cadence_type must be one of: ${VALID_CADENCE_TYPES.join(', ')}.`,
    });
  }
  if (cadence_value !== undefined && (typeof cadence_value !== 'object' || Array.isArray(cadence_value))) {
    logAutomationPostRejection('cadence_value_invalid', uid, body);
    return res.status(400).json({ error: 'cadence_value must be an object.' });
  }
  if (!next_run_at) {
    logAutomationPostRejection('next_run_at_missing', uid, body);
    return res.status(400).json({ error: 'next_run_at is required.' });
  }
  const nextRunDate = new Date(next_run_at);
  if (isNaN(nextRunDate.getTime())) {
    logAutomationPostRejection('next_run_at_invalid', uid, body);
    return res.status(400).json({ error: 'next_run_at must be a valid ISO timestamp.' });
  }

  // ── Optional field validation ─────────────────────────────────────────────
  const proof_type = body.proof_type ?? null;
  if (proof_type !== null && !VALID_PROOF_TYPES.includes(proof_type)) {
    logAutomationPostRejection('proof_type_invalid', uid, body);
    return res.status(400).json({
      error: `proof_type must be null or one of: ${VALID_PROOF_TYPES.join(', ')}.`,
    });
  }

  const automation_type = body.automation_type ?? 'delegation';
  if (!VALID_AUTOMATION_TYPES.includes(automation_type)) {
    logAutomationPostRejection('automation_type_invalid', uid, body);
    return res.status(400).json({
      error: `automation_type must be one of: ${VALID_AUTOMATION_TYPES.join(', ')}.`,
    });
  }
  if (isUnsupportedRecurringWhatsappAutomation({
    automation_type,
    assignee_id: body.assignee_id ?? null,
    cadence_type,
  })) {
    logAutomationPostRejection('unsupported_recurring_whatsapp', uid, body);
    return res.status(400).json({ error: UNSUPPORTED_RECURRING_WHATSAPP_MESSAGE });
  }

  const followup_after_min  = body.followup_after_min  ?? 120;
  const escalate_after_min  = body.escalate_after_min  ?? 360;

  if (!Number.isInteger(followup_after_min) || followup_after_min <= 0) {
    logAutomationPostRejection('followup_after_min_invalid', uid, body);
    return res.status(400).json({ error: 'followup_after_min must be a positive integer.' });
  }
  if (!Number.isInteger(escalate_after_min) || escalate_after_min <= 0) {
    logAutomationPostRejection('escalate_after_min_invalid', uid, body);
    return res.status(400).json({ error: 'escalate_after_min must be a positive integer.' });
  }
  if (escalate_after_min <= followup_after_min) {
    logAutomationPostRejection('escalate_not_greater_than_followup', uid, body);
    return res.status(400).json({
      error: 'escalate_after_min must be greater than followup_after_min.',
    });
  }

  // ── Build and insert row ──────────────────────────────────────────────────
  const row = {
    user_id:            uid,
    title:              title.trim(),
    instruction:        instruction.trim(),
    assignee_id:        body.assignee_id ?? null,
    cadence_type,
    cadence_value:      cadence_value ?? {},
    timezone:           body.timezone ?? 'Europe/Istanbul',
    next_run_at:        nextRunDate.toISOString(),
    proof_required:     body.proof_required === true,
    proof_type,
    followup_after_min,
    escalate_after_min,
    status:             'active',
    created_by:         body.created_by ?? 'carson',
    automation_type,
  };

  const insertRes = await sbFetch(
    config,
    `${config.supabaseUrl}/rest/v1/automations`,
    {
      method:  'POST',
      headers: { Prefer: 'return=representation' },
      body:    JSON.stringify(row),
    },
  );

  if (!insertRes.ok) {
    const errText = await insertRes.text().catch(() => '');
    console.error('[automations POST] insert failed:', insertRes.status, errText);
    return res.status(500).json({ error: 'Failed to create automation.' });
  }

  const created    = await insertRes.json().catch(() => null);
  const automation = Array.isArray(created) ? created[0] : created;

  return res.status(201).json({ automation });
}

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /api/automations
//
// Required body: { id }
//
// Optional body:
//   action — lifecycle shortcut: pause | resume | stop | archive
//   <field> — any field in ALLOWED_UPDATE_FIELDS
//
// action shortcuts take precedence over direct status field if both are sent.
// Returns: { automation: <updated row> }
// ═══════════════════════════════════════════════════════════════════════════

async function handlePatch(req, res) {
  const { uid, config, error } = await requireUser(req);
  if (error) return res.status(401).json({ error });

  const body = req.body ?? {};
  const { id, action } = body;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required.' });
  }

  // ── Verify ownership before touching anything ─────────────────────────────
  const checkRes = await sbFetch(
    config,
    `${config.supabaseUrl}/rest/v1/automations` +
    `?id=eq.${e(id)}&user_id=eq.${e(uid)}&select=id,status&limit=1`,
  );
  if (!checkRes.ok) {
    return res.status(500).json({ error: 'Failed to verify automation.' });
  }
  const rows = await checkRes.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(404).json({ error: 'Automation not found.' });
  }

  // ── Build patch object ────────────────────────────────────────────────────
  const patch = {};

  // Lifecycle action shortcuts
  if (action === 'pause') {
    patch.status = 'paused';
    if (body.paused_reason) patch.paused_reason = body.paused_reason;
  } else if (action === 'resume') {
    patch.status = 'active';
    patch.paused_reason = null;
  } else if (action === 'stop') {
    patch.status = 'stopped';
  } else if (action === 'archive') {
    patch.status = 'archived';
  }

  // Explicit field updates (whitelist enforced)
  for (const [key, value] of Object.entries(body)) {
    if (key === 'id' || key === 'action' || key === 'user_id') continue;
    if (!ALLOWED_UPDATE_FIELDS.has(key)) continue;
    // Don't let explicit status override a shortcut action already set
    if (key === 'status' && patch.status !== undefined) continue;
    patch[key] = value;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No valid update fields provided.' });
  }

  // ── Validate patch values ─────────────────────────────────────────────────
  if (patch.status !== undefined && !VALID_STATUSES.includes(patch.status)) {
    return res.status(400).json({
      error: `status must be one of: ${VALID_STATUSES.join(', ')}.`,
    });
  }

  if ('proof_type' in patch && patch.proof_type !== null && !VALID_PROOF_TYPES.includes(patch.proof_type)) {
    return res.status(400).json({
      error: `proof_type must be null or one of: ${VALID_PROOF_TYPES.join(', ')}.`,
    });
  }

  if ('cadence_type' in patch && !VALID_CADENCE_TYPES.includes(patch.cadence_type)) {
    return res.status(400).json({
      error: `cadence_type must be one of: ${VALID_CADENCE_TYPES.join(', ')}.`,
    });
  }

  if ('next_run_at' in patch) {
    const d = new Date(patch.next_run_at);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'next_run_at must be a valid ISO timestamp.' });
    }
    patch.next_run_at = d.toISOString();
  }

  // Validate timing relationship if both values are present in patch
  const pFollow   = patch.followup_after_min;
  const pEscalate = patch.escalate_after_min;
  if (pFollow !== undefined && pEscalate !== undefined && pEscalate <= pFollow) {
    return res.status(400).json({
      error: 'escalate_after_min must be greater than followup_after_min.',
    });
  }

  // ── Apply update ──────────────────────────────────────────────────────────
  const patchRes = await sbFetch(
    config,
    `${config.supabaseUrl}/rest/v1/automations` +
    `?id=eq.${e(id)}&user_id=eq.${e(uid)}`,
    {
      method:  'PATCH',
      headers: { Prefer: 'return=representation' },
      body:    JSON.stringify(patch),
    },
  );

  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => '');
    console.error('[automations PATCH] update failed:', patchRes.status, errText);
    return res.status(500).json({ error: 'Failed to update automation.' });
  }

  const updated    = await patchRes.json().catch(() => null);
  const automation = Array.isArray(updated) ? updated[0] : updated;

  return res.status(200).json({ automation });
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/automations
//
// Required: id in query string or JSON body.
//
// Permanently deletes one automation owned by the current user. Automation runs
// are deleted first so legacy rows can be cleaned up even when runs exist.
// ═══════════════════════════════════════════════════════════════════════════

async function handleDelete(req, res) {
  const { uid, config, error } = await requireUser(req);
  if (error) return res.status(401).json({ error });

  const id = req.query?.id ?? req.body?.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required.' });
  }

  const checkRes = await sbFetch(
    config,
    `${config.supabaseUrl}/rest/v1/automations` +
    `?id=eq.${e(id)}&user_id=eq.${e(uid)}&select=id&limit=1`,
  );
  if (!checkRes.ok) {
    return res.status(500).json({ error: 'Failed to verify automation.' });
  }
  const rows = await checkRes.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(404).json({ error: 'Automation not found.' });
  }

  const runsRes = await sbFetch(
    config,
    `${config.supabaseUrl}/rest/v1/automation_runs` +
    `?automation_id=eq.${e(id)}&user_id=eq.${e(uid)}`,
    {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    },
  );
  if (!runsRes.ok) {
    const errText = await runsRes.text().catch(() => '');
    console.error('[automations DELETE] runs delete failed:', runsRes.status, errText);
    return res.status(500).json({ error: 'Failed to delete automation runs.' });
  }

  const deleteRes = await sbFetch(
    config,
    `${config.supabaseUrl}/rest/v1/automations` +
    `?id=eq.${e(id)}&user_id=eq.${e(uid)}`,
    {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    },
  );

  if (!deleteRes.ok) {
    const errText = await deleteRes.text().catch(() => '');
    console.error('[automations DELETE] delete failed:', deleteRes.status, errText);
    return res.status(500).json({ error: 'Failed to delete automation.' });
  }

  return res.status(200).json({ ok: true, deleted: true, id });
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verifies the Bearer JWT, returns { uid, config } or { error }.
 * Uses the same auth/v1/user pattern as google-calendar.js.
 */
async function requireUser(req) {
  const authHeader =
    req.headers?.['authorization'] ??
    req.headers?.['Authorization'] ??
    '';

  if (!authHeader.startsWith('Bearer ')) {
    return { error: 'Unauthorized' };
  }
  const jwt = authHeader.slice(7);

  const supabaseUrl    = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey        = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return { error: 'Server configuration error.' };
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey:        anonKey,
      Authorization: `Bearer ${jwt}`,
    },
  });

  if (!userRes.ok) return { error: 'Unauthorized' };

  const user = await userRes.json().catch(() => null);
  if (!user?.id)  return { error: 'Unauthorized' };

  return { uid: user.id, config: { supabaseUrl, serviceRoleKey } };
}

/**
 * Fetch against Supabase REST using service role key.
 * Service role bypasses RLS but ownership is still enforced via query
 * filters (user_id=eq.<uid>) on every call.
 */
function sbFetch(config, url, opts = {}) {
  return fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      apikey:          config.serviceRoleKey,
      Authorization:   `Bearer ${config.serviceRoleKey}`,
      'Content-Type':  'application/json',
      ...opts.headers,
    },
    ...(opts.body ? { body: opts.body } : {}),
  });
}

/** URL-encode a query parameter value safely. */
function e(value) {
  return encodeURIComponent(value);
}

function isUnsupportedRecurringWhatsappAutomation(row) {
  if (row.cadence_type === 'once') return false;
  return row.automation_type === 'message' || Boolean(row.assignee_id);
}
