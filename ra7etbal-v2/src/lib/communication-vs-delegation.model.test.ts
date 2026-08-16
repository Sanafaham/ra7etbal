import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests classifyStaffInstructionViaModel's own plumbing — prompt
 * construction, response parsing, and the fail-safe default — against a
 * mocked Anthropic proxy response. This does NOT re-test every protected
 * phrase's semantic answer (that's carson-protected-behaviors.test.ts,
 * which uses an injected deterministic classifier and never reaches this
 * module's real implementation). This file proves the wiring around the
 * real model call is correct; it does not and cannot prove the real
 * model's judgment is correct for any given phrase — that is validated in
 * production, not by a mocked unit test.
 */

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("./supabase", () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

import { classifyStaffInstructionViaModel } from "./communication-vs-delegation";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body, text: async () => JSON.stringify(body) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getSessionMock.mockReset();
});

describe("classifyStaffInstructionViaModel", () => {
  it("sends the task text to the Anthropic proxy and parses a COMMUNICATION response", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "COMMUNICATION" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyStaffInstructionViaModel("come to the kitchen now.");

    expect(result).toBe("communication");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/anthropic");
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toContain("come to the kitchen now.");
  });

  it("parses a DELEGATION response", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "DELEGATION" }] })),
    );

    expect(await classifyStaffInstructionViaModel("clean the kitchen.")).toBe("delegation");
  });

  it("is tolerant of surrounding whitespace/casing in the model's answer", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "  communication\n" }] })),
    );

    expect(await classifyStaffInstructionViaModel("wait downstairs.")).toBe("communication");
  });

  it("fails safe to delegation on a non-OK proxy response", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false)));

    expect(await classifyStaffInstructionViaModel("anything")).toBe("delegation");
  });

  it("fails safe to delegation on a proxy error body", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "rate_limited" })));

    expect(await classifyStaffInstructionViaModel("anything")).toBe("delegation");
  });

  it("fails safe to delegation on an unparseable/ambiguous model answer", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "I'm not sure" }] })),
    );

    expect(await classifyStaffInstructionViaModel("anything")).toBe("delegation");
  });

  it("fails safe to delegation on a network error (never throws)", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(classifyStaffInstructionViaModel("anything")).resolves.toBe("delegation");
  });

  it("fails safe to delegation when there is no valid session (callAnthropicProxy throws)", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(classifyStaffInstructionViaModel("anything")).resolves.toBe("delegation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns delegation for empty/whitespace-only text without calling the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await classifyStaffInstructionViaModel("   ")).toBe("delegation");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
