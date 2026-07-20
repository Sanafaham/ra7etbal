/**
 * Transport-independent staff-to-Carson communication engine (Issue #46).
 *
 * This is the single canonical staff-message processing path. It must be
 * called by every transport — the simulated/internal test harness today,
 * and later WhatsApp or a rebuilt ElevenLabs bridge — rather than each
 * transport implementing its own reasoning. There is only one Carson: this
 * module owns classification, direct-answer-vs-escalate judgment, and
 * response generation for staff messages; a transport's only job is to
 * relay `processStaffMessage()`'s structured result.
 *
 * Underscore-prefixed: not deployed as a Vercel Function (same convention
 * as _quality-review.js / _carson-agent-turn.js / _whatsapp-delivery.js),
 * so it does not count against the Hobby 12-function cap.
 *
 * Persistence goes exclusively through the claim_staff_message /
 * complete_staff_message / fail_staff_message SECURITY DEFINER functions
 * added in supabase/migrations/20260720_create_staff_messages.sql — see
 * that file for the full ownership/idempotency contract. This module never
 * writes to staff_messages directly.
 *
 * Scope boundary: this engine never writes to public.tasks. Task
 * completion, proof photos, and Quality Intelligence are a protected,
 * separate pipeline (api/task-confirm.js). A 'completion_confirmation'
 * classification here only means the *staff message itself* has been
 * fully handled (user_facing_state = 'Completed' on the staff_messages
 * row) — it never marks the underlying task done.
 */

const CLASSIFICATIONS = [
  'routine_question',
  'task_update',
  'clarification_request',
  'completion_confirmation',
  'blocker',
  'substitution_request',
  'owner_decision_required',
  'unclear',
];

const NEXT_ACTION_OWNERS = ['carson', 'staff', 'owner', 'nobody'];
const USER_FACING_STATES = ['Waiting', 'Needs You', 'Completed', 'In Progress'];

const CLAIM_REJECTION_REASONS = new Set([
  'missing_user_id',
  'unsupported_source',
  'empty_inbound_text',
  'missing_received_at',
  'missing_person_id',
  'not_authorized',
  'not_staff',
  'invalid_person_name',
]);

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ── Supabase REST helpers (service role — bypasses RLS by design) ──────────

async function supabaseRpc({ supabaseUrl, serviceKey, fetchImpl, fn, args }) {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(args),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    // PostgREST surfaces a plpgsql RAISE EXCEPTION message in `message`.
    const message = data?.message || `rpc_failed:${fn}`;
    const err = new Error(message);
    err.postgrestCode = data?.code || null;
    throw err;
  }

  return data;
}

async function supabaseSelect({ supabaseUrl, serviceKey, fetchImpl, table, query }) {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.message || `select_failed:${table}`);
  }
  return data ?? [];
}

// ── Context loading (self-contained; see file header for why this does not
//    import src/lib/carson-context.ts — no api/*.js file in this codebase
//    imports from src/lib today, and this table-shaped read is simple
//    enough not to warrant being the first). ─────────────────────────────

async function loadStaffContext({ supabaseUrl, serviceKey, fetchImpl, userId, personId, taskId }) {
  const [personRows, taskRows, householdRulesRows, memoryRows] = await Promise.all([
    personId
      ? supabaseSelect({
          supabaseUrl, serviceKey, fetchImpl, table: 'people',
          query: `id=eq.${personId}&user_id=eq.${userId}&select=id,name,role,responsibilities,delegation_guidance,should_not_assign,reliability_level,communication_style,notes`,
        })
      : Promise.resolve([]),
    taskId
      ? supabaseSelect({
          supabaseUrl, serviceKey, fetchImpl, table: 'tasks',
          query: `id=eq.${taskId}&user_id=eq.${userId}&select=id,type,description,assigned_to,status,due_at,worker_reply,quality_review_status`,
        })
      : Promise.resolve([]),
    supabaseSelect({
      supabaseUrl, serviceKey, fetchImpl, table: 'household_rules',
      query: `user_id=eq.${userId}&select=rules&limit=1`,
    }).catch(() => []),
    supabaseSelect({
      supabaseUrl, serviceKey, fetchImpl, table: 'carson_memory',
      query: `user_id=eq.${userId}&select=summary,created_at&order=created_at.desc&limit=10`,
    }).catch(() => []),
  ]);

  return {
    person: personRows[0] || null,
    task: taskRows[0] || null,
    householdRules: householdRulesRows[0]?.rules || null,
    recentMemory: memoryRows.map((r) => r.summary).filter(Boolean),
  };
}

function buildContextBlock({ person, task, householdRules, recentMemory }) {
  const lines = [];

  if (person) {
    lines.push(`STAFF MEMBER: ${person.name}${person.role ? ` (${person.role})` : ''}`);
    if (person.responsibilities) lines.push(`Responsibilities: ${person.responsibilities}`);
    if (person.delegation_guidance) lines.push(`Delegation guidance: ${person.delegation_guidance}`);
    if (person.should_not_assign) lines.push(`Do NOT assign: ${person.should_not_assign}`);
    if (person.communication_style) lines.push(`Communication style: ${person.communication_style}`);
  } else {
    lines.push('STAFF MEMBER: unknown (identity could not be loaded)');
  }

  if (task) {
    lines.push(
      `RELATED TASK: [${task.type}, ${task.status}] ${task.description}` +
        (task.assigned_to ? `, assigned to ${task.assigned_to}` : '') +
        (task.due_at ? `, due ${task.due_at}` : ''),
    );
    if (task.worker_reply) lines.push(`Prior worker reply on this task: ${task.worker_reply}`);
  } else {
    lines.push('RELATED TASK: none linked');
  }

  if (householdRules) lines.push(`HOUSEHOLD RULES: ${householdRules}`);

  if (recentMemory.length > 0) {
    lines.push('RECENT CARSON MEMORY (background only, not current status):');
    for (const m of recentMemory.slice(0, 5)) lines.push(`- ${m}`);
  }

  return lines.join('\n');
}

// ── Claude classification + response ────────────────────────────────────

const SYSTEM_PROMPT = `You are Carson, the household's Chief of Staff, replying directly to a household staff member on behalf of the owner. This is not a chat with the owner — never address the staff member as if they were the owner, and never disclose private owner information (private notes, unrelated calendar events, financial details, another staff member's private messages) beyond what their role requires.

Classify the staff member's message into exactly one of: routine_question, task_update, clarification_request, completion_confirmation, blocker, substitution_request, owner_decision_required, unclear.

Answer the staff member directly, using only the STAFF MEMBER / RELATED TASK / HOUSEHOLD RULES / RECENT CARSON MEMORY context provided, when the answer is already supported by that context (an existing task, an approved plan, a stored household preference, or an approved substitution rule). Do not invent a fact, preference, or approval that is not in the provided context.

Escalate to the owner only when: the answer is not known from the context, the request would materially change an approved plan (time, guest count, scope), money is involved beyond an already-approved limit, safety/privacy/access is involved, two instructions conflict, the staff member reports a serious problem, or the owner must choose between real alternatives. When escalating, still send the staff member a brief, honest holding reply (e.g. "I'm checking that with the owner, I'll get back to you.") — never leave them without a reply.

For completion_confirmation: only mark this interaction Completed when the report is plausible and does not require photo proof or an owner decision you cannot make — you are acknowledging that THIS MESSAGE has been fully handled, not marking the underlying task done in the system (that happens through a separate proof/confirmation flow you have no access to). If the task context indicates proof or owner sign-off is required, or you are not confident, use Waiting instead of Completed and say so plainly.

For unclear messages, ask exactly one short clarification question rather than guessing or inventing context — do not classify anything other than unclear, do not escalate, and do not fabricate a response as if the message were understood.

Reply style to staff: brief, practical, respectful, states the answer or action first, no internal process disclosure, no mention of tools/databases/AI.

Respond with ONLY a single JSON object, no other text, in exactly this shape:
{
  "classification": "one of the eight categories above",
  "reply_to_staff": "the brief message to send back to the staff member",
  "escalate": true or false,
  "escalation_reason": "the exact decision the owner needs to make, or null when escalate is false",
  "recommended_option": "your recommendation for the owner, or null",
  "next_action_owner": "carson" | "staff" | "owner" | "nobody",
  "user_facing_state": "Waiting" | "Needs You" | "Completed" | "In Progress",
  "owner_attention_required": true or false
}`;

async function callClaudeForClassification({ anthropicApiKey, fetchImpl, model, inboundText, contextBlock }) {
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `CONTEXT\n${contextBlock}\n\nSTAFF MESSAGE:\n"${inboundText}"`,
        },
      ],
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || 'anthropic_request_failed');
  }

  const text = data?.content?.[0]?.text;
  if (!text) throw new Error('anthropic_empty_response');
  return text;
}

/**
 * Parses and validates Claude's JSON response. Never throws on a malformed
 * or partially-invalid response — falls back to a safe, honest escalation
 * ('unclear' would still be a guess; an explicit owner_decision_required
 * fallback with a truthful escalation_reason is the only response that
 * never invents context) rather than ever producing a false success.
 */
function parseClassificationResponse(rawText) {
  let parsed;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
  } catch {
    return safeFallback('Carson could not interpret this message and needs the owner to review it.');
  }

  const classification = CLASSIFICATIONS.includes(parsed.classification) ? parsed.classification : 'unclear';
  const nextActionOwner = NEXT_ACTION_OWNERS.includes(parsed.next_action_owner) ? parsed.next_action_owner : 'owner';
  const userFacingState = USER_FACING_STATES.includes(parsed.user_facing_state) ? parsed.user_facing_state : 'Needs You';
  const replyToStaff = typeof parsed.reply_to_staff === 'string' && parsed.reply_to_staff.trim()
    ? parsed.reply_to_staff.trim()
    : "I'm checking on this and will get back to you.";

  return {
    classification,
    replyToStaff,
    escalate: Boolean(parsed.escalate),
    escalationReason: typeof parsed.escalation_reason === 'string' ? parsed.escalation_reason.trim() || null : null,
    recommendedOption: typeof parsed.recommended_option === 'string' ? parsed.recommended_option.trim() || null : null,
    nextActionOwner,
    userFacingState,
    ownerAttentionRequired: Boolean(parsed.owner_attention_required),
  };
}

function safeFallback(reason) {
  return {
    classification: 'unclear',
    replyToStaff: "I'm checking on this and will get back to you.",
    escalate: true,
    escalationReason: reason,
    recommendedOption: null,
    nextActionOwner: 'owner',
    userFacingState: 'Needs You',
    ownerAttentionRequired: true,
  };
}

// ── Main entry point ────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.personId
 * @param {string} input.text
 * @param {string|null} [input.taskId]
 * @param {string|null} [input.threadId]
 * @param {string} input.receivedAt ISO timestamp
 * @param {'simulated'|'internal'|'whatsapp'} input.source
 * @param {string|null} [input.externalMessageId]
 * @param {object} deps
 * @param {string} deps.supabaseUrl
 * @param {string} deps.serviceKey
 * @param {string} deps.anthropicApiKey
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {string} [deps.model]
 */
export async function processStaffMessage(input, deps) {
  const fetchImpl = deps.fetchImpl || fetch;
  const model = deps.model || DEFAULT_MODEL;
  const { supabaseUrl, serviceKey, anthropicApiKey } = deps;

  let claimRows;
  try {
    claimRows = await supabaseRpc({
      supabaseUrl, serviceKey, fetchImpl, fn: 'claim_staff_message',
      args: {
        p_user_id: input.userId,
        p_person_id: input.personId,
        p_task_id: input.taskId || null,
        p_thread_id: input.threadId || null,
        p_source: input.source,
        p_external_message_id: input.externalMessageId || null,
        p_inbound_text: input.text,
        p_received_at: input.receivedAt,
      },
    });
  } catch (err) {
    const reason = CLAIM_REJECTION_REASONS.has(err.message) ? err.message : 'claim_failed';
    console.error('[staff-comms-engine] claim rejected', { reason, source: input.source });
    return {
      ok: false,
      duplicate: false,
      rejected: true,
      rejectionReason: reason,
      messageId: null,
      classification: null,
      response: null,
      nextActionOwner: null,
      userFacingState: null,
      ownerAttentionRequired: false,
      escalationReason: null,
      relatedTaskId: null,
    };
  }

  const claim = claimRows[0];

  if (!claim.is_new) {
    // Duplicate inbound delivery. Return the existing stored outcome
    // as-is — never re-process, never call Claude again, never touch the
    // row. If it's still 'claimed' (a genuine in-flight race), that is
    // reported honestly rather than fabricated as complete.
    const [existing] = await supabaseSelect({
      supabaseUrl, serviceKey, fetchImpl, table: 'staff_messages',
      query: `id=eq.${claim.message_id}&select=*`,
    });
    return {
      ok: true,
      duplicate: true,
      rejected: false,
      rejectionReason: null,
      messageId: claim.message_id,
      classification: existing?.classification ?? null,
      response: existing?.carson_response ?? null,
      nextActionOwner: existing?.next_action_owner ?? null,
      userFacingState: existing?.user_facing_state ?? null,
      ownerAttentionRequired: existing?.owner_attention_required ?? false,
      escalationReason: existing?.escalation_reason ?? null,
      relatedTaskId: existing?.task_id ?? null,
    };
  }

  // We own this message. Load context, classify, and complete — or fail
  // truthfully if any step errors, never fabricating a response.
  try {
    const context = await loadStaffContext({
      supabaseUrl, serviceKey, fetchImpl,
      userId: input.userId, personId: input.personId, taskId: input.taskId || null,
    });
    const contextBlock = buildContextBlock(context);

    const rawResponse = await callClaudeForClassification({
      anthropicApiKey, fetchImpl, model, inboundText: input.text, contextBlock,
    });
    const outcome = parseClassificationResponse(rawResponse);

    const [completed] = await supabaseRpc({
      supabaseUrl, serviceKey, fetchImpl, fn: 'complete_staff_message',
      args: {
        p_id: claim.message_id,
        p_user_id: input.userId,
        p_classification: outcome.classification,
        p_carson_response: outcome.replyToStaff,
        p_next_action_owner: outcome.nextActionOwner,
        p_user_facing_state: outcome.userFacingState,
        p_owner_attention_required: outcome.ownerAttentionRequired,
        p_escalation_reason: outcome.escalationReason,
        p_responded_at: new Date().toISOString(),
      },
    });

    return {
      ok: true,
      duplicate: false,
      rejected: false,
      rejectionReason: null,
      messageId: completed.id,
      classification: completed.classification,
      response: completed.carson_response,
      nextActionOwner: completed.next_action_owner,
      userFacingState: completed.user_facing_state,
      ownerAttentionRequired: completed.owner_attention_required,
      escalationReason: completed.escalation_reason,
      relatedTaskId: completed.task_id,
      recommendedOption: outcome.recommendedOption,
    };
  } catch (err) {
    console.error('[staff-comms-engine] processing failed', { messageId: claim.message_id, error: err.message });
    try {
      await supabaseRpc({
        supabaseUrl, serviceKey, fetchImpl, fn: 'fail_staff_message',
        args: { p_id: claim.message_id, p_user_id: input.userId, p_processing_error: err.message || 'unknown_error' },
      });
    } catch (failErr) {
      console.error('[staff-comms-engine] fail_staff_message also failed', { messageId: claim.message_id, error: failErr.message });
    }
    return {
      ok: false,
      duplicate: false,
      rejected: false,
      rejectionReason: null,
      messageId: claim.message_id,
      classification: null,
      response: null,
      nextActionOwner: null,
      userFacingState: 'In Progress',
      ownerAttentionRequired: false,
      escalationReason: null,
      relatedTaskId: input.taskId || null,
    };
  }
}

export {
  buildContextBlock,
  parseClassificationResponse,
  loadStaffContext,
  CLASSIFICATIONS,
  NEXT_ACTION_OWNERS,
  USER_FACING_STATES,
};
