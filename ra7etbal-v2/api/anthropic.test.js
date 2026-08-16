import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./anthropic.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_ANON_KEY: "anon-key",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockReq({ method = "POST", body = {}, headers = {} } = {}) {
  return { method, body, headers };
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
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function anthropicCalls(fetchMock) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("api.anthropic.com"));
}

describe("api/anthropic — authentication boundary", () => {
  it("rejects an anonymous request (no Authorization header) with 401 before any outbound call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ headers: {} }), res);

    expect(res.statusCode).toBe(401);
    // Zero fetch calls at all -- not to Supabase auth, not to Anthropic.
    // The missing-header check short-circuits before any network call.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(anthropicCalls(fetchMock)).toHaveLength(0);
  });

  it("rejects a malformed/invalid token with 401 and never reaches Anthropic", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "invalid" }, false, 401));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ headers: { authorization: "Bearer not-a-real-token" } }), res);

    expect(res.statusCode).toBe(401);
    expect(anthropicCalls(fetchMock)).toHaveLength(0);
  });

  it("rejects an expired/rejected token the same way (Supabase auth/v1/user returns non-ok)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "expired" }, false, 401));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ headers: { authorization: "Bearer expired-jwt" } }), res);

    expect(res.statusCode).toBe(401);
    expect(anthropicCalls(fetchMock)).toHaveLength(0);
  });

  it("never performs a paid Anthropic call for any rejected request", async () => {
    const noHeaderFetch = vi.fn();
    vi.stubGlobal("fetch", noHeaderFetch);
    await handler(mockReq({ headers: {} }), mockRes());
    expect(anthropicCalls(noHeaderFetch)).toHaveLength(0);
    vi.unstubAllGlobals();

    const badTokenFetch = vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 401));
    vi.stubGlobal("fetch", badTokenFetch);
    await handler(mockReq({ headers: { authorization: "Bearer bad" } }), mockRes());
    expect(anthropicCalls(badTokenFetch)).toHaveLength(0);
  });

  it("allows a valid authenticated session through to Anthropic and preserves the existing response contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" })) // Supabase auth/v1/user
      .mockResolvedValueOnce(
        jsonResponse({ content: [{ type: "text", text: "hello" }] }),
      ); // Anthropic
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        headers: { authorization: "Bearer valid-jwt" },
        body: { model: "claude-haiku-4-5", max_tokens: 10, messages: [] },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(anthropicCalls(fetchMock)).toHaveLength(1);
    // The Anthropic call carries the server-side API key, never the caller's JWT.
    const [, anthropicInit] = anthropicCalls(fetchMock)[0];
    expect(anthropicInit.headers["x-api-key"]).toBe("sk-ant-test-key");
  });
});
