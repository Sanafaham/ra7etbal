import { describe, expect, it, vi } from "vitest";

// See ConfirmRouter.test.tsx for why this stub is needed on import.
vi.mock("./supabase", () => ({ supabase: {} }));

const { issueSecondBrainVoiceBinding } = await import("./carson-second-brain-voice-binding");

const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.super-secret-owner-jwt-payload.signature";

describe("issueSecondBrainVoiceBinding — authenticated session required", () => {
  it("requests a binding when an access token is available", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ binding: "binding-token", sessionId: "sid-1", expiresAt: 1234567890 }),
    });
    const result = await issueSecondBrainVoiceBinding({
      getAccessToken: async () => FAKE_JWT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "ready", binding: "binding-token", sessionId: "sid-1", expiresAt: 1234567890 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/carson-turn");
    expect(url).not.toContain(FAKE_JWT);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_JWT}`);
    expect(init.body).not.toContain(FAKE_JWT);
    expect(JSON.parse(init.body)).toEqual({ action: "issue_second_brain_voice_binding" });
  });

  it("fails safe without ever calling the endpoint when no session exists", async () => {
    const fetchImpl = vi.fn();
    const result = await issueSecondBrainVoiceBinding({
      getAccessToken: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a safe error message when the backend rejects the request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized" }),
    });
    const result = await issueSecondBrainVoiceBinding({
      getAccessToken: async () => FAKE_JWT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "error", message: "Unauthorized" });
  });

  it("never logs the access token, on success or failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await issueSecondBrainVoiceBinding({
        getAccessToken: async () => FAKE_JWT,
        fetchImpl: vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch,
      });
      for (const spy of [logSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          expect(call.join(" ")).not.toContain(FAKE_JWT);
        }
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
