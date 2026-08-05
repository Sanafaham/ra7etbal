import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression contract: notifyOwnerOfTaskReview sends a proof photo WhatsApp
 * image message immediately after the text template when proofImagePath is
 * provided, and does not send one when it is absent.
 *
 * The proof photo send is non-fatal: a failure must never prevent
 * owner_notified_at from being stamped or block the primary text notification
 * from being considered 'sent'.
 */

const sendProofImageMessageMock = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
const sendMetaMessageMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, messageId: 'wamid.text-1', metaError: null })));
const whatsappDeliveryMocks = vi.hoisted(() => ({
  beginWhatsappDelivery: vi.fn(async ({ messageKind }) => messageKind === 'image' ? 'delivery-image-1' : 'delivery-text-1'),
  markWhatsappDeliveryAccepted: vi.fn(async () => {}),
  markWhatsappDeliveryFailed: vi.fn(async () => {}),
  getMetaFailure: vi.fn((result) => ({ reason: result?.metaError?.message || 'send_failed' })),
}));

vi.mock('./_whatsapp-delivery.js', () => whatsappDeliveryMocks);

vi.mock('./send-whatsapp-task.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendMetaMessage: sendMetaMessageMock,
    sendProofImageMessage: sendProofImageMessageMock,
  };
});

const { notifyOwnerOfTaskReview } = await import('./_escalation-notify.js');

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body, text: async () => JSON.stringify(body) };
}

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_KEY = 'service-key';
const TASK_ID = 'task-sub-review-1';
const USER_ID = 'user-owner-1';
const DECISION_ROW = {
  id: 'decision-1',
  deep_link_token: 'aaaaaaaa-1111-4111-8111-111111111111',
  owner_notified_at: null,
};
const OWNER_PHONE = [{ name: 'Sana', role: 'boss', phone: '+15550000099' }];
const NOTIFICATION_CLAIM = {
  decision_id: 'decision-1', claimed: true,
  claim_token: 'notification-claim-1', notification_status: 'sending',
};

function makeFetchMock({ decisionRow = DECISION_ROW, alreadySent = false } = {}) {
  return vi.fn()
    .mockResolvedValueOnce(jsonResponse(decisionRow))              // claim_task_escalation_owner_decision
    .mockResolvedValueOnce(jsonResponse(alreadySent ? {
      decision_id: decisionRow.id, claimed: false, claim_token: null, notification_status: 'sent',
    } : NOTIFICATION_CLAIM))                                      // claim notification lease
    .mockResolvedValueOnce(jsonResponse(OWNER_PHONE))              // findOwnerPhone
    .mockResolvedValueOnce(jsonResponse(decisionRow, true));       // complete notification lease
}

const BASE_INPUT = {
  taskId: TASK_ID,
  userId: USER_ID,
  reviewType: 'substitute_review',
  taskDescription: 'Buy TEREA Silver cigarettes',
  assignedTo: 'Christopher',
  reviewNote: 'Christopher found TEREA Turquoise, not Silver.',
};

beforeEach(() => {
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-access-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-number-id-1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  sendMetaMessageMock.mockClear();
  sendProofImageMessageMock.mockClear();
  whatsappDeliveryMocks.beginWhatsappDelivery.mockClear();
  whatsappDeliveryMocks.markWhatsappDeliveryAccepted.mockClear();
  whatsappDeliveryMocks.markWhatsappDeliveryFailed.mockClear();
});

describe('notifyOwnerOfTaskReview — proof photo delivery', () => {
  it('[1] sends proof photo after text template when proofImagePath is provided', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { ...BASE_INPUT, proofImagePath: 'task-images/user-1/task-1/proof/0.jpg' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1); // text template
    expect(sendProofImageMessageMock).toHaveBeenCalledTimes(1);
    expect(sendProofImageMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      imagePath: 'task-images/user-1/task-1/proof/0.jpg',
      to: expect.stringContaining('15550000099'),
      accessToken: 'test-access-token',
      phoneNumberId: 'phone-number-id-1',
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
    }));
  });

  it('[2] does NOT send proof photo when proofImagePath is absent', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { ...BASE_INPUT }, // no proofImagePath
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
    expect(sendProofImageMessageMock).not.toHaveBeenCalled();
  });

  it('[3] does NOT send proof photo when proofImagePath is null', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { ...BASE_INPUT, proofImagePath: null },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
    expect(sendProofImageMessageMock).not.toHaveBeenCalled();
  });

  it('[4] proof photo failure is non-fatal after the notification lease is completed', async () => {
    sendProofImageMessageMock.mockResolvedValueOnce({ sent: false, reason: 'meta_upload_failed' });
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { ...BASE_INPUT, proofImagePath: 'task-images/user-1/task-1/proof/0.jpg' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/rpc/complete_task_review_owner_notification'))).toBe(true);
  });

  it('[5] proof photo send error (throws) is non-fatal — status is still sent', async () => {
    sendProofImageMessageMock.mockRejectedValueOnce(new Error('network timeout'));
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { ...BASE_INPUT, proofImagePath: 'task-images/user-1/task-1/proof/0.jpg' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
  });

  it('[6] proof photo is NOT attempted when text send fails', async () => {
    sendMetaMessageMock.mockResolvedValueOnce({ ok: false, metaError: { message: 'Template rejected' } });
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { ...BASE_INPUT, proofImagePath: 'task-images/user-1/task-1/proof/0.jpg' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('meta_rejected');
    expect(sendProofImageMessageMock).not.toHaveBeenCalled();
  });

  it('[7] skips everything when already notified (owner_notified_at set)', async () => {
    const fetchMock = makeFetchMock({
      decisionRow: { ...DECISION_ROW, owner_notified_at: '2026-08-02T10:00:00Z' },
      alreadySent: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { ...BASE_INPUT, proofImagePath: 'task-images/user-1/task-1/proof/0.jpg' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('skipped_already_sent');
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    expect(sendProofImageMessageMock).not.toHaveBeenCalled();
  });

  it('[8] works for uncertain_proof review type with proof photo', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      {
        taskId: TASK_ID,
        userId: USER_ID,
        reviewType: 'uncertain_proof',
        taskDescription: 'Arrange flowers on the table',
        assignedTo: 'Grace',
        reviewNote: null,
        proofImagePath: 'task-images/user-1/task-1/proof/0.jpg',
      },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
    expect(sendProofImageMessageMock).toHaveBeenCalledTimes(1);
  });
});
