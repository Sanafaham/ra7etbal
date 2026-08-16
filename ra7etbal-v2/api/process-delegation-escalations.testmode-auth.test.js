import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same pattern already established in golden-journey-immediate-staff-delegation.test.js --
// real web-push validates VAPID key byte-length, which a dummy test value never satisfies.
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

import handler from './process-delegation-escalations.js';

/**
 * Remediation 4 (Carson Engineering Hardening Project) closed a real
 * unauthenticated bypass: ?testMode=true previously skipped isAuthorized()
 * entirely, letting anyone trigger the real escalation/followup sweep --
 * which itself makes several unauthenticated calls into
 * /api/send-whatsapp-task. These tests prove that gap is closed and that
 * legitimate authenticated/testMode use still works.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    CRON_SECRET: 'cron-secret',
    VAPID_PUBLIC_KEY: 'vapid-public',
    VAPID_PRIVATE_KEY: 'vapid-private',
    VAPID_SUBJECT: 'mailto:test@test.com',
    APP_BASE_URL: 'https://ra7etbal.test',
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockReq({ method = 'GET', query = {}, headers = {}, body = {} } = {}) {
  return { method, query, headers, body, url: buildUrl(query) };
}

function buildUrl(query) {
  const params = new URLSearchParams(query).toString();
  return params ? `/api/process-delegation-escalations?${params}` : '/api/process-delegation-escalations';
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

/** Empty-results catch-all so an authorized request completes without needing full DB fixtures -- the sweep logic itself is exercised elsewhere. This only proves the auth gate lets a legitimate call through. */
function emptyDbFetchMock() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [],
    text: async () => '[]',
  });
}

describe('process-delegation-escalations — testMode cannot bypass authentication', () => {
  it('rejects ?testMode=true with no authorization at all', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { testMode: 'true' }, headers: {} }), res);

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects ?testMode=true with a wrong CRON_SECRET', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(
      mockReq({ query: { testMode: 'true' }, headers: { authorization: 'Bearer wrong-secret' } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts ?testMode=true WITH a valid CRON_SECRET -- testMode still works, just not as a bypass', async () => {
    vi.stubGlobal('fetch', emptyDbFetchMock());
    const res = mockRes();

    await handler(
      mockReq({ query: { testMode: 'true' }, headers: { authorization: 'Bearer cron-secret' } }),
      res,
    );

    expect(res.statusCode).not.toBe(401);
  });

  it('non-testMode requests still require the same authorization as before (unchanged production behavior)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handler(mockReq({ headers: {} }), res);

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a valid CRON_SECRET without testMode still authorizes normally (production behavior otherwise unchanged)', async () => {
    vi.stubGlobal('fetch', emptyDbFetchMock());
    const res = mockRes();

    await handler(mockReq({ headers: { authorization: 'Bearer cron-secret' } }), res);

    expect(res.statusCode).not.toBe(401);
  });
});
