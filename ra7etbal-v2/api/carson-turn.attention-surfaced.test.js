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

  it.each(["list", "rank", "explain", "defer_timing"])(
    "S2-I: a %s answer never marks a capture the model put only in contrastedEvidenceIds (not rendered)",
    async (responseIntent) => {
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_ANON_KEY = "anon-key";
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
      vi.stubGlobal("fetch", fetchMock);
      const evidence = evidenceWith({ waiting: [WAITING], unresolvedCaptures: [TODO] });
      const reasonOverEvidence = vi.fn().mockResolvedValue({
        responseIntent,
        selectedEvidenceIds: ["task-w"],
        rankedEvidenceIds: null,
        contrastedEvidenceIds: ["todo-1"],
        needsClarification: null,
      });
      const { handler } = typedHandler({
        evidence,
        reasonOverEvidence,
        markPresentedAttentionCaptures: markPresentedAttentionCapturesThroughServerPath,
      });
      const response = res();
      await handler(
        req({ ...TURN, transcript: "Tell me more about those", previousCapability: "attention_summary_read", previousGroundingStatus: "grounded" }),
        response,
      );
      expect(response.payload.ownerResult).not.toContain("Buy groceries");
      expect(response.payload.surfacedEvidenceIds).not.toContain("todo-1");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("a contrast answer that renders the contrasted capture does mark it", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    const evidence = evidenceWith({ waiting: [WAITING], unresolvedCaptures: [TODO] });
    const reasonOverEvidence = vi.fn().mockResolvedValue({
      responseIntent: "contrast",
      selectedEvidenceIds: ["task-w"],
      rankedEvidenceIds: null,
      contrastedEvidenceIds: ["todo-1"],
      needsClarification: null,
    });
    const { handler } = typedHandler({
      evidence,
      reasonOverEvidence,
      markPresentedAttentionCaptures: markPresentedAttentionCapturesThroughServerPath,
    });
    const response = res();
    await handler(
      req({ ...TURN, transcript: "What can wait?", previousCapability: "attention_summary_read", previousGroundingStatus: "grounded" }),
      response,
    );
    expect(response.payload.ownerResult).toContain("Buy groceries");
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

// ── P3 Step 3 / S2 blocker corrections ────────────────────────────────────

describe("typed OpenAI-agent attention path (CARSON_OPENAI_AGENT_ATTENTION_V1) — presentation marking", () => {
  const ALSO = capture("todo-2", "todo", "Review the Rahet Bal home screen");

  function agentHandler({ evidence, finalOutput, markPresentedAttentionCaptures = markPresentedAttentionCapturesThroughServerPath }) {
    vi.stubEnv("CARSON_OPENAI_AGENT_ATTENTION_V1", "1");
    const runAgent = vi.fn(async (agent) => {
      await agent.tools[0].invoke({}, "{}");
      return { finalOutput, newItems: [{ type: "tool_call_item" }] };
    });
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
      fetchAttentionEvidence: vi.fn().mockResolvedValue({ evidence, text: "unused on the agent path" }),
      runAgent,
      buildAgent: (opts) => ({ __fakeAgent: true, ...opts }),
      markPresentedAttentionCaptures,
      dedupStore: new Map(),
    });
    return handler;
  }

  function stubSupabase() {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("S2-6: an agent answer containing a capture's exact label (any case) returns and marks that capture", async () => {
    const fetchMock = stubSupabase();
    const handler = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [TODO] }),
      finalOutput: "Needs attention now:\n- **buy groceries** — on your to-do list.",
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.groundingStatus).toBe("grounded");
    expect(response.payload.surfacedEvidenceIds).toEqual(["todo-1"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://example.supabase.co/rest/v1/carson_todos?id=in.(todo-1)"]);
  });

  it("S2-7/9: of several fetched captures, only the one whose exact label is rendered is marked (no S2b append on this turn)", async () => {
    const fetchMock = stubSupabase();
    const handler = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [NOTE, TODO, ALSO] }),
      finalOutput: "Also on your mind: Check on Nimala's wedding invitation.",
    });
    const response = res();
    // A follow-up is outside the S2b general-question scope, so the model's
    // answer is final as written.
    await handler(
      req({ ...TURN, transcript: "What else?", previousCapability: "attention_summary_read", previousGroundingStatus: "grounded" }),
      response,
    );
    expect(response.payload.ownerResult).toBe("Also on your mind: Check on Nimala's wedding invitation.");
    expect(response.payload.surfacedEvidenceIds).toEqual(["note-1"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://example.supabase.co/rest/v1/carson_notes?id=in.(note-1)"]);
  });

  it("S2-7/9 + S2b: on a general attention question the omitted captures are added to the final answer, and exactly the final answer's captures are marked", async () => {
    const fetchMock = stubSupabase();
    const handler = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [NOTE, TODO, ALSO] }),
      finalOutput: "Also on your mind: Check on Nimala's wedding invitation.",
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(
      "Also on your mind: Check on Nimala's wedding invitation.\n\nAlso on your mind: Buy groceries (on your to-do list); Review the Rahet Bal home screen (on your to-do list).",
    );
    expect(response.payload.surfacedEvidenceIds).toEqual(["note-1", "todo-1", "todo-2"]);
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
      "https://example.supabase.co/rest/v1/carson_notes?id=in.(note-1)",
      "https://example.supabase.co/rest/v1/carson_todos?id=in.(todo-1,todo-2)",
    ]);
  });

  it("S2-8: a paraphrased capture is not marked", async () => {
    const fetchMock = stubSupabase();
    const handler = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [TODO] }),
      finalOutput: "You still need to pick up some food from the shop.",
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["S2-11 clarification", "Could you tell me which list you mean?"],
    ["S2-12 nothing-new", "Nothing else needs your attention beyond what I already mentioned."],
  ])("%s answer marks nothing even though captures were fetched", async (_name, finalOutput) => {
    const fetchMock = stubSupabase();
    const handler = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NOTE, TODO] }), finalOutput });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S2-13: a capture-free agent answer marks nothing", async () => {
    const fetchMock = stubSupabase();
    const handler = agentHandler({
      evidence: evidenceWith({ waiting: [WAITING] }),
      finalOutput: "Christopher: car is still waiting.",
    });
    await handler(req(TURN), res());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S2-10: a failed or unavailable agent answer marks nothing", async () => {
    const fetchMock = stubSupabase();
    const handler = agentHandler({
      evidence: evidenceWith({ ok: false, unresolvedCaptures: [TODO] }),
      finalOutput: "Buy groceries",
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.groundingStatus).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("server presentation write order — the mark is awaited before the owner-visible response", () => {
  function recordingMark(events) {
    return vi.fn(async () => {
      events.push("mark-start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push("mark-done");
    });
  }

  it("S2-15: typed — the mark completes before the JSON answer is sent", async () => {
    const events = [];
    const { handler } = typedHandler({
      evidence: evidenceWith({ unresolvedCaptures: [TODO] }),
      markPresentedAttentionCaptures: recordingMark(events),
    });
    const response = res();
    const json = response.json.bind(response);
    response.json = (value) => {
      events.push("response-sent");
      return json(value);
    };
    await handler(req(TURN), response);
    expect(events).toEqual(["mark-start", "mark-done", "response-sent"]);
  });

  it("S2-16: voice boundary — the mark completes before the stream begins", async () => {
    process.env.CARSON_SECOND_BRAIN_SESSION_SECRET = "session-signing-secret-for-tests-32b!!";
    process.env.CARSON_SECOND_BRAIN_PROVIDER_SECRET = "provider-secret-for-tests-only-32bytes!!";
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "owner-jwt-voice" });
    const events = [];
    const handler = createCarsonTurnHandler({
      classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
      fetchAttentionEvidence: vi.fn().mockResolvedValue({
        evidence: evidenceWith({ unresolvedCaptures: [TODO] }),
        text: "Also on your mind: Buy groceries (on your to-do list).",
      }),
      markPresentedAttentionCaptures: recordingMark(events),
      dedupStore: new Map(),
    });
    const response = res();
    const setHeader = response.setHeader.bind(response);
    const write = response.write.bind(response);
    response.setHeader = (k, v) => {
      events.push("stream-begun");
      return setHeader(k, v);
    };
    response.write = (chunk) => {
      events.push("stream-write");
      return write(chunk);
    };
    await handler(
      {
        method: "POST",
        headers: { authorization: "Bearer provider-secret-for-tests-only-32bytes!!", "x-carson-second-brain-binding": token },
        body: { messages: [{ role: "user", content: "What needs my attention?" }] },
      },
      response,
    );
    expect(events.slice(0, 2)).toEqual(["mark-start", "mark-done"]);
    expect(events).toContain("stream-write");
  });

  it("S2-17: no presented captures — no write happens before or after the response", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { handler } = typedHandler({
      evidence: evidenceWith({ waiting: [WAITING] }),
      markPresentedAttentionCaptures: markPresentedAttentionCapturesThroughServerPath,
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
