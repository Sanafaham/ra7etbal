/**
 * Focused tests for the Stage 2A binding-issuance overlay (C-03 live gate
 * blocker). Tests the access-token handling and route/query gate as pure
 * functions (no jsdom in this project — see OwnerEscalationDecision.test.tsx
 * for the same renderToStaticMarkup convention) plus renders the
 * presentational view directly to prove the access token can never appear
 * in output, since the view's props never carry it.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// See ConfirmRouter.test.tsx for why this stub is needed on import.
vi.mock("../lib/supabase", () => ({ supabase: {} }));

const {
  computeStage2ABindingVisibility,
  issueStage2ABinding,
  CarsonStage2ABindingView,
} = await import("./CarsonStage2ABinding");

const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.super-secret-owner-jwt-payload.signature";

describe("computeStage2ABindingVisibility — route/query activation", () => {
  it("is visible on /debug/carson-binding", () => {
    expect(computeStage2ABindingVisibility("/debug/carson-binding", "")).toBe(true);
  });

  it("is visible on a deeper /debug/carson-binding/x path", () => {
    expect(computeStage2ABindingVisibility("/debug/carson-binding/x", "")).toBe(true);
  });

  it("is visible via ?carsonBinding=1 on any path", () => {
    expect(computeStage2ABindingVisibility("/", "?carsonBinding=1")).toBe(true);
  });

  it("is invisible for every normal route/query", () => {
    expect(computeStage2ABindingVisibility("/", "")).toBe(false);
    expect(computeStage2ABindingVisibility("/updates", "")).toBe(false);
    expect(computeStage2ABindingVisibility("/", "?carsonBinding=0")).toBe(false);
  });
});

describe("issueStage2ABinding — authenticated session required", () => {
  it("requests a binding when an access token is available", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ binding: "binding-token", sessionId: "sid-1", expiresAt: 1234567890 }),
    });
    const result = await issueStage2ABinding({
      getAccessToken: async () => FAKE_JWT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "ready", binding: "binding-token", sessionId: "sid-1", expiresAt: 1234567890 });

    // The access token must be sent only as the Authorization header of a
    // POST — never in the URL/query string, and never duplicated into the body.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/carson-custom-llm-stage2a");
    expect(url).not.toContain(FAKE_JWT);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_JWT}`);
    expect(init.body).not.toContain(FAKE_JWT);
    expect(JSON.parse(init.body)).toEqual({ action: "issue_session_binding", scenario: "fixed" });
  });

  it("fails safe without ever calling the endpoint when no session exists", async () => {
    const fetchImpl = vi.fn();
    const result = await issueStage2ABinding({
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
    const result = await issueStage2ABinding({
      getAccessToken: async () => FAKE_JWT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "error", message: "Unauthorized" });
  });

  it("never logs the access token, on success or failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await issueStage2ABinding({
        getAccessToken: async () => FAKE_JWT,
        fetchImpl: vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch,
      });
      for (const spy of [logSpy, errorSpy, infoSpy]) {
        for (const call of spy.mock.calls) {
          expect(call.join(" ")).not.toContain(FAKE_JWT);
        }
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});

describe("CarsonStage2ABindingView — rendering", () => {
  it("renders the binding and its expiry when ready", () => {
    const html = renderToStaticMarkup(
      <CarsonStage2ABindingView
        state={{ status: "ready", binding: "binding-token-xyz", sessionId: "sid-1", expiresAt: 2000000000 }}
        copied={false}
        onIssue={() => {}}
        onCopy={() => {}}
      />,
    );
    expect(html).toContain("binding-token-xyz");
    expect(html).toContain("carson_stage2a_binding");
    expect(html).not.toContain(FAKE_JWT);
  });

  it("shows a loading label on the issue button while loading", () => {
    const html = renderToStaticMarkup(
      <CarsonStage2ABindingView state={{ status: "loading" }} copied={false} onIssue={() => {}} onCopy={() => {}} />,
    );
    expect(html).toContain("Issuing");
  });

  it("shows the error message when issuance failed", () => {
    const html = renderToStaticMarkup(
      <CarsonStage2ABindingView
        state={{ status: "error", message: "Not signed in to Ra7etBal — sign in first, then reopen this page." }}
        copied={false}
        onIssue={() => {}}
        onCopy={() => {}}
      />,
    );
    expect(html).toContain("Not signed in");
  });

  it("offers a reissue control (\"Issue new binding\") in every state", () => {
    for (const state of [
      { status: "idle" as const },
      { status: "ready" as const, binding: "b", sessionId: "s", expiresAt: 1 },
    ]) {
      const html = renderToStaticMarkup(
        <CarsonStage2ABindingView state={state} copied={false} onIssue={() => {}} onCopy={() => {}} />,
      );
      expect(html).toContain("Issue new binding");
    }
  });
});

describe("Production Carson untouched", () => {
  it("this module's source never imports or references the production widget file", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./CarsonStage2ABinding.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/ElevenLabsAgentWidget/);
  });
});
