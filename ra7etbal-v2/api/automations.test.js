import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./automations.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    SUPABASE_ANON_KEY: "anon-key",
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockReq({ method = "DELETE", query = {}, body = {} } = {}) {
  return {
    method,
    query,
    body,
    headers: {
      authorization: "Bearer user-jwt",
    },
  };
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

describe("api/automations DELETE", () => {
  it("deletes an owned unsupported legacy automation and its runs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(jsonResponse([{ id: "automation-1" }]))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse(null));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { id: "automation-1" } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, deleted: true, id: "automation-1" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][0]).toContain("/rest/v1/automations");
    expect(fetchMock.mock.calls[1][0]).toContain("id=eq.automation-1");
    expect(fetchMock.mock.calls[1][0]).toContain("user_id=eq.user-1");
    expect(fetchMock.mock.calls[2][0]).toContain("/rest/v1/automation_runs");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({ Prefer: "return=minimal" }),
    });
    expect(fetchMock.mock.calls[3][0]).toContain("/rest/v1/automations");
    expect(fetchMock.mock.calls[3][1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({ Prefer: "return=minimal" }),
    });
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer service-role");
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe("Bearer service-role");
  });

  it("rejects delete without an id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ id: "user-1" })));
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({ error: "id is required." });
  });

  it("does not delete another user's automation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "user-1" }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ query: { id: "missing" } }), res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({ error: "Automation not found." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
