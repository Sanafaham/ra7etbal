/**
 * P3 Step 3 / S2 — RETRIEVED / PREFETCHED ≠ SURFACED TO OWNER, server side.
 *
 * last_surfaced_at used to be written inside fetchAttentionEvidenceForServer
 * (retrieval). It is now written only at the owner-visible presentation
 * boundary in api/carson-turn.js — the typed JSON answer and the voice
 * boundary's streamed answer — and only for the captures that answer
 * actually rendered (its surfacedEvidenceIds).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCarsonTurnHandler, markPresentedAttentionCapturesThroughServerPath } from "./carson-turn.js";
import { createSessionBinding } from "./_carson-second-brain-voice-boundary.js";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function capture(id, type, label) {
  return { id, label, type, status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "unresolvedCaptures" };
}

function evidenceWith({ ok = true, waiting = [], unresolvedCaptures = [] } = {}) {
  return {
    ok,
    code: ok ? "attention_read_succeeded" : "attention_read_failed",
    completeness: ok ? "full" : "none",
    generatedAt: new Date().toISOString(),
    needsYou: [],
    overdueReminders: [],
    upcomingReminders: [],
    waiting,
    later: [],
    unresolvedCaptures,
  };
}

const NOTE = capture("note-1", "note", "Check on Nimala's wedding invitation");
const TODO = capture("todo-1", "todo", "Buy groceries");
const WAITING = { id: "task-w", label: "Christopher: car", type: "action", status: "pending", dueAt: null, dueDescription: null, assignee: "Christopher", category: "waiting" };

function req(body, headers = { authorization: "Bearer owner-jwt" }) {
  return { method: "POST", body, headers };
}

function res() {
  return {
    statusCode: 200,
    payload: null,
    chunks: [],
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this.chunks.push(chunk); },
    end() {},
  };
}

function typedHandler({ evidence, text = "rendered", reasonOverEvidence = vi.fn(), markPresentedAttentionCaptures = vi.fn() }) {
  const fetchAttentionEvidence = vi.fn().mockResolvedValue({ evidence, text });
  const handler = createCarsonTurnHandler({
    authenticate: vi.fn().mockResolvedValue("account-a"),
    interpretIntent: vi.fn(),
    readCalendar: vi.fn(),
    fetchAttentionEvidence,
    reasonOverEvidence,
    markPresentedAttentionCaptures,
    dedupStore: new Map(),
  });
  return { handler, fetchAttentionEvidence, markPresentedAttentionCaptures };
}

const TURN = { turnId: "turn-s2", providerEventId: "evt-s2", transcript: "What needs my attention?" };

describe("typed attention answer — the presentation boundary", () => {
  it("S2-E: a grounded answer containing captures passes exactly those presented captures to the boundary write", async () => {
    const evidence = evidenceWith({ unresolvedCaptures: [NOTE, TODO] });
    const { handler, markPresentedAttentionCaptures } = typedHandler({ evidence });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.groundingStatus).toBe("grounded");
    expect(markPresentedAttentionCaptures).toHaveBeenCalledTimes(1);
    const { authorization, result } = markPresentedAttentionCaptures.mock.calls[0][0];
    expect(authorization).toBe("Bearer owner-jwt");
    expect(result).toBe(response.payload);
  });

  it("the default boundary write PATCHes exactly the presented captures with the owner's own JWT and the anon key", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    const result = {
      handled: true,
      capability: "attention_summary_read",
      groundingStatus: "grounded",
      responseIntent: "list",
      evidence: evidenceWith({ unresolvedCaptures: [NOTE, TODO] }),
      surfacedEvidenceIds: ["note-1", "todo-1"],
    };
    await markPresentedAttentionCapturesThroughServerPath({ authorization: "Bearer owner-jwt", result });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => url).sort();
    expect(urls).toEqual([
      "https://example.supabase.co/rest/v1/carson_notes?id=in.(note-1)",
      "https://example.supabase.co/rest/v1/carson_todos?id=in.(todo-1)",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe("PATCH");
      expect(init.headers.apikey).toBe("anon-key");
      expect(init.headers.Authorization).toBe("Bearer owner-jwt");
      expect(Object.keys(JSON.parse(init.body))).toEqual(["last_surfaced_at"]);
    }
  });

  it("S2-I: a filtered answer (Waiting only) presents no captures, so the fetched captures stay unsurfaced", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const evidence = evidenceWith({ waiting: [WAITING], unresolvedCaptures: [NOTE, TODO] });
    const { handler } = typedHandler({ evidence, markPresentedAttentionCaptures: markPresentedAttentionCapturesThroughServerPath });
    const response = res();
    await handler(req({ ...TURN, transcript: "What am I waiting on?" }), response);
    expect(response.payload.ownerResult).toContain("Christopher: car");
    expect(response.payload.ownerResult).not.toContain("Buy groceries");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S2-I: a reasoning answer that selects one capture marks only that one", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    const evidence = evidenceWith({ unresolvedCaptures: [NOTE, TODO] });
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "list",
      selectedEvidenceIds: ["todo-1"],
      rankedEvidenceIds: [],
      contrastedEvidenceIds: [],
      needsClarification: null,
    });
    const { handler } = typedHandler({
      evidence,
      reasonOverEvidence,
      markPresentedAttentionCaptures: markPresentedAttentionCapturesThroughServerPath,
    });
    const response = res();
    await handler(
      req({ ...TURN, transcript: "Which of those is on my to-do list?", previousCapability: "attention_summary_read", previousGroundingStatus: "grounded" }),
      response,
    );
    expect(response.payload.ownerResult).toContain("Buy groceries");
    expect(response.payload.ownerResult).not.toContain("Nimala");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://example.supabase.co/rest/v1/carson_todos?id=in.(todo-1)"]);
  });

  it("S2-G: a grounded answer without captures writes nothing", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { handler } = typedHandler({
      evidence: evidenceWith({ waiting: [WAITING] }),
      markPresentedAttentionCaptures: markPresentedAttentionCapturesThroughServerPath,
    });
    await handler(req(TURN), res());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S2-H: a failed attention read writes nothing", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { handler } = typedHandler({
      evidence: evidenceWith({ ok: false, unresolvedCaptures: [NOTE] }),
      text: "I couldn't check what needs your attention right now — the live check didn't complete.",
      markPresentedAttentionCaptures: markPresentedAttentionCapturesThroughServerPath,
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.statusCode).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S2-H: a failing boundary write never fails or changes the owner's answer", async () => {
    const evidence = evidenceWith({ unresolvedCaptures: [TODO] });
    const { handler } = typedHandler({
      evidence,
      text: "Also on your mind: Buy groceries (on your to-do list).",
      markPresentedAttentionCaptures: vi.fn().mockRejectedValue(new Error("write failed")),
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.statusCode).toBe(200);
    expect(response.payload.ownerResult).toBe("Also on your mind: Buy groceries (on your to-do list).");
  });

  it("a duplicate replay of the same provider event never writes again", async () => {
    const evidence = evidenceWith({ unresolvedCaptures: [TODO] });
    const { handler, markPresentedAttentionCaptures } = typedHandler({ evidence });
    await handler(req(TURN), res());
    const replay = res();
    await handler(req(TURN), replay);
    expect(replay.payload.duplicate).toBe(true);
    expect(markPresentedAttentionCaptures).toHaveBeenCalledTimes(1);
  });
});

describe("voice boundary answer — the presentation boundary", () => {
  const SESSION_SECRET = "session-signing-secret-for-tests-32b!!";
  const PROVIDER_SECRET = "provider-secret-for-tests-only-32bytes!!";

  it("S2-F: the streamed grounded answer marks exactly its presented captures, with the binding's owner JWT", async () => {
    process.env.CARSON_SECOND_BRAIN_SESSION_SECRET = SESSION_SECRET;
    process.env.CARSON_SECOND_BRAIN_PROVIDER_SECRET = PROVIDER_SECRET;
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "owner-jwt-voice" });
    const markPresentedAttentionCaptures = vi.fn();
    const handler = createCarsonTurnHandler({
      classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
      fetchAttentionEvidence: vi.fn().mockResolvedValue({
        evidence: evidenceWith({ unresolvedCaptures: [TODO] }),
        text: "Also on your mind: Buy groceries (on your to-do list).",
      }),
      markPresentedAttentionCaptures,
      dedupStore: new Map(),
    });
    const response = res();
    await handler(
      {
        method: "POST",
        headers: { authorization: `Bearer ${PROVIDER_SECRET}`, "x-carson-second-brain-binding": token },
        body: { messages: [{ role: "user", content: "What needs my attention?" }] },
      },
      response,
    );
    expect(response.chunks.join("")).toContain("Buy groceries");
    expect(markPresentedAttentionCaptures).toHaveBeenCalledTimes(1);
    const { authorization, result } = markPresentedAttentionCaptures.mock.calls[0][0];
    expect(authorization).toBe("Bearer owner-jwt-voice");
    expect(result.surfacedEvidenceIds).toContain("todo-1");
  });
});
