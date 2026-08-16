import { afterEach, describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("./supabase", () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

import { callAnthropicProxy } from "./anthropic-client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getSessionMock.mockReset();
});

describe("callAnthropicProxy", () => {
  it("attaches the current session's access token as a Bearer header", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "the-jwt" } },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await callAnthropicProxy({ model: "claude-haiku-4-5", max_tokens: 10, messages: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/anthropic");
    expect(init.headers.Authorization).toBe("Bearer the-jwt");
  });

  it("preserves the existing request body contract", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "the-jwt" } },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const payload = { model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    await callAnthropicProxy(payload);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(payload);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("returns the raw Response so existing callers' res.ok/res.json() handling is unchanged", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "the-jwt" } },
    });
    const fakeResponse = { ok: true, json: async () => ({ content: [{ text: "hi" }] }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse));

    const res = await callAnthropicProxy({});
    expect(res).toBe(fakeResponse);
  });

  it("fails safely (throws, makes no network call) when there is no valid session", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(callAnthropicProxy({})).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never logs or exposes the access token", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "super-secret-token-value" } },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await callAnthropicProxy({});

    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(call.join(" ")).not.toContain("super-secret-token-value");
      }
    }
  });
});
