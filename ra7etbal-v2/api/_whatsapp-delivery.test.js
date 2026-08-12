import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginWhatsappDelivery,
  getMetaFailure,
  markWhatsappDeliveryAccepted,
  markWhatsappDeliveryFailed,
} from './_whatsapp-delivery.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WhatsApp delivery persistence', () => {
  it('derives ownership from a task and creates a pending delivery row', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const deliveryId = await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      taskId: 'task-1',
      sourceType: 'delegation',
      recipientPhone: '971500000000',
      recipientName: 'Grace',
    });

    expect(deliveryId).toBe('delivery-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const insertOptions = fetchMock.mock.calls[1][1];
    const inserted = JSON.parse(insertOptions.body);
    expect(inserted).toMatchObject({
      user_id: 'user-1',
      task_id: 'task-1',
      source_type: 'delegation',
      delivery_status: 'pending',
      recipient_phone: '971500000000',
      recipient_name: 'Grace',
    });
  });

  // ── Phase B owner-notification audit gap (2026-07-27) ────────────────────
  //
  // Confirmed live production defect: notifyOwnerOfEscalation (Phase B)
  // called beginWhatsappDelivery with no messageRecordId, no routineId, no
  // automationRunId, and taskId null (the common case — an escalation with
  // no linked task). resolveDeliveryContext's `lookups` array stayed empty,
  // so it returned null immediately, and beginWhatsappDelivery logged
  // "skipped: no trusted owner context" and returned null — the real Meta
  // send still succeeded (owner_notification_status ended 'sent' via the
  // separate, unaffected atomic lease), but zero whatsapp_deliveries row
  // was ever created for it. staffMessageId is the fix: a new trusted
  // lookup against staff_messages, mirroring the existing message/task/
  // routine/automation_run pattern.

  it('reproduces the exact original Phase B bug shape: no linkage at all skips the insert (fails open)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const deliveryId = await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      taskId: null, // the real call shape from _escalation-notify.js for a taskless escalation
      sourceType: 'message',
      recipientPhone: '+905010589614',
      recipientName: 'Owner',
      templateName: 'ra7etbal_owner_decision',
      metadata: { escalation_id: 'esc-1', staff_message_id: 'staff-msg-1' },
    });

    expect(deliveryId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('derives ownership from a linked staff message and creates a pending delivery row, without writing staff_messages.id into message_id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-msg-1', user_id: 'user-1', task_id: null }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-9' }]));
    vi.stubGlobal('fetch', fetchMock);

    const deliveryId = await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      staffMessageId: 'staff-msg-1',
      taskId: null,
      sourceType: 'message',
      recipientPhone: '+905010589614',
      recipientName: 'Owner',
      templateName: 'ra7etbal_owner_decision',
      metadata: { escalation_id: 'esc-1', staff_message_id: 'staff-msg-1' },
    });

    expect(deliveryId).toBe('delivery-9');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const lookupUrl = fetchMock.mock.calls[0][0];
    expect(lookupUrl).toContain('/rest/v1/staff_messages');
    expect(lookupUrl).toContain('id=eq.staff-msg-1');

    const insertOptions = fetchMock.mock.calls[1][1];
    const inserted = JSON.parse(insertOptions.body);
    expect(inserted).toMatchObject({
      user_id: 'user-1',
      task_id: null,
      source_type: 'message',
      template_name: 'ra7etbal_owner_decision',
      delivery_status: 'pending',
      recipient_phone: '+905010589614',
      metadata: { escalation_id: 'esc-1', staff_message_id: 'staff-msg-1' },
    });
    // whatsapp_deliveries.message_id has a foreign key to public.messages —
    // a staff_messages id must never be written there.
    expect(inserted.message_id).toBeNull();
  });

  it('inherits task_id from a linked staff message when the staff message has one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-msg-2', user_id: 'user-1', task_id: 'task-9' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-10' }]));
    vi.stubGlobal('fetch', fetchMock);

    await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      staffMessageId: 'staff-msg-2',
      sourceType: 'message',
      recipientPhone: '+905010589614',
      templateName: 'ra7etbal_owner_decision',
      metadata: { escalation_id: 'esc-2', staff_message_id: 'staff-msg-2' },
    });

    const inserted = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(inserted.task_id).toBe('task-9');
  });

  it('skips the insert (fails open) when the linked staff message cannot be found', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([])); // no matching staff_messages row
    vi.stubGlobal('fetch', fetchMock);

    const deliveryId = await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      staffMessageId: 'missing-staff-msg',
      sourceType: 'message',
      recipientPhone: '+905010589614',
      templateName: 'ra7etbal_owner_decision',
    });

    expect(deliveryId).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the failed lookup, never an insert attempt
  });

  it('a delivery status update on a null deliveryId (audit row never created) logs visibly instead of silently no-oping', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await markWhatsappDeliveryAccepted({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      deliveryId: null,
      metaMessageId: 'wamid.owner-1',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipped: no deliveryId'));
  });

  it('a linked staff-message delivery row can still be updated to accepted once Meta accepts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-msg-3', user_id: 'user-1', task_id: null }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-11' }]))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const deliveryId = await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      staffMessageId: 'staff-msg-3',
      sourceType: 'message',
      recipientPhone: '+905010589614',
      templateName: 'ra7etbal_owner_decision',
      metadata: { staff_message_id: 'staff-msg-3' },
    });
    expect(deliveryId).toBe('delivery-11');

    await markWhatsappDeliveryAccepted({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      deliveryId,
      metaMessageId: 'wamid.owner-1',
      templateName: 'ra7etbal_owner_decision',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const patchUrl = fetchMock.mock.calls[2][0];
    const patchOptions = fetchMock.mock.calls[2][1];
    expect(patchUrl).toContain('id=eq.delivery-11');
    expect(patchOptions.method).toBe('PATCH');
    const patched = JSON.parse(patchOptions.body);
    expect(patched.delivery_status).toBe('accepted');
    expect(patched.meta_message_id).toBe('wamid.owner-1');
  });

  it('does not affect a task-linked (Alternative Review) delivery using the same ra7etbal_owner_decision template', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const deliveryId = await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      taskId: 'task-1', // no staffMessageId — this is the pre-existing Alternative Review call shape
      sourceType: 'delegation',
      recipientPhone: '+12025691377',
      templateName: 'ra7etbal_owner_decision',
    });

    expect(deliveryId).toBe('delivery-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lookupUrl = fetchMock.mock.calls[0][0];
    expect(lookupUrl).toContain('/rest/v1/tasks');
    expect(lookupUrl).not.toContain('staff_messages');
  });

  it('fails open when delivery storage is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('storage unavailable')));

    await expect(
      beginWhatsappDelivery({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        taskId: 'task-1',
        sourceType: 'delegation',
      }),
    ).resolves.toBeNull();
  });

  it('fails open when accepted and failed status updates cannot be stored', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('patch unavailable')));

    await expect(
      markWhatsappDeliveryAccepted({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        deliveryId: 'delivery-1',
        metaMessageId: 'wamid.1',
      }),
    ).resolves.toBeUndefined();

    await expect(
      markWhatsappDeliveryFailed({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        deliveryId: 'delivery-1',
        failureStage: 'network',
        reason: 'network down',
      }),
    ).resolves.toBeUndefined();
  });

  it('extracts structured Meta failure details', () => {
    expect(
      getMetaFailure({
        status: 400,
        metaError: {
          code: 131047,
          error_subcode: 2494010,
          message: 'Message failed',
          error_data: { details: 'Recipient unavailable' },
        },
      }),
    ).toEqual({
      httpStatus: 400,
      code: 131047,
      subcode: 2494010,
      reason: 'Recipient unavailable',
    });
  });

  // ── Durable person_id (Workstream 4 durability fix) ────────────────────
  //
  // person_id is written independent of task_id, so it survives the
  // linked task being deleted later. Only messages/staff_messages carry it
  // — task/routine/automation_run rows have no person_id column.

  it('carries person_id from a linked staff message into the delivery row', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-msg-1', user_id: 'user-1', task_id: null, person_id: 'person-christopher' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-11' }]));
    vi.stubGlobal('fetch', fetchMock);

    await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      staffMessageId: 'staff-msg-1',
      sourceType: 'message',
      recipientPhone: '+905010589614',
    });

    const inserted = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(inserted.person_id).toBe('person-christopher');
  });

  it('carries person_id from a linked message into the delivery row', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'msg-1', user_id: 'user-1', task_id: null, person_id: 'person-grace' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-12' }]));
    vi.stubGlobal('fetch', fetchMock);

    await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageRecordId: 'msg-1',
      sourceType: 'message',
      recipientPhone: '+905010589614',
    });

    const inserted = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(inserted.person_id).toBe('person-grace');
  });

  it('leaves person_id null rather than guessing when linked records disagree on the person', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'msg-1', user_id: 'user-1', task_id: null, person_id: 'person-a' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-msg-1', user_id: 'user-1', task_id: null, person_id: 'person-b' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-13' }]));
    vi.stubGlobal('fetch', fetchMock);

    await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageRecordId: 'msg-1',
      staffMessageId: 'staff-msg-1',
      sourceType: 'message',
      recipientPhone: '+905010589614',
    });

    const inserted = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(inserted.person_id).toBeNull();
  });

  it('leaves person_id null when no linked record carries one (e.g. task-only delegation send)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-14' }]));
    vi.stubGlobal('fetch', fetchMock);

    await beginWhatsappDelivery({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      taskId: 'task-1',
      sourceType: 'delegation',
      recipientPhone: '971500000000',
      recipientName: 'Grace',
    });

    const inserted = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(inserted.person_id).toBeNull();
  });
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}
