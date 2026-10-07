import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAttentionEvidenceForServer,
  fetchAttentionSummaryForServer,
  presentedAttentionCaptureIds,
} from "./_carson-attention-evidence.js";

const CTX = {
  supabaseUrl: "https://example.supabase.co",
  anonKey: "anon-key-123",
  authorization: "Bearer user-jwt-abc",
};

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function tableFromUrl(url) {
  return new URL(url).pathname.split("/").pop();
}

describe("fetchAttentionEvidenceForServer — security boundary", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses only the anon key and the caller's own JWT for every request — never a service-role key, never a different/derived token", async () => {
    fetchMock.mockImplementation(async () => jsonResponse([]));

    await fetchAttentionEvidenceForServer(CTX);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.apikey).toBe(CTX.anonKey);
      expect(init.headers.Authorization).toBe(CTX.authorization);
    }
  });

  it("never includes a caller-supplied account/user id as a query filter — RLS is the only scoping mechanism", async () => {
    fetchMock.mockImplementation(async () => jsonResponse([]));

    await fetchAttentionEvidenceForServer(CTX);

    for (const [url] of fetchMock.mock.calls) {
      expect(url).not.toMatch(/user_id=eq\./);
      expect(url).not.toMatch(/account_id=eq\./);
    }
  });

  it("produces a grounded, ok:true evidence object when all sources succeed with real data", async () => {
    const now = new Date();
    fetchMock.mockImplementation(async (url) => {
      const table = tableFromUrl(url);
      if (table === "tasks") {
        return jsonResponse([
          {
            id: "t1",
            description: "Call the dentist",
            type: "reminder",
            status: "pending",
            assigned_to: null,
            due_at: new Date(now.getTime() - 3_600_000).toISOString(),
            created_at: new Date(now.getTime() - 7_200_000).toISOString(),
            archived_at: null,
            needs_follow_up: false,
            escalated_at: null,
            confirmed_at: null,
          },
        ]);
      }
      if (table === "staff_messages") return jsonResponse([]);
      if (table === "carson_notes") return jsonResponse([]);
      if (table === "carson_todos") return jsonResponse([]);
      if (table === "automation_runs") return jsonResponse([]);
      return jsonResponse([]);
    });

    const evidence = await fetchAttentionEvidenceForServer(CTX);

    expect(evidence.ok).toBe(true);
    expect(evidence.completeness).toBe("full");
    expect(evidence.overdueReminders.length).toBe(1);
    expect(evidence.overdueReminders[0].category).toBe("overdueReminders");
  });

  it("degrades to a partial, honest result when one source fails — never silently drops to empty/all-clear", async () => {
    fetchMock.mockImplementation(async (url) => {
      const table = tableFromUrl(url);
      if (table === "tasks") return jsonResponse(null, false);
      return jsonResponse([]);
    });

    const evidence = await fetchAttentionEvidenceForServer(CTX);

    expect(evidence.ok).toBe(true);
    expect(evidence.completeness).toBe("partial");
  });

  it("returns attention_read_failed, never a fabricated answer, when every source fails", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(null, false));

    const evidence = await fetchAttentionEvidenceForServer(CTX);

    expect(evidence.ok).toBe(false);
    expect(evidence.code).toBe("attention_read_failed");
    expect(evidence.needsYou).toEqual([]);
    expect(evidence.waiting).toEqual([]);
  });

  it("fetchAttentionSummaryForServer never throws and always returns text derived from the evidence, even on a hard exception", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("network exploded");
    });

    const { evidence, text } = await fetchAttentionSummaryForServer(CTX);

    expect(evidence.ok).toBe(false);
    expect(text).toBe("I couldn't check what needs your attention right now — the live check didn't complete.");
  });
});

// P3 Step 3 / S2 — retrieval never writes last_surfaced_at.
describe("fetchAttentionEvidenceForServer — S2: retrieval is read-only", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("S2-A: retrieving selected captures issues no PATCH and leaves them eligible on the next read", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const fetchMock = vi.fn(async (url) => {
      const table = tableFromUrl(url);
      if (table === "carson_notes") {
        return jsonResponse([{ id: "n1", note: "Check on Nimala's wedding invitation", created_at: old, updated_at: old, dismissed_at: null, last_surfaced_at: null }]);
      }
      if (table === "carson_todos") {
        return jsonResponse([{ id: "t1", title: "Buy groceries", status: "active", created_at: old, updated_at: old, last_surfaced_at: null }]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchAttentionEvidenceForServer(CTX);
    const second = await fetchAttentionSummaryForServer(CTX);

    expect(first.unresolvedCaptures.map((c) => c.id).sort()).toEqual(["n1", "t1"]);
    expect(second.evidence.unresolvedCaptures.map((c) => c.id).sort()).toEqual(["n1", "t1"]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method ?? "GET").toBe("GET");
    }
  });
});

describe("presentedAttentionCaptureIds — S2: only what the answer actually rendered", () => {
  const capture = (id, type) => ({ id, type, label: id, category: "unresolvedCaptures" });
  const grounded = (overrides = {}) => ({
    handled: true,
    capability: "attention_summary_read",
    groundingStatus: "grounded",
    responseIntent: "list",
    evidence: { ok: true, unresolvedCaptures: [capture("n1", "note"), capture("t1", "todo")] },
    surfacedEvidenceIds: ["n1", "t1"],
    ...overrides,
  });

  it("returns the presented captures with their table kind", () => {
    expect(presentedAttentionCaptureIds(grounded())).toEqual([
      { id: "n1", kind: "note" },
      { id: "t1", kind: "todo" },
    ]);
  });

  it("S2-I: excludes captures that were fetched but not rendered", () => {
    expect(presentedAttentionCaptureIds(grounded({ surfacedEvidenceIds: ["t1", "task-x"] }))).toEqual([{ id: "t1", kind: "todo" }]);
  });

  it("S2-G/H: presents nothing for failed, unhandled, non-attention, nothing_new or clarify answers", () => {
    expect(presentedAttentionCaptureIds(null)).toEqual([]);
    expect(presentedAttentionCaptureIds(grounded({ groundingStatus: "failed" }))).toEqual([]);
    expect(presentedAttentionCaptureIds(grounded({ handled: false }))).toEqual([]);
    expect(presentedAttentionCaptureIds(grounded({ capability: "calendar_read" }))).toEqual([]);
    expect(presentedAttentionCaptureIds(grounded({ responseIntent: "nothing_new" }))).toEqual([]);
    expect(presentedAttentionCaptureIds(grounded({ responseIntent: "clarify" }))).toEqual([]);
    expect(presentedAttentionCaptureIds(grounded({ evidence: { ok: false, unresolvedCaptures: [capture("n1", "note")] } }))).toEqual([]);
    expect(presentedAttentionCaptureIds(grounded({ surfacedEvidenceIds: undefined }))).toEqual([]);
  });

  it("an agent-coordinator answer (free text, no surfacedEvidenceIds or evidence) presents nothing verifiable", () => {
    expect(
      presentedAttentionCaptureIds({ handled: true, capability: "attention_summary_read", groundingStatus: "grounded", ownerResult: "text" }),
    ).toEqual([]);
  });
});
