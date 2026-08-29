import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from './send-whatsapp-task.js';

/**
 * Supplemental security review (2026-08-29) — routine_message never
 * required an owned taskId/personId/messageRecordId (verifyOwnedResource
 * treats an omitted id as "nothing to check"), so an authenticated Ra7etBal
 * account could send a WhatsApp routine_message to any phone number with
 * zero relationship check, abusing the app's own verified Meta business
 * sender against arbitrary third parties. Fixed: a routine_message must
 * resolve to a person the verified caller actually owns, and the requested
 * `to` must match that person's own stored phone number.
 */

const ORIGINAL_ENV = { ...process.env };
const VALID_UID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    WHATSAPP_ACCESS_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    VITE_SUPABASE_ANON_KEY: 'anon-key',
    CRON_SECRET: 'cron-secret',
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockReq({ headers = {}, body = {} } = {}) {
  return { method: 'POST', headers, body };
}

function mockRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function jsonResponse(payload, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/** Owner has one person (PERSON_ID) with a real stored phone. */
const PERSON_ID = 'person-1';
const OWNED_PERSON_PHONE = '971500000001';

function routineFetchMock({ personRows = [{ phone: OWNED_PERSON_PHONE }] } = {}) {
  return vi.fn().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonResponse({ id: VALID_UID });
    if (u.includes('/rest/v1/tasks')) return jsonResponse([]); // no taskId supplied in these tests
    if (u.includes('/rest/v1/messages')) return jsonResponse([]); // no messageRecordId supplied
    if (u.includes('/rest/v1/people') && u.includes('select=phone')) return jsonResponse(personRows);
    if (u.includes('/rest/v1/people')) return jsonResponse(personRows.length ? [{ id: PERSON_ID }] : []);
    if (u.includes('/rest/v1/whatsapp_deliveries') && !u.includes('id=eq')) return jsonResponse([{ id: 'delivery-1' }]);
    if (u.includes('/rest/v1/whatsapp_deliveries?id=eq')) return jsonResponse({});
    if (u.includes('graph.facebook.com')) return jsonResponse({ messages: [{ id: 'wamid.1' }] });
    throw new Error(`Unexpected fetch: ${u}`);
  });
}

describe('api/send-whatsapp-task — routine_message recipient must be an owned person, matched by phone (2026-08-29 supplemental security fix)', () => {
  it('1. authenticated owner + owned person + matching destination phone -> PASS', async () => {
    const fetchMock = routineFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: 'Bearer valid-jwt' },
        body: {
          to: OWNED_PERSON_PHONE,
          messageText: 'Reminder: bins out tonight.',
          sendMode: 'routine_message',
          personId: PERSON_ID,
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload?.success).toBe(true);
  });

  it('2. authenticated user + no ownership anchor (no personId at all) -> DENY', async () => {
    const fetchMock = routineFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: 'Bearer valid-jwt' },
        body: {
          to: '971500009999', // arbitrary, unrelated number
          messageText: 'hi',
          sendMode: 'routine_message',
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
  });

  it("3. authenticated user + another tenant's personId -> DENY", async () => {
    // people lookup scoped by user_id=eq.<verifiedUid> returns nothing for
    // a personId that exists but belongs to a different account.
    const fetchMock = routineFetchMock({ personRows: [] });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: 'Bearer valid-jwt' },
        body: {
          to: OWNED_PERSON_PHONE,
          messageText: 'hi',
          sendMode: 'routine_message',
          personId: 'person-belongs-to-someone-else',
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
  });

  it('4. authenticated user + owned personId but mismatched arbitrary `to` -> DENY', async () => {
    const fetchMock = routineFetchMock(); // owned person's real phone is OWNED_PERSON_PHONE
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: 'Bearer valid-jwt' },
        body: {
          to: '971599999999', // does NOT match the owned person's stored phone
          messageText: 'hi',
          sendMode: 'routine_message',
          personId: PERSON_ID,
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
  });

  it('5. the cron/internal authorized path remains unaffected — no ownership/phone lookup at all for routine_message', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/rest/v1/whatsapp_deliveries') && !u.includes('id=eq')) return jsonResponse([{ id: 'delivery-1' }]);
      if (u.includes('/rest/v1/whatsapp_deliveries?id=eq')) return jsonResponse({});
      if (u.includes('graph.facebook.com')) return jsonResponse({ messages: [{ id: 'wamid.1' }] });
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { 'x-ra7etbal-internal-secret': 'cron-secret' },
        body: {
          to: '971500000000',
          messageText: 'Automated routine reminder.',
          sendMode: 'routine_message',
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload?.success).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/people'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/v1/user'))).toBe(false);
  });

  it('6. existing task-template and direct_message sends are unaffected by this check (no personId required, no phone-match enforced)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/auth/v1/user')) return jsonResponse({ id: VALID_UID });
      if (u.includes('/rest/v1/tasks') && u.includes('user_id')) return jsonResponse([{ id: 'task-1' }]);
      if (u.includes('/rest/v1/whatsapp_deliveries') && !u.includes('id=eq')) return jsonResponse([{ id: 'delivery-1' }]);
      if (u.includes('/rest/v1/whatsapp_deliveries?id=eq')) return jsonResponse({});
      if (u.includes('graph.facebook.com')) return jsonResponse({ messages: [{ id: 'wamid.1' }] });
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: 'Bearer valid-jwt' },
        body: {
          to: '971500000000', // no owned person at all -- unaffected since sendMode isn't routine_message
          messageText: 'Please confirm.',
          confirmationLink: 'https://www.ra7etbal.com/confirm?task=task-1',
          taskId: 'task-1',
          sourceType: 'delegation',
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload?.success).toBe(true);
    // No people lookup should occur at all -- no personId was supplied and
    // this isn't a routine_message.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/people'))).toBe(false);
  });
});
