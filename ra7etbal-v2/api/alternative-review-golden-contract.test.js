/**
 * Golden regression contract — server-side half of the protected
 * alternative-review (substitute_review) decision lifecycle: Approve
 * Alternative / Reject Alternative / Custom Instruction (Phase 8.1). See
 * src/lib/alternative-review-golden-contract.test.ts for the client-side
 * half.
 *
 * Why this exists: Phase 8.1 hands a single judgment call to the owner when
 * an assignee sends a reasonable but different alternative to the exact
 * requested item. The endpoint (api/task-confirm.js's handleOwnerDecision)
 * is a lease-fenced, idempotent, retry-safe pipeline built on top of several
 * SECURITY DEFINER Postgres functions (claim_substitute_decision,
 * reserve_rejected_alternative, reserve_custom_instruction,
 * reserve_send_window, complete_rejected_alternative,
 * complete_custom_instruction — supabase/migrations/
 * 20260710_quality_substitute_review.sql and
 * 20260712_approve_alternative_message_first.sql). This file calls the real
 * production handler (api/task-confirm.js's default export, both the POST
 * proof-submission path and the PATCH owner-decision path) with only true
 * I/O boundaries mocked (Supabase REST, the Meta Graph API) — never
 * source-text scans, except where the state transition itself happens
 * inside a Postgres function body that vitest cannot execute; there, this
 * file reads the migration source as a regression guard, exactly like the
 * existing guard in api/task-confirm.test.js ("Approve Alternative and
 * Custom Instruction share the same completion RPC...").
 *
 * Scenario labels match the numbered behaviors in the task that created this
 * suite:
 *   1  — a real SUBSTITUTE_REVIEW quality-review result is saved as exactly
 *        quality_review_status: "substitute_review" — never uncertain, never
 *        correction_required — and never consumes the correction budget
 *   3  — Approve Alternative goes through the real approved-alternative path
 *   4  — Reject Alternative goes through the real correction path (reuses
 *        the same WhatsApp/lease mechanics, its own RPC pair)
 *   5  — Custom Instruction sends exactly the owner's typed instructionText
 *   6  — no cross-task bleed when multiple tasks are in substitute_review
 *   7  — a decision executes exactly once (claim-level idempotency)
 *   8  — a retry/duplicate PATCH never duplicates the outbound WhatsApp send
 *   9  — failure paths never report success back to the caller
 *   10 — the real final task state after each decision (paired with the
 *        client half, src/lib/alternative-review-golden-contract.test.ts)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-id');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ── [1] POST — a real SUBSTITUTE_REVIEW verdict is the correct trigger state ─
// Calls the real handler end-to-end (handlePost -> the real, unmocked
// _quality-review.js runQualityReview) with only the Anthropic API and
// Supabase REST mocked at the fetch boundary — proving the model's own
// SUBSTITUTE_REVIEW verdict is faithfully preserved, not collapsed into
// uncertain or correction_required.
describe('Golden contract [1] — substitute_review is the correct trigger state', () => {
  it('a real SUBSTITUTE_REVIEW quality-review result is saved as exactly quality_review_status: "substitute_review", never uncertain or correction_required, and never consumes the automated correction-attempt budget', async () => {
    const { default: handler } = await import('./task-confirm.js');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{
        id: 'task-1', user_id: 'user-1', status: 'pending',
        description: 'buy TEREA Silver', assigned_to: 'Christopher',
        image_path: 'task-images/u/t/photo.jpg', attachment_count: 0,
        proof_image_path: null, quality_review_status: null, quality_review_cycle_count: 0,
      }])) // task lookup
      .mockResolvedValueOnce(jsonResponse([{ content: 'Please buy TEREA Silver.' }])) // delegation message
      .mockResolvedValueOnce({ // reference image download (real downloadImageAsBase64)
        ok: true, status: 200, arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      })
      .mockResolvedValueOnce({ // proof image download
        ok: true, status: 200, arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      })
      .mockResolvedValueOnce(anthropicResponse(
        '{"result":"SUBSTITUTE_REVIEW","correction_message":"I could only find Turquoise, is that OK?","reasoning":"Different variant of the same product line."}',
      )) // real Anthropic call
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }])) // PATCH tasks (save_review)
      .mockResolvedValue(emptyResponse()); // best-effort follow-ups (proof attachment replace) — non-fatal by design
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1', proofImagePaths: ['task-images/u/t/proof/0.jpg'] }, 'POST'), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: 'substitute_review' }));

    const patchCall = fetchMock.mock.calls.find(
      ([url, options]) => String(url).includes('/rest/v1/tasks?id=eq.task-1') && options?.method === 'PATCH',
    );
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody.quality_review_status).toBe('substitute_review');
    expect(patchBody.quality_review_status).not.toBe('uncertain');
    expect(patchBody.quality_review_status).not.toBe('correction_required');
    // isSubstituteReview keeps the cycle count exactly as it was — it is not
    // a "wrong photo, try again" cycle.
    expect(patchBody.quality_review_cycle_count).toBe(0);

    // No correction WhatsApp is sent to the assignee for substitute_review —
    // the owner decides next, not an automated retry.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
  });
});

// ── PATCH — handleOwnerDecision: Approve / Reject / Custom Instruction ──────
describe('Golden contract [3/4/5/6/7/8/9/10] — PATCH owner decision (substitute_review)', () => {
  let handler;

  beforeEach(async () => {
    ({ default: handler } = await import('./task-confirm.js'));
  });

  function baseTask(overrides = {}) {
    return {
      id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Christopher',
      confirmation_url: null, quality_review_status: 'substitute_review', quality_review_note: 'note',
      quality_reviewed_at: '2026-07-10T00:00:00.000Z', worker_reply: null,
      ...overrides,
    };
  }

  it('[3] Approve Alternative: goes through the real approved-alternative path — exactly one WhatsApp send carrying an approval meaning, completes through the shared completion RPC, and the task-row marker sets quality_review_status to "approved" while the task stays open (pending, not done)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' })) // auth/v1/user
      .mockResolvedValueOnce(jsonResponse([baseTask()])) // task fetch
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'approved_alternative' })) // claim RPC
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }])) // findAssigneePerson
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve_custom_instruction RPC (shared with approve)
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }])) // fetchDeliveryStatus
      .mockResolvedValueOnce(emptyResponse()) // reserve_send_window RPC
      .mockResolvedValueOnce(metaAcceptedResponse('wamid.approve')) // Meta send
      .mockResolvedValueOnce(emptyResponse()) // markMessageAccepted
      .mockResolvedValueOnce(emptyResponse()) // markWhatsappDeliveryAccepted
      .mockResolvedValueOnce(emptyResponse()) // complete_custom_instruction RPC
      .mockResolvedValueOnce(emptyResponse()); // markApprovedAlternativeConfirmationOnly PATCH
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'approved_alternative', outcome: 'approved' }));

    const metaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('graph.facebook.com'));
    expect(metaCalls).toHaveLength(1);
    expect(JSON.parse(metaCalls[0][1].body).template.components[0].parameters[0].text).toMatch(/approved/i);

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/complete_custom_instruction'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/complete_approved_alternative'))).toBe(false);

    const markerCall = fetchMock.mock.calls.find(
      ([url, options]) => String(url).includes('/rest/v1/tasks?id=eq.task-1&status=eq.pending') && options?.method === 'PATCH',
    );
    expect(markerCall).toBeDefined();
    const markerBody = JSON.parse(markerCall[1].body);
    expect(markerBody.quality_review_status).toBe('approved');
    expect(markerBody.status).not.toBe('done'); // an owner decision is not task completion
  });

  it('[4] Reject Alternative: goes through the real correction path — its own reserve/complete RPC pair (never the custom_instruction ones), exactly one WhatsApp send carrying a rejection meaning, outcome correction_required', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([baseTask()]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'rejected_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ outcome: 'correction_required', message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve_rejected_alternative RPC
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(metaAcceptedResponse('wamid.reject'))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse()); // complete_rejected_alternative RPC
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'rejected_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'rejected_alternative', outcome: 'correction_required' }));

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/reserve_rejected_alternative'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/complete_rejected_alternative'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/reserve_custom_instruction'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/complete_custom_instruction'))).toBe(false);

    const metaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('graph.facebook.com'));
    expect(metaCalls).toHaveLength(1);
    expect(JSON.parse(metaCalls[0][1].body).template.components[0].parameters[0].text).toMatch(/exact item is needed/i);
  });

  it('[5] Custom Instruction: sends exactly the owner\'s typed instructionText to the worker — not a paraphrase, not a template default', async () => {
    const exactText = 'Please get TEREA Turquoise exactly — do not substitute anything else!';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([baseTask()]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'custom_instruction' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve_custom_instruction RPC
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(metaAcceptedResponse('wamid.custom'))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse()); // complete_custom_instruction RPC
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({
      taskId: 'task-1', decision: 'custom_instruction', instructionText: exactText, reviewedAt: '2026-07-10T00:00:00.000Z',
    }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'custom_instruction', outcome: 'custom_instruction_sent' }));
    const metaCall = fetchMock.mock.calls.find(([url]) => String(url).includes('graph.facebook.com'));
    const metaBody = JSON.parse(metaCall[1].body);
    // Verbatim — not trimmed differently, not templated, not paraphrased.
    expect(metaBody.template.components[0].parameters[0].text).toBe(exactText);
  });

  it('[6] cross-task isolation: two different tasks in substitute_review simultaneously — deciding task A never touches task B\'s row, RPC args, or WhatsApp payload, and vice versa', async () => {
    const fetchMock = vi.fn()
      // ── Task A: Approve Alternative ──
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([baseTask({ id: 'task-A', description: 'buy milk', assigned_to: 'Christopher', quality_reviewed_at: '2026-07-10T00:00:00.000Z' })]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-A', lease_token: 'lease-A', status: 'processing', decision: 'approved_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551111111' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-A', delivery_id: 'delivery-A' }]))
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(metaAcceptedResponse('wamid.A'))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse()) // complete_custom_instruction
      .mockResolvedValueOnce(emptyResponse()) // markApprovedAlternativeConfirmationOnly PATCH for task-A
      // ── Task B: Reject Alternative ──
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([baseTask({ id: 'task-B', description: 'buy bread', assigned_to: 'Grace', quality_reviewed_at: '2026-07-11T00:00:00.000Z' })]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-B', lease_token: 'lease-B', status: 'processing', decision: 'rejected_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Grace', phone: '+15552222222' }]))
      .mockResolvedValueOnce(jsonResponse([{ outcome: 'correction_required', message_id: 'msg-B', delivery_id: 'delivery-B' }]))
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(metaAcceptedResponse('wamid.B'))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse()); // complete_rejected_alternative
    vi.stubGlobal('fetch', fetchMock);

    const resA = createRes();
    await handler(patchReq({ taskId: 'task-A', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), resA);
    const resB = createRes();
    await handler(patchReq({ taskId: 'task-B', decision: 'rejected_alternative', reviewedAt: '2026-07-11T00:00:00.000Z' }), resB);

    expect(resA.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: 'approved' }));
    expect(resB.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: 'correction_required' }));

    const taskRowCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/rest/v1/tasks?id=eq.'));
    expect(taskRowCalls.some(([url]) => String(url).includes('id=eq.task-A'))).toBe(true);
    expect(taskRowCalls.some(([url]) => String(url).includes('id=eq.task-B'))).toBe(true);
    // No single tasks query/patch ever references both task ids at once.
    expect(taskRowCalls.every(([url]) => !(String(url).includes('task-A') && String(url).includes('task-B')))).toBe(true);

    const claimCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/rpc/claim_substitute_decision'));
    expect(claimCalls).toHaveLength(2);
    expect(JSON.parse(claimCalls[0][1].body).p_task_id).toBe('task-A');
    expect(JSON.parse(claimCalls[1][1].body).p_task_id).toBe('task-B');

    const metaCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('graph.facebook.com'));
    expect(metaCalls).toHaveLength(2);
    expect(JSON.parse(metaCalls[0][1].body).to).not.toBe(JSON.parse(metaCalls[1][1].body).to);
  });

  it('[7] idempotency: a decision executes exactly once — a claim that resolves already-completed short-circuits immediately with zero further RPC or WhatsApp calls', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([baseTask({ quality_review_status: 'approved' })]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-9', status: 'completed', decision: 'approved_alternative', outcome: 'approved' })); // claim RPC returns already-completed
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, outcome: 'approved', already_completed: true }));
    expect(fetchMock).toHaveBeenCalledTimes(3); // auth, task fetch, claim RPC — nothing else
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
  });

  it('[8] a duplicate/retry PATCH after the WhatsApp message was already accepted skips the Meta send entirely — no duplicated outbound message — and still completes exactly once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([baseTask()]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'approved_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve — same message/delivery reused from the first attempt
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'accepted' }])) // fetchDeliveryStatus — already accepted from a prior attempt
      .mockResolvedValueOnce(emptyResponse()) // complete_custom_instruction RPC — goes straight here, skipping the fence + send
      .mockResolvedValueOnce(emptyResponse()); // markApprovedAlternativeConfirmationOnly PATCH
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'approved_alternative', outcome: 'approved' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false); // no second send
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/reserve_send_window'))).toBe(false); // the pre-send fence is skipped too
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('[9] failure paths never report success: missing Authorization header', async () => {
    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative' }, {}), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('[9] failure paths never report success: the authenticated user does not own the task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-999' })) // auth/v1/user
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1' }])); // task fetch — different owner
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('[9] failure paths never report success: the WhatsApp send is rejected synchronously by Meta — the task never completes and no duplicate attempt is queued', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([baseTask()]))
      .mockResolvedValueOnce(jsonResponse({ id: 'decision-1', lease_token: 'lease-1', status: 'processing', decision: 'approved_alternative' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Christopher', phone: '+15551234567' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'msg-1', delivery_id: 'delivery-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ delivery_status: 'pending' }]))
      .mockResolvedValueOnce(emptyResponse()) // reserve_send_window
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'ecosystem engagement' } }, 400)) // Meta rejects
      .mockResolvedValueOnce(emptyResponse()); // markWhatsappDeliveryFailed PATCH
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: 'task-1', decision: 'approved_alternative', reviewedAt: '2026-07-10T00:00:00.000Z' }), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/complete_custom_instruction'))).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('graph.facebook.com'))).toHaveLength(1); // one attempt, no duplicate
  });

  it('[10] Reject Alternative and Custom Instruction: the real Postgres completion functions produce the exact final field values the client half proves resolve to the correct lifecycle state (source-level regression guard — the state transition itself runs inside SECURITY DEFINER functions vitest cannot execute)', () => {
    const migrationSource = readFileSync(
      join(__dirname, '..', 'supabase', 'migrations', '20260710_quality_substitute_review.sql'),
      'utf-8',
    );

    const rejectedFn = migrationSource.slice(
      migrationSource.indexOf('CREATE OR REPLACE FUNCTION public.complete_rejected_alternative'),
      migrationSource.indexOf('CREATE OR REPLACE FUNCTION public.complete_custom_instruction'),
    );
    // Matches src/lib/alternative-review-golden-contract.test.ts's [10] Reject
    // assertion: quality_review_status ends at "correction_required".
    expect(rejectedFn).toContain("quality_review_status = 'correction_required'");

    const customInstructionFn = migrationSource.slice(
      migrationSource.indexOf('CREATE OR REPLACE FUNCTION public.complete_custom_instruction'),
      migrationSource.indexOf('-- ── Execute grants'),
    );
    // Matches the client half's [10] Custom Instruction assertion:
    // quality_review_status is cleared to NULL (not left at
    // substitute_review, not set to approved) and proof_image_path is not
    // touched by this function at all — the client's proof_submitted
    // resolution depends on exactly this.
    expect(customInstructionFn).toContain('quality_review_status = NULL, quality_review_note = NULL, quality_reviewed_at = NULL, worker_reply = NULL');
    expect(customInstructionFn).not.toMatch(/proof_image_path/);
    expect(customInstructionFn).not.toMatch(/status\s*=\s*'done'/);
  });
});

function patchReq(body, headers = { authorization: 'Bearer good-token' }) {
  return { method: 'PATCH', headers, body };
}

function createReq(body, method = 'POST', headers = {}) {
  return { method, headers, body };
}

function createRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
  };
}

function metaAcceptedResponse(messageId = 'wamid.golden') {
  return {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(JSON.stringify({ messages: [{ id: messageId }] })),
  };
}

function anthropicResponse(text) {
  return {
    ok: true,
    json: async () => ({ content: [{ text }] }),
  };
}
