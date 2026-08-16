import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./google-calendar.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    VITE_SUPABASE_ANON_KEY: "anon-key",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_REDIRECT_URI: "https://www.ra7etbal.com/api/google-calendar",
    VERCEL_PROJECT_PRODUCTION_URL: "www.ra7etbal.com",
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockReq({ method = "GET", query = {}, headers = {}, body = {} } = {}) {
  return { method, query, headers, body };
}

function mockRes() {
  return {
    statusCode: 200,
    payload: null,
    redirected: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.redirected = url;
      return this;
    },
  };
}

function jsonResponse(payload, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/** Every call whose URL includes a given substring. */
function callsMatching(fetchMock, substring) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(substring));
}

const VALID_UID = "11111111-1111-1111-1111-111111111111";

/** Builds a fetch mock that handles the auth/v1/user + google_oauth_states insert
 *  sequence for a valid, authenticated init call. */
function mockValidInitSequence() {
  return vi
    .fn()
    .mockImplementation(async (url) => {
      if (String(url).includes("/auth/v1/user")) {
        return jsonResponse({ id: VALID_UID });
      }
      if (String(url).includes("/rest/v1/google_oauth_states") ) {
        return jsonResponse({}, true, 201);
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
}

describe("api/google-calendar — OAuth initiation authentication boundary", () => {
  it("rejects an unauthenticated init request with 401 and makes zero network calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { action: "init" }, headers: {} }), res);

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed/invalid token with 401 and never inserts an oauth state row", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "invalid" }, false, 401));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({ query: { action: "init" }, headers: { authorization: "Bearer not-a-real-token" } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(callsMatching(fetchMock, "google_oauth_states")).toHaveLength(0);
  });

  it("derives identity exclusively from the verified JWT and ignores any client-supplied userId", async () => {
    const fetchMock = mockValidInitSequence();
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    // A caller-supplied userId in the query must never be trusted, even
    // alongside a valid token for a *different* user.
    await handler(
      mockReq({
        query: { action: "init", userId: "22222222-2222-2222-2222-222222222222" },
        headers: { authorization: "Bearer valid-jwt" },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const insertCall = callsMatching(fetchMock, "/rest/v1/google_oauth_states").find(
      ([, init]) => init.method === "POST",
    );
    expect(insertCall).toBeDefined();
    const insertedBody = JSON.parse(insertCall[1].body);
    expect(insertedBody.user_id).toBe(VALID_UID);
  });

  it("generates a high-entropy state and stores only its hash, never the raw value", async () => {
    const fetchMock = mockValidInitSequence();
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { action: "init" }, headers: { authorization: "Bearer valid-jwt" } }), res);

    expect(res.statusCode).toBe(200);
    const redirectUrl = new URL(res.payload.redirectUrl);
    const rawState = redirectUrl.searchParams.get("state");
    expect(rawState).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex-encoded

    const insertCall = callsMatching(fetchMock, "/rest/v1/google_oauth_states").find(
      ([, init]) => init.method === "POST",
    );
    const insertedBody = JSON.parse(insertCall[1].body);
    expect(insertedBody.state_hash).not.toBe(rawState);
    expect(insertedBody.state_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
    expect(insertedBody.state_hash).not.toBe(insertedBody.user_id);
  });

  it("issues a different state token on every call — never reused or predictable", async () => {
    vi.stubGlobal("fetch", mockValidInitSequence());
    const res1 = mockRes();
    const res2 = mockRes();

    await handler(mockReq({ query: { action: "init" }, headers: { authorization: "Bearer valid-jwt" } }), res1);
    await handler(mockReq({ query: { action: "init" }, headers: { authorization: "Bearer valid-jwt" } }), res2);

    const state1 = new URL(res1.payload.redirectUrl).searchParams.get("state");
    const state2 = new URL(res2.payload.redirectUrl).searchParams.get("state");
    expect(state1).not.toBe(state2);
  });

  it("expires the stored state 10 minutes from issuance", async () => {
    const fetchMock = mockValidInitSequence();
    vi.stubGlobal("fetch", fetchMock);
    const before = Date.now();
    const res = mockRes();

    await handler(mockReq({ query: { action: "init" }, headers: { authorization: "Bearer valid-jwt" } }), res);

    const insertCall = callsMatching(fetchMock, "/rest/v1/google_oauth_states").find(
      ([, init]) => init.method === "POST",
    );
    const insertedBody = JSON.parse(insertCall[1].body);
    const expiresAtMs = new Date(insertedBody.expires_at).getTime();
    const deltaMinutes = (expiresAtMs - before) / 60000;
    expect(deltaMinutes).toBeGreaterThan(9.9);
    expect(deltaMinutes).toBeLessThan(10.1);
  });
});

describe("api/google-calendar — OAuth callback state validation", () => {
  it("rejects a callback with no state and performs zero Google token exchange or profile write", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { code: "auth-code-only" } }), res);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.redirected).toBeNull();
  });

  it("rejects an unknown/malformed state (zero rows consumed) before any token exchange or profile write", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url, init) => {
      if (String(url).includes("/rest/v1/google_oauth_states") && init.method === "DELETE") {
        return jsonResponse([]); // nothing matched — unknown/malformed/expired/already-used all look identical
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { code: "auth-code", state: "not-a-real-state-token" } }), res);

    expect(res.statusCode).toBe(302);
    expect(res.redirected).toContain("calendar=error");
    expect(callsMatching(fetchMock, "oauth2.googleapis.com/token")).toHaveLength(0);
    expect(callsMatching(fetchMock, "/rest/v1/profiles")).toHaveLength(0);
  });

  it("rejects an expired state the same way (already excluded by the expires_at filter, so the DELETE simply returns zero rows)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { code: "auth-code", state: "an-expired-state-token" } }), res);

    expect(res.redirected).toContain("calendar=error");
    expect(callsMatching(fetchMock, "oauth2.googleapis.com/token")).toHaveLength(0);
  });

  it("accepts a valid, unexpired state: consumes it, obtains user_id only from the returned row, and completes the connection for that exact user", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url, init) => {
      if (String(url).includes("/rest/v1/google_oauth_states") && init.method === "DELETE") {
        return jsonResponse([{ user_id: VALID_UID }]);
      }
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ refresh_token: "google-refresh-token-value", access_token: "google-access-token" });
      }
      if (String(url).includes("/rest/v1/profiles") && init.method === "PATCH") {
        return jsonResponse({}, true, 204);
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { code: "real-auth-code", state: "a-valid-state-token" } }), res);

    expect(res.statusCode).toBe(302);
    expect(res.redirected).toContain("calendar=connected");

    const patchCall = callsMatching(fetchMock, "/rest/v1/profiles").find(([, init]) => init.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(patchCall[0]).toContain(`id=eq.${VALID_UID}`);
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody.google_refresh_token).toBe("google-refresh-token-value");
  });

  it("consumes state via an atomic single DELETE ... RETURNING request — single-use by construction", async () => {
    let deleteCallCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url, init) => {
      if (String(url).includes("/rest/v1/google_oauth_states") && init.method === "DELETE") {
        deleteCallCount += 1;
        // Simulate real Postgres semantics: only the first DELETE for a
        // given state_hash finds and removes the row; a second attempt
        // against the same (now-gone) row returns zero rows, exactly like
        // a genuinely concurrent second request would after losing the
        // row-lock race. This proves the *code path* only ever proceeds
        // on a returned row; true concurrent-request atomicity itself is
        // a Postgres guarantee (row-level locking on DELETE), not
        // independently re-provable inside a mocked unit test.
        return jsonResponse(deleteCallCount === 1 ? [{ user_id: VALID_UID }] : []);
      }
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ refresh_token: "rt", access_token: "at" });
      }
      if (String(url).includes("/rest/v1/profiles")) {
        return jsonResponse({}, true, 204);
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res1 = mockRes();
    await handler(mockReq({ query: { code: "code-1", state: "same-state-token" } }), res1);
    expect(res1.redirected).toContain("calendar=connected");

    const tokenCallsAfterFirst = callsMatching(fetchMock, "oauth2.googleapis.com/token").length;

    const res2 = mockRes();
    await handler(mockReq({ query: { code: "code-2", state: "same-state-token" } }), res2);

    expect(res2.redirected).toContain("calendar=error");
    // The replay must not trigger a second token exchange.
    expect(callsMatching(fetchMock, "oauth2.googleapis.com/token")).toHaveLength(tokenCallsAfterFirst);
  });

  it("never logs the raw state token, refresh token, access token, or service role key", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url, init) => {
      if (String(url).includes("/rest/v1/google_oauth_states") && init.method === "DELETE") {
        return jsonResponse([{ user_id: VALID_UID }]);
      }
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ refresh_token: "super-secret-refresh-token", access_token: "super-secret-access-token" });
      }
      if (String(url).includes("/rest/v1/profiles")) {
        return jsonResponse({}, true, 204);
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();

    await handler(mockReq({ query: { code: "real-auth-code", state: "the-raw-state-token-value" } }), res);

    for (const spy of [logSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        const joined = call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
        expect(joined).not.toContain("the-raw-state-token-value");
        expect(joined).not.toContain("super-secret-refresh-token");
        expect(joined).not.toContain("super-secret-access-token");
        expect(joined).not.toContain("service-role-key");
      }
    }
  });
});
