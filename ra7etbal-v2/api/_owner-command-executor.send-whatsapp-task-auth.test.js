import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Remediation 4 (Carson Engineering Hardening Project) found that
 * invokeSendWhatsappTask() in _owner-command-executor.js calls
 * send-whatsapp-task.js's default-exported handler directly, in-process --
 * the exact same function the HTTP route uses. Every other regression test
 * for this file mocks that import away (vi.mock('./send-whatsapp-task.js')),
 * which meant the very first auth gate added to that handler would have
 * silently broken this real caller (owner voice commands routed through the
 * Meta-HMAC-verified inbound webhook) without any test failing.
 *
 * This file deliberately does NOT mock send-whatsapp-task.js. It exercises
 * the real handler, including the real authentication gate, with only true
 * I/O boundaries mocked (Supabase REST, the Meta Graph API) -- proving
 * invokeSendWhatsappTask's internal-secret header actually satisfies the
 * handler's internal-caller auth path end to end.
 */
import { persistAndExecuteOwnerCommand } from './_owner-command-executor.js';

const SUPABASE = 'https://example.supabase.co';
const receipt = { receipt_id: '00000000-0000-4000-8000-000000000001', claim_token: 'claim-1' };
const identity = { userId: 'user-1', ownerPhone: '971500000001' };

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

function recorded(overrides = {}) {
  return {
    id: receipt.receipt_id,
    retry_count: 1,
    max_retries: 5,
    acknowledgement_status: 'pending',
    execution_result: {},
    action_task_id: null,
    action_message_id: null,
    staff_transport_message_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env.QSTASH_TOKEN = 'qstash-token';
  process.env.CRON_SECRET = 'cron-secret';
  process.env.APP_BASE_URL = 'https://www.ra7etbal.com';
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
});

describe('owner command executor -- real send-whatsapp-task auth boundary (not mocked)', () => {
  it('a direct-message owner command reaches the real handler, passes the internal-secret gate, and actually sends', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) return response(recorded());
      if (target.includes('/profiles?')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/people?')) {
        return response([{ id: 'person-1', name: 'Grace', phone: '+971500000002', whatsapp_opted_in: true }]);
      }
      if (target.endsWith('/rest/v1/messages') && options.method === 'POST') return response([JSON.parse(options.body)]);
      if (target.includes('/rest/v1/messages?') && (!options.method || options.method === 'GET')) {
        // resolveDeliveryContext's messageRecordId -> user_id/person_id lookup.
        return response([{ id: 'message-1', user_id: identity.userId, task_id: null, person_id: 'person-1' }]);
      }
      if (target.includes('/rest/v1/messages?') && options.method === 'PATCH') {
        // markMessageAccepted's post-send whatsapp_message_id update.
        return response({});
      }
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') return response([recorded()]);
      if (target.includes('/whatsapp_deliveries?') && options.method === 'PATCH') return response({});
      if (target.includes('/whatsapp_deliveries?') && (!options.method || options.method === 'GET')) {
        // _owner-command-executor.js's own pre-send existing-delivery lookup.
        return response([]);
      }
      if (target.endsWith('/rest/v1/whatsapp_deliveries') && options.method === 'POST') {
        return response([{ id: 'delivery-1' }]);
      }
      if (target.startsWith('https://graph.facebook.com/v20.0/')) {
        return response({ messages: [{ id: 'wamid.owner-command-1' }] });
      }
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: { body: 'Ask Grace to call myself.', phoneNumberId: 'phone-1' },
    });

    expect(result.kind).toBe('completed');

    // The real handler must have been reached and must have actually sent --
    // proving the internal-secret header on invokeSendWhatsappTask's request
    // satisfies the handler's own authentication gate, not a mock standing in
    // for it.
    const metaSend = calls.find((call) => call.url.startsWith('https://graph.facebook.com/v20.0/'));
    expect(metaSend).toBeDefined();

    // The real handler never saw an unauthorized (401) or forbidden (403)
    // rejection -- if the internal-secret header were missing or wrong, the
    // handler would reject before ever reaching beginWhatsappDelivery or the
    // Meta send, and neither the whatsapp_deliveries insert nor the Meta call
    // above would have happened.
    const deliveryInsert = calls.find(
      (call) => call.url.endsWith('/rest/v1/whatsapp_deliveries') && call.options.method === 'POST',
    );
    expect(deliveryInsert).toBeDefined();
  });

  it('if the internal secret is ever wrong or missing, the real handler rejects and the owner command surfaces a real failure (never a false "completed")', async () => {
    // Deliberately break the contract this test guards, to prove the
    // assertions above would actually catch a regression: simulate the
    // pre-fix state by clearing CRON_SECRET so isValidInternalSecret() in
    // send-whatsapp-task.js can never match, and confirm the real handler
    // correctly fails closed rather than silently succeeding.
    delete process.env.CRON_SECRET;

    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) return response(recorded());
      if (target.includes('/profiles?')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/people?')) {
        return response([{ id: 'person-1', name: 'Grace', phone: '+971500000002', whatsapp_opted_in: true }]);
      }
      if (target.endsWith('/rest/v1/messages') && options.method === 'POST') return response([JSON.parse(options.body)]);
      if (target.includes('/rest/v1/messages?') && (!options.method || options.method === 'GET')) {
        // resolveDeliveryContext's messageRecordId -> user_id/person_id lookup.
        return response([{ id: 'message-1', user_id: identity.userId, task_id: null, person_id: 'person-1' }]);
      }
      if (target.includes('/rest/v1/messages?') && options.method === 'PATCH') {
        // markMessageAccepted's post-send whatsapp_message_id update.
        return response({});
      }
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') return response([recorded()]);
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: { body: 'Ask Grace to call myself.', phoneNumberId: 'phone-1' },
    });

    expect(result.kind).not.toBe('completed');
    expect(calls.some((call) => call.url.startsWith('https://graph.facebook.com/v20.0/'))).toBe(false);
  });
});
