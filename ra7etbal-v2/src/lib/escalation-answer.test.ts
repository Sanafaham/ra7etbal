import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "token-abc" } },
        error: null,
      })),
    },
  },
}));

import { submitEscalationDecision } from "./escalation-answer";
import { supabase } from "./supabase";

function jsonResponse(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("submitEscalationDecision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requires a signed-in session before attempting any network call", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitEscalationDecision({ deepLinkToken: "tok-1", decision: "approved" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/signed in/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCHes /api/task-confirm with deepLinkToken and decision, using the session's access token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, status: "delivered" }));
    vi.stubGlobal("fetch", fetchMock);

    await submitEscalationDecision({ deepLinkToken: "tok-1", decision: "approved" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/task-confirm",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ Authorization: "Bearer token-abc" }),
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ deepLinkToken: "tok-1", decision: "approved" });
  });

  it("includes instructionText only when provided (custom instruction)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, status: "delivered" }));
    vi.stubGlobal("fetch", fetchMock);

    await submitEscalationDecision({
      deepLinkToken: "tok-1",
      decision: "custom_instruction",
      instructionText: "Please wait until Friday.",
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      deepLinkToken: "tok-1",
      decision: "custom_instruction",
      instructionText: "Please wait until Friday.",
    });
  });

  it("omits decision entirely for a retry-only call (no new decision to submit)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, status: "delivered" }));
    vi.stubGlobal("fetch", fetchMock);

    await submitEscalationDecision({ deepLinkToken: "tok-1" });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ deepLinkToken: "tok-1" });
  });

  it("returns success with status/ownerReplyText on a 200 response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { success: true, status: "delivered", ownerReplyText: "Yes, buy the red wine vinegar instead." }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitEscalationDecision({ deepLinkToken: "tok-1", decision: "approved" });
    expect(result).toEqual({ success: true, status: "delivered", ownerReplyText: "Yes, buy the red wine vinegar instead." });
  });

  it("returns a truthful failure when the server responds with a non-ok status and an error body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(502, { error: "Could not send the message. Please retry." }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitEscalationDecision({ deepLinkToken: "tok-1", decision: "approved" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Could not send the message. Please retry.");
  });

  it("returns a truthful failure on a network error, never throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitEscalationDecision({ deepLinkToken: "tok-1", decision: "approved" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/network/i);
  });
});
