import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from './send-whatsapp-task.js';

/**
 * Remediation 4 (Carson Engineering Hardening Project) closed a real
 * unauthenticated-send vulnerability: every mode except 'routine_message'
 * had zero authentication, letting anyone POST an arbitrary phone number
 * and message text and trigger a real WhatsApp send through the business's
 * own Meta account. This file proves the new authentication boundary:
 * exactly two trusted caller classes (verified Supabase JWT for browser
 * callers, the existing internal-secret contract for server callers), with
 * ownership verification for browser-supplied resource ids, failing closed
 * before any delivery-evidence write or Meta/Twilio call.
 *
 * Template/payload/delivery-evidence behavior itself is already covered by
 * send-whatsapp-task.test.js -- this file is scoped to the auth boundary
 * only, per this project's established pattern (see
 * api/anthropic.test.js, api/google-calendar.oauth-state.test.js).
 */

const ORIGINAL_ENV = { ...process.env };
const VALID_UID = '11111111-1111-1111-1111-111111111111';
const OTHER_UID = '22222222-2222-2222-2222-222222222222';

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

/** Never routes to graph.facebook.com or writes profiles/tasks/etc -- proves a rejected request never reaches send execution or evidence writes. */
function noNetworkCallsFetchMock() {
  return vi.fn();
}

/** Resolves auth/v1/user to VALID_UID, then any subsequent REST lookup as configured by the test. */
function ownershipFetchMock({ ownsTask = true, ownsPerson = true, ownsMessage = true } = {}) {
  return vi.fn().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonResponse({ id: VALID_UID });
    if (u.includes('/rest/v1/tasks')) return jsonResponse(ownsTask ? [{ id: 'task-1' }] : []);
    if (u.includes('/rest/v1/people')) return jsonResponse(ownsPerson ? [{ id: 'person-1' }] : []);
    if (u.includes('/rest/v1/messages')) return jsonResponse(ownsMessage ? [{ id: 'message-1' }] : []);
    throw new Error(`Unexpected fetch: ${u}`);
  });
}

describe('api/send-whatsapp-task — unauthenticated requests rejected before any send or evidence write', () => {
  it('rejects the default (delegation/task template) send mode', async () => {
    const fetchMock = noNetworkCallsFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(mockReq({ body: { to: '971500000000', messageText: 'hi', taskId: 'task-1' } }), res);

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects sendMode: direct_message', async () => {
    const fetchMock = noNetworkCallsFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({ body: { to: '971500000000', messageText: 'hi', sendMode: 'direct_message', messageRecordId: 'msg-1' } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects sendMode: routine_message', async () => {
    const fetchMock = noNetworkCallsFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(mockReq({ body: { to: '971500000000', messageText: 'hi', sendMode: 'routine_message' } }), res);

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid/expired JWT', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'invalid' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({ headers: { authorization: 'Bearer not-a-real-token' }, body: { to: '971500000000', messageText: 'hi' } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
  });

  it('rejects a wrong internal secret (never trusted as either caller class)', async () => {
    const fetchMock = noNetworkCallsFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({ headers: { 'x-ra7etbal-internal-secret': 'wrong-secret' }, body: { to: '971500000000', messageText: 'hi' } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('api/send-whatsapp-task — ownership binding for browser (JWT) callers', () => {
  it('a valid owner JWT succeeds for resources the caller actually owns', async () => {
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
          to: '971500000000',
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
  });

  it('rejects a cross-account taskId the verified caller does not own', async () => {
    const fetchMock = ownershipFetchMock({ ownsTask: false });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: 'Bearer valid-jwt' },
        body: { to: '971500000000', messageText: 'hi', taskId: 'task-belongs-to-someone-else', confirmationLink: 'https://x' },
      }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('whatsapp_deliveries'))).toBe(false);
  });

  it('rejects a cross-account personId the verified caller does not own', async () => {
    const fetchMock = ownershipFetchMock({ ownsPerson: false });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: 'Bearer valid-jwt' },
        body: { to: '971500000000', messageText: 'hi', personId: 'person-belongs-to-someone-else' },
      }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
  });

  it('rejects a cross-account messageRecordId the verified caller does not own', async () => {
    const fetchMock = ownershipFetchMock({ ownsMessage: false });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: 'Bearer valid-jwt' },
        body: {
          to: '971500000000',
          messageText: 'hi',
          sendMode: 'direct_message',
          messageRecordId: 'message-belongs-to-someone-else',
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
  });

  it('a verified caller referencing no resource ids at all (e.g. a fresh direct message with no prior record) is not blocked by the ownership check', async () => {
    // Ownership checks only fire for a supplied id -- absence is not itself
    // suspicious, since not every send mode requires a pre-existing resource.
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/auth/v1/user')) return jsonResponse({ id: VALID_UID });
      if (u.includes('/rest/v1/whatsapp_deliveries') && !u.includes('id=eq')) return jsonResponse([{ id: 'delivery-1' }]);
      if (u.includes('/rest/v1/whatsapp_deliveries?id=eq')) return jsonResponse({});
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: 'Bearer valid-jwt' },
        body: { to: '971500000000', messageText: '' }, // deliberately fails later validation, not auth
      }),
      res,
    );

    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});

describe('api/send-whatsapp-task — internal server callers', () => {
  it('a valid internal secret succeeds without any ownership lookup (internal callers derive resources from trusted server state)', async () => {
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
          messageText: 'Following up: task text',
          confirmationLink: 'https://www.ra7etbal.com/confirm?task=task-1',
          taskId: 'task-1',
          sourceType: 'followup',
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload?.success).toBe(true);
    // No auth/v1/user or ownership lookup should ever be made for an internal caller.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/v1/user'))).toBe(false);
  });
});
