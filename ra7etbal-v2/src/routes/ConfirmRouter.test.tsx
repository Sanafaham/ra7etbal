/**
 * Tests resolveConfirmLinkKind() — the pure discriminator function — in
 * isolation, with a mocked fetchImpl. Never renders ConfirmRouter itself:
 * that would also render the real Confirm.tsx (heavy, separately tested)
 * or OwnerEscalationDecision.tsx, and this codebase deliberately avoids a
 * DOM/testing-library dependency (see StaffUpdates.test.tsx).
 */
import { describe, expect, it, vi } from "vitest";

// This test only exercises the pure resolveConfirmLinkKind export below,
// but importing the module also statically imports Confirm.tsx and
// OwnerEscalationDecision.tsx, which chain into ../lib/supabase — a module
// that throws at import time outside a real browser env (missing
// VITE_SUPABASE_* vars). Stubbed out here so import doesn't throw; never
// called by anything this file actually exercises. Same convention as
// StaffUpdates.test.tsx.
vi.mock("../lib/supabase", () => ({ supabase: {} }));

const { resolveConfirmLinkKind } = await import("./ConfirmRouter");

function jsonResponse(status: number, body: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

describe("resolveConfirmLinkKind", () => {
  it("10. a real task id (existing worker confirmation link) resolves to 'task'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "task-1", description: "Buy milk" }));
    const kind = await resolveConfirmLinkKind("real-task-id", fetchMock);
    expect(kind).toBe("task");
    expect(fetchMock).toHaveBeenCalledWith("/api/task-confirm?taskId=real-task-id");
  });

  it("a genuine 404 (not a real task id) resolves to 'owner_escalation'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, { error: "This confirmation link is invalid or expired." }));
    const kind = await resolveConfirmLinkKind("162865ee-4ad6-4b73-b6c4-ae4945a2f545", fetchMock);
    expect(kind).toBe("owner_escalation");
  });

  it("URL-encodes the token in the probe request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404));
    await resolveConfirmLinkKind("a token/with special?chars", fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/task-confirm?taskId=${encodeURIComponent("a token/with special?chars")}`,
    );
  });

  it("a non-404 server error still resolves to 'task' — Confirm.tsx's own error state handles it truthfully, never silently misrouted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { error: "Server configuration error" }));
    expect(await resolveConfirmLinkKind("x", fetchMock)).toBe("task");
  });

  it("a network failure on the probe falls through to 'task' rather than the owner-escalation branch", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await resolveConfirmLinkKind("x", fetchMock)).toBe("task");
  });
});
