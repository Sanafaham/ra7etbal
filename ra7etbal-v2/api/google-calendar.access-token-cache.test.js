import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { __resetGoogleAccessTokenCacheForTests } from "./google-calendar.js";

// Confirmed production latency finding: create_calendar_event (and every
// other calendar route) re-exchanged the stored refresh_token for a brand
// new Google OAuth access token on EVERY single call, adding one
// unavoidable external round trip to accounts.google.com even for calls
// seconds apart in the same voice session. These tests prove the fix --
// getGoogleAccessToken()'s in-memory, per-uid cache -- without weakening
// auth correctness, token security, or user isolation.

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    VITE_SUPABASE_ANON_KEY: "anon-key",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
  };
  __resetGoogleAccessTokenCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetGoogleAccessTokenCacheForTests();
});

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

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function createEventBody(overrides = {}) {
  return {
    title: "Hairdresser",
    date: "2026-09-08",
    time: "16:00",
    duration_minutes: 60,
    ...overrides,
  };
}

/**
 * A URL-keyed fetch mock (not sequential mockResolvedValueOnce, which is
 * fragile across multiple handler() calls in one test) so tests can call
 * the handler more than once and independently assert how many times each
 * external dependency (Supabase auth, Supabase profile, Google OAuth
 * token endpoint, Google Calendar API) was actually hit.
 */
function buildFetchMock({
  userId = "user-1",
  refreshToken = "refresh-token",
  accessTokens = ["access-token-1", "access-token-2", "access-token-3"],
  expiresIn = 3600,
  calendarResponder,
} = {}) {
  let accessTokenCalls = 0;
  let calendarCalls = 0;
  const calendarAuthHeaders = [];

  const fetchMock = vi.fn(async (url, options = {}) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) {
      return jsonResponse({ id: userId });
    }
    if (u.includes("/rest/v1/profiles")) {
      if (options.method === "PATCH") return jsonResponse({}, 204);
      return jsonResponse([
        { google_refresh_token: refreshToken, morning_brief_timezone: "Europe/Istanbul" },
      ]);
    }
    if (u.includes("oauth2.googleapis.com/token")) {
      const token = accessTokens[Math.min(accessTokenCalls, accessTokens.length - 1)];
      accessTokenCalls += 1;
      return jsonResponse({ access_token: token, expires_in: expiresIn });
    }
    if (u.includes("www.googleapis.com/calendar")) {
      calendarCalls += 1;
      calendarAuthHeaders.push(options.headers?.Authorization ?? null);
      if (calendarResponder) return calendarResponder({ callCount: calendarCalls, options });
      return jsonResponse({
        id: "evt-1",
        summary: "Hairdresser",
        start: { dateTime: "2026-09-08T16:00:00" },
        end: { dateTime: "2026-09-08T17:00:00" },
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });

  return {
    fetchMock,
    accessTokenCallCount: () => accessTokenCalls,
    calendarCallCount: () => calendarCalls,
    calendarAuthHeaders,
  };
}

async function createEvent(fetchMock, body = createEventBody(), headers = { authorization: "Bearer jwt" }) {
  vi.stubGlobal("fetch", fetchMock);
  const req = { method: "POST", headers, body, query: {} };
  const res = mockRes();
  await handler(req, res);
  return res;
}

describe("Google Calendar access-token cache", () => {
  it("valid cached token reuse: a second create_calendar_event call in the same session does not re-exchange the refresh token", async () => {
    const { fetchMock, accessTokenCallCount, calendarCallCount } = buildFetchMock();

    const res1 = await createEvent(fetchMock);
    expect(res1.statusCode).toBe(200);
    expect(res1.payload.ok).toBe(true);
    expect(accessTokenCallCount()).toBe(1);

    const res2 = await createEvent(fetchMock, createEventBody({ title: "Dentist" }));
    expect(res2.statusCode).toBe(200);
    expect(res2.payload.ok).toBe(true);
    // The second call reused the cached access token -- no second exchange.
    expect(accessTokenCallCount()).toBe(1);
    expect(calendarCallCount()).toBe(2);
  });

  it("event correctness: the cached-token path still returns the correct persisted event fields", async () => {
    const { fetchMock } = buildFetchMock();
    const res = await createEvent(fetchMock, createEventBody({ title: "Hairdresser" }));
    expect(res.payload).toMatchObject({
      ok: true,
      id: "evt-1",
      title: "Hairdresser",
      start: "2026-09-08T16:00:00",
      end: "2026-09-08T17:00:00",
    });
  });

  it("expiry + refresh: a token that expires within the safety buffer is not reused -- the next call re-exchanges and uses the new token", async () => {
    // expires_in well inside ACCESS_TOKEN_SAFETY_BUFFER_MS (60s) so the very
    // next lookup must treat it as unusable rather than silently serving a
    // token that Google would already be about to reject.
    const { fetchMock, accessTokenCallCount, calendarAuthHeaders } = buildFetchMock({
      expiresIn: 30,
      accessTokens: ["access-token-1", "access-token-2"],
    });

    await createEvent(fetchMock);
    expect(accessTokenCallCount()).toBe(1);

    await createEvent(fetchMock, createEventBody({ title: "Dentist" }));
    expect(accessTokenCallCount()).toBe(2);
    expect(calendarAuthHeaders[0]).toBe("Bearer access-token-1");
    expect(calendarAuthHeaders[1]).toBe("Bearer access-token-2");
  });

  it("401 recovery: a cached token rejected by the live Calendar API is invalidated and retried once with a freshly exchanged token", async () => {
    const { fetchMock, accessTokenCallCount, calendarCallCount } = buildFetchMock({
      accessTokens: ["stale-cached-token", "fresh-token-after-401"],
      calendarResponder: ({ callCount }) =>
        callCount === 1
          ? jsonResponse({ error: "invalid_credentials" }, 401)
          : jsonResponse({
              id: "evt-2",
              summary: "Hairdresser",
              start: { dateTime: "2026-09-08T16:00:00" },
              end: { dateTime: "2026-09-08T17:00:00" },
            }),
    });

    const res = await createEvent(fetchMock);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ok: true, id: "evt-2" });
    // One initial exchange, then one forced re-exchange after the 401.
    expect(accessTokenCallCount()).toBe(2);
    // One rejected call, one successful retry.
    expect(calendarCallCount()).toBe(2);
  });

  it("user isolation: two different owners never share a cached access token, and each gets exactly one exchange for their own first call", async () => {
    const userA = buildFetchMock({
      userId: "user-a",
      refreshToken: "refresh-a",
      accessTokens: ["token-a"],
    });
    const userB = buildFetchMock({
      userId: "user-b",
      refreshToken: "refresh-b",
      accessTokens: ["token-b"],
    });

    const resA1 = await createEvent(userA.fetchMock, createEventBody(), { authorization: "Bearer jwt-a" });
    expect(resA1.payload.ok).toBe(true);
    expect(userA.calendarAuthHeaders[0]).toBe("Bearer token-a");

    const resB1 = await createEvent(userB.fetchMock, createEventBody(), { authorization: "Bearer jwt-b" });
    expect(resB1.payload.ok).toBe(true);
    // User B's very first call must exchange its own token, not reuse
    // anything cached under user A's uid.
    expect(userB.accessTokenCallCount()).toBe(1);
    expect(userB.calendarAuthHeaders[0]).toBe("Bearer token-b");

    // A second call for user A still hits its own cached token, unaffected
    // by user B's request in between.
    const resA2 = await createEvent(userA.fetchMock, createEventBody({ title: "Second" }), { authorization: "Bearer jwt-a" });
    expect(resA2.payload.ok).toBe(true);
    expect(userA.accessTokenCallCount()).toBe(1);
    expect(userA.calendarAuthHeaders[1]).toBe("Bearer token-a");
  });

  it("no stale-token silent failure: a revoked refresh token still surfaces reconnect_required, cache or no cache", async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (u.includes("/auth/v1/user")) return jsonResponse({ id: "user-1" });
      if (u.includes("/rest/v1/profiles")) {
        if (options.method === "PATCH") return jsonResponse({}, 204);
        return jsonResponse([{ google_refresh_token: "revoked-token", morning_brief_timezone: "Europe/Istanbul" }]);
      }
      if (u.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });

    const res = await createEvent(fetchMock);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ok: false, code: "reconnect_required" });
  });
});
