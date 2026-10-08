/**
 * P3 Step 3 / S2b — owner-visible recovery of eligible captures on the typed
 * OpenAI-agent attention path (CARSON_OPENAI_AGENT_ATTENTION_V1).
 *
 * Production failure (2026-10-08 10:42 UTC, conv_9001m4dhp0yjfttt9xz070j9pqfp):
 * the owner asked "What needs my attention?", capture retrieval succeeded
 * (Supabase edge logs: carson_notes 3 rows / carson_todos 5 rows, 200, <1s),
 * three captures were eligible, and the agent's free-text answer named none
 * of them — so they were neither shown nor (correctly) marked surfaced.
 *
 * Contract under test: on a completed, grounded answer to a general
 * attention question, eligible captures the model omitted are appended in
 * the established "Also on your mind: …" wording, and surfacedEvidenceIds
 * (the only input to the awaited presentation-boundary mark) is exactly the
 * set of captures the FINAL answer presents. S2 is unchanged: nothing is
 * marked unless it is in the answer the owner receives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCarsonTurnHandler, markPresentedAttentionCapturesThroughServerPath } from "./carson-turn.js";
import { createSessionBinding } from "./_carson-second-brain-voice-boundary.js";
import { presentOmittedAttentionCaptures } from "./_carson-attention-agent.js";
import { renderAlsoOnYourMindLine } from "../shared/carson-attention-summary.js";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function item(id, type, label, category, extra = {}) {
  return { id, label, type, status: "pending", dueAt: null, dueDescription: null, assignee: null, category, ...extra };
}

// The three captures restored by S2b, in the classifier's oldest-first order.
const NIMALA = item("ec7457e7", "note", "Check on Nimala’s wedding invitation", "unresolvedCaptures");
const IMPROVE = item("3ae6ac9a", "todo", "Improve the UI of Rahet Bal", "unresolvedCaptures");
const REVIEW = item("7c7816de", "todo", "Review the Rahet Bal home screen", "unresolvedCaptures");

const OVERDUE = [
  item("r1", "reminder", "charge your phone", "overdueReminders", { dueDescription: "Overdue by 12 hours" }),
  item("r2", "reminder", "call the doctor", "overdueReminders", { dueDescription: "Overdue by 40 days" }),
];
const WAITING = [item("d1", "delegation", "Christopher: call me now", "waiting", { assignee: "Christopher" })];

function evidenceWith({ ok = true, completeness = "full", overdueReminders = OVERDUE, waiting = WAITING, unresolvedCaptures = [] } = {}) {
  return {
    ok,
    code: ok ? "attention_read_succeeded" : "attention_read_failed",
    completeness: ok ? completeness : "none",
    generatedAt: "2026-10-08T10:42:12.000Z",
    needsYou: [],
    overdueReminders,
    upcomingReminders: [],
    waiting,
    later: [],
    unresolvedCaptures,
  };
}

// The model's 10:42 answer shape: overdue reminders + Christopher delegations,
// no captures.
const MODEL_ANSWER_WITHOUT_CAPTURES =
  "As of now, these are overdue:\n\n- **charge your phone** — 12 hours\n- **call the doctor** — 40 days\n\nYou’re also waiting on Christopher for **call me now**.";

const ALSO_LINE_ALL_THREE =
  "Also on your mind: Check on Nimala’s wedding invitation (a note you made); Improve the UI of Rahet Bal (on your to-do list); Review the Rahet Bal home screen (on your to-do list).";

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

const TURN = { turnId: "turn-s2b", providerEventId: "evt-s2b", transcript: "What needs my attention?" };

function stubSupabase() {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function agentHandler({
  evidence,
  fetchAttentionEvidence = vi.fn().mockResolvedValue({ evidence, text: "unused on the agent path" }),
  finalOutput,
  callTool = true,
  runThrows = false,
  markPresentedAttentionCaptures = markPresentedAttentionCapturesThroughServerPath,
  dedupStore = new Map(),
}) {
  vi.stubEnv("CARSON_OPENAI_AGENT_ATTENTION_V1", "1");
  const runAgent = vi.fn(async (agent) => {
    if (runThrows) throw new Error("model unavailable");
    if (callTool) await agent.tools[0].invoke({}, "{}");
    return { finalOutput, newItems: callTool ? [{ type: "tool_call_item" }] : [] };
  });
  const handler = createCarsonTurnHandler({
    authenticate: vi.fn().mockResolvedValue("account-a"),
    classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
    interpretIntent: vi.fn().mockResolvedValue({ capability: "unsupported" }),
    readCalendar: vi.fn(),
    fetchAttentionEvidence,
    runAgent,
    buildAgent: (opts) => ({ __fakeAgent: true, ...opts }),
    markPresentedAttentionCaptures,
    dedupStore,
  });
  return { handler, runAgent, fetchAttentionEvidence };
}

function patchedUrls(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => url).sort();
}

describe("S2b — typed agent answer presents eligible captures the model omitted", () => {
  it("RED (10:42 reproduction): the final owner-visible answer includes all three eligible captures and marks exactly them", async () => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE, REVIEW] }),
      finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES,
    });
    const response = res();
    await handler(req(TURN), response);

    expect(response.statusCode).toBe(200);
    expect(response.payload.groundingStatus).toBe("grounded");
    // Existing authoritative content is preserved verbatim, then the line.
    expect(response.payload.ownerResult).toBe(`${MODEL_ANSWER_WITHOUT_CAPTURES}\n\n${ALSO_LINE_ALL_THREE}`);
    expect(response.payload.surfacedEvidenceIds).toEqual(["ec7457e7", "3ae6ac9a", "7c7816de"]);
    expect(patchedUrls(fetchMock)).toEqual([
      "https://example.supabase.co/rest/v1/carson_notes?id=in.(ec7457e7)",
      "https://example.supabase.co/rest/v1/carson_todos?id=in.(3ae6ac9a,7c7816de)",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe("PATCH");
      expect(init.headers.Authorization).toBe("Bearer owner-jwt");
      expect(Object.keys(JSON.parse(init.body))).toEqual(["last_surfaced_at"]);
    }
  });

  it.each([
    [1, [NIMALA], "Also on your mind: Check on Nimala’s wedding invitation (a note you made)."],
    [2, [NIMALA, IMPROVE], "Also on your mind: Check on Nimala’s wedding invitation (a note you made); Improve the UI of Rahet Bal (on your to-do list)."],
    [3, [NIMALA, IMPROVE, REVIEW], ALSO_LINE_ALL_THREE],
  ])("%i eligible capture(s): all appended in evidence order and marked", async (_n, captures, line) => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: captures }), finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(`${MODEL_ANSWER_WITHOUT_CAPTURES}\n\n${line}`);
    expect(response.payload.surfacedEvidenceIds).toEqual(captures.map((c) => c.id));
    expect(fetchMock).toHaveBeenCalled();
  });

  it("never duplicates a capture the model already presented — appends only the omitted ones, each id marked once", async () => {
    const fetchMock = stubSupabase();
    const finalOutput = `${MODEL_ANSWER_WITHOUT_CAPTURES}\n\nAlso: **Improve the UI of Rahet Bal** is still on your list.`;
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE, REVIEW] }), finalOutput });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(
      `${finalOutput}\n\nAlso on your mind: Check on Nimala’s wedding invitation (a note you made); Review the Rahet Bal home screen (on your to-do list).`,
    );
    expect(response.payload.ownerResult.match(/Improve the UI of Rahet Bal/g)).toHaveLength(1);
    expect([...response.payload.surfacedEvidenceIds].sort()).toEqual(["3ae6ac9a", "7c7816de", "ec7457e7"]);
    expect(new Set(response.payload.surfacedEvidenceIds).size).toBe(3);
    expect(patchedUrls(fetchMock)).toEqual([
      "https://example.supabase.co/rest/v1/carson_notes?id=in.(ec7457e7)",
      "https://example.supabase.co/rest/v1/carson_todos?id=in.(3ae6ac9a,7c7816de)",
    ]);
  });

  it("an answer that already presents every capture is returned unchanged", async () => {
    stubSupabase();
    const finalOutput = `${MODEL_ANSWER_WITHOUT_CAPTURES}\n\nOn your mind: Check on Nimala’s wedding invitation, Improve the UI of Rahet Bal, and Review the Rahet Bal home screen.`;
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE, REVIEW] }), finalOutput });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(finalOutput);
    expect(response.payload.surfacedEvidenceIds).toEqual(["ec7457e7", "3ae6ac9a", "7c7816de"]);
  });

  it("no eligible captures: answer unchanged, nothing marked", async () => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [] }), finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(MODEL_ANSWER_WITHOUT_CAPTURES);
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the mark is awaited after the final answer is assembled and before the response is sent — no mark before presentation", async () => {
    const events = [];
    const markPresentedAttentionCaptures = vi.fn(async ({ result }) => {
      events.push(["mark", result.ownerResult.includes(ALSO_LINE_ALL_THREE), [...result.surfacedEvidenceIds]]);
    });
    const fetchAttentionEvidence = vi.fn(async () => {
      events.push(["retrieve"]);
      return { evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE, REVIEW] }), text: "unused" };
    });
    const { handler } = agentHandler({ fetchAttentionEvidence, finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES, markPresentedAttentionCaptures });
    const response = res();
    const json = response.json.bind(response);
    response.json = (value) => {
      events.push(["response"]);
      return json(value);
    };
    await handler(req(TURN), response);
    expect(events).toEqual([
      ["retrieve"],
      ["mark", true, ["ec7457e7", "3ae6ac9a", "7c7816de"]],
      ["response"],
    ]);
    // The exact object marked is the exact object the owner receives.
    expect(markPresentedAttentionCaptures.mock.calls[0][0].result).toBe(response.payload);
  });

  it("a duplicate replay returns the same final answer and never marks again", async () => {
    const markPresentedAttentionCaptures = vi.fn();
    const { handler } = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }),
      finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES,
      markPresentedAttentionCaptures,
    });
    const first = res();
    await handler(req(TURN), first);
    const replay = res();
    await handler(req(TURN), replay);
    expect(replay.payload.duplicate).toBe(true);
    expect(replay.payload.ownerResult).toBe(first.payload.ownerResult);
    expect(markPresentedAttentionCaptures).toHaveBeenCalledTimes(1);
  });

  it("partial evidence that still carries eligible captures presents them truthfully", async () => {
    stubSupabase();
    const { handler } = agentHandler({
      evidence: evidenceWith({ completeness: "partial", unresolvedCaptures: [NIMALA] }),
      finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES,
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toContain("Also on your mind: Check on Nimala’s wedding invitation (a note you made).");
    expect(response.payload.surfacedEvidenceIds).toEqual(["ec7457e7"]);
  });
});

describe("S2b — states that must never gain a capture line or a mark", () => {
  it.each([
    ["failed evidence", { evidence: evidenceWith({ ok: false, unresolvedCaptures: [NIMALA] }), finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES }],
    ["evidence fetch threw / timed out", {
      fetchAttentionEvidence: vi.fn().mockRejectedValue(new Error("attention evidence source timed out")),
      finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES,
    }],
    ["model answered without calling the tool", {
      evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }),
      finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES,
      callTool: false,
    }],
    ["agent run threw", { evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }), finalOutput: "", runThrows: true }],
    ["no final output", { evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }), finalOutput: "" }],
  ])("%s: honest failure answer unchanged, nothing marked", async (_name, options) => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler(options);
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.groundingStatus).toBe("failed");
    expect(response.payload.ownerResult).toBe("I couldn't check your live Ra7etBal state right now — please try again in a moment.");
    expect(response.payload.ownerResult).not.toContain("Also on your mind");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["clarification", "Could you tell me which list you mean?"],
    ["nothing new", "Nothing else needs your attention beyond what I already mentioned."],
  ])("a %s answer (names no evidence item) is unchanged and marks nothing", async (_name, finalOutput) => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE] }), finalOutput });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(finalOutput);
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a waiting-only question", "What am I waiting on?"],
    ["a follow-up in an active attention exchange", "What else?"],
    ["a Stage-1-admitted novel question", "Anything overdue?"],
  ])("%s keeps the model's answer unchanged (only named captures marked)", async (_name, transcript) => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE] }), finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES });
    const response = res();
    await handler(
      req({ ...TURN, transcript, previousCapability: "attention_summary_read", previousGroundingStatus: "grounded" }),
      response,
    );
    expect(response.payload.ownerResult).toBe(MODEL_ANSWER_WITHOUT_CAPTURES);
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a non-attention turn is untouched (no agent run, no capture line, no mark)", async () => {
    const fetchMock = stubSupabase();
    const markPresentedAttentionCaptures = vi.fn();
    const { handler, runAgent } = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }),
      finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES,
      markPresentedAttentionCaptures,
    });
    // Not attention-class: the fast path does not match and Stage 1 says no.
    const handlerNotOperational = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
      interpretIntent: vi.fn().mockResolvedValue({ capability: "unsupported" }),
      readCalendar: vi.fn(),
      fetchAttentionEvidence: vi.fn(),
      runAgent,
      buildAgent: (opts) => ({ __fakeAgent: true, ...opts }),
      markPresentedAttentionCaptures,
      dedupStore: new Map(),
    });
    void handler;
    const response = res();
    await handlerNotOperational(req({ ...TURN, transcript: "Hello" }), response);
    expect(runAgent).not.toHaveBeenCalled();
    expect(JSON.stringify(response.payload ?? {})).not.toContain("Also on your mind");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a calendar turn is untouched", async () => {
    const fetchMock = stubSupabase();
    vi.stubEnv("CARSON_OPENAI_AGENT_ATTENTION_V1", "1");
    const markPresentedAttentionCaptures = vi.fn();
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
      interpretIntent: vi.fn().mockResolvedValue({ capability: "calendar_read", range: "today" }),
      readCalendar: vi.fn().mockResolvedValue({ events: [] }),
      fetchAttentionEvidence: vi.fn(),
      runAgent: vi.fn(),
      buildAgent: (opts) => ({ __fakeAgent: true, ...opts }),
      markPresentedAttentionCaptures,
      dedupStore: new Map(),
    });
    const response = res();
    await handler(req({ ...TURN, transcript: "What's on my calendar today?" }), response);
    expect(JSON.stringify(response.payload ?? {})).not.toContain("Also on your mind");
    expect(response.payload?.surfacedEvidenceIds).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the flag-off typed read path (Stage 1/2 reasoning coordinator) is unchanged", async () => {
    const fetchMock = stubSupabase();
    const evidence = evidenceWith({ unresolvedCaptures: [NIMALA] });
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      interpretIntent: vi.fn(),
      readCalendar: vi.fn(),
      fetchAttentionEvidence: vi.fn().mockResolvedValue({ evidence, text: "Deterministic summary without the line." }),
      reasonOverEvidence: vi.fn(),
      markPresentedAttentionCaptures: markPresentedAttentionCapturesThroughServerPath,
      dedupStore: new Map(),
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.code).not.toBe("attention_agent_ok");
    // The read path's own deterministic answer (and its own S2 marking of
    // what that answer renders) is untouched by the agent-path append.
    expect(response.payload.ownerResult).toBe("Deterministic summary without the line.");
    void fetchMock;
  });
});

describe("S2b — protected voice boundary is unchanged", () => {
  it("the Second Brain voice boundary streams the agent's answer verbatim (no appended line) and marks only what it names", async () => {
    process.env.CARSON_SECOND_BRAIN_SESSION_SECRET = "session-signing-secret-for-tests-32b!!";
    process.env.CARSON_SECOND_BRAIN_PROVIDER_SECRET = "provider-secret-for-tests-only-32bytes!!";
    vi.stubEnv("CARSON_OPENAI_AGENT_ATTENTION_V1", "1");
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "owner-jwt-voice" });
    const markPresentedAttentionCaptures = vi.fn();
    const handler = createCarsonTurnHandler({
      classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
      fetchAttentionEvidence: vi.fn().mockResolvedValue({
        evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE] }),
        text: "unused",
      }),
      runAgent: vi.fn(async (agent) => {
        await agent.tools[0].invoke({}, "{}");
        return { finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES, newItems: [{ type: "tool_call_item" }] };
      }),
      buildAgent: (opts) => ({ __fakeAgent: true, ...opts }),
      markPresentedAttentionCaptures,
      dedupStore: new Map(),
    });
    const response = res();
    await handler(
      {
        method: "POST",
        headers: { authorization: "Bearer provider-secret-for-tests-only-32bytes!!", "x-carson-second-brain-binding": token },
        body: { messages: [{ role: "user", content: "What needs my attention?" }] },
      },
      response,
    );
    const streamed = response.chunks.join("");
    expect(streamed).not.toContain("Also on your mind");
    expect(streamed).not.toContain("Nimala");
    const { result } = markPresentedAttentionCaptures.mock.calls[0][0];
    expect(result.surfacedEvidenceIds).toEqual([]);
  });
});

describe("S2b — tenant isolation and evidence ownership", () => {
  it("evidence is fetched with this turn's owner identity, and only this turn's own evidence labels can be appended", async () => {
    const fetchMock = stubSupabase();
    const fetchAttentionEvidence = vi.fn().mockResolvedValue({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }), text: "unused" });
    const { handler } = agentHandler({ fetchAttentionEvidence, finalOutput: MODEL_ANSWER_WITHOUT_CAPTURES });
    const response = res();
    await handler(req(TURN, { authorization: "Bearer owner-a-jwt" }), response);
    expect(fetchAttentionEvidence).toHaveBeenCalledWith({ accountId: "account-a", authorization: "Bearer owner-a-jwt" });
    expect(response.payload.ownerResult).toContain("Check on Nimala’s wedding invitation");
    expect(response.payload.ownerResult).not.toContain("Improve the UI");
    for (const [, init] of fetchMock.mock.calls) expect(init.headers.Authorization).toBe("Bearer owner-a-jwt");
  });

  it("an unauthenticated request is rejected before any agent run, append, or mark", async () => {
    const fetchMock = stubSupabase();
    vi.stubEnv("CARSON_OPENAI_AGENT_ATTENTION_V1", "1");
    const runAgent = vi.fn();
    const markPresentedAttentionCaptures = vi.fn();
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue(null),
      fetchAttentionEvidence: vi.fn(),
      runAgent,
      markPresentedAttentionCaptures,
      dedupStore: new Map(),
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.statusCode).toBe(401);
    expect(runAgent).not.toHaveBeenCalled();
    expect(markPresentedAttentionCaptures).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("presentOmittedAttentionCaptures (unit)", () => {
  const grounded = (overrides = {}) => ({
    handled: true,
    status: 200,
    code: "attention_agent_ok",
    capability: "attention_summary_read",
    groundingStatus: "grounded",
    ownerResult: MODEL_ANSWER_WITHOUT_CAPTURES,
    evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE] }),
    surfacedEvidenceIds: [],
    ...overrides,
  });

  it("returns the very same object (no copy, no mutation) whenever it does not apply", () => {
    const turn = { transcript: "What needs my attention?" };
    for (const result of [
      null,
      undefined,
      { handled: false, status: 400, code: "invalid_owner_turn" },
      grounded({ code: "attention_read_ok" }),
      grounded({ groundingStatus: "failed" }),
      grounded({ capability: "calendar_read" }),
      grounded({ ownerResult: "" }),
      grounded({ evidence: { ...evidenceWith({ unresolvedCaptures: [NIMALA] }), ok: false } }),
      grounded({ evidence: evidenceWith({ unresolvedCaptures: [] }) }),
    ]) {
      expect(presentOmittedAttentionCaptures(turn, result)).toBe(result);
    }
  });

  it("does not mutate the coordinator's result when it appends", () => {
    const original = grounded();
    const snapshot = JSON.parse(JSON.stringify(original));
    const presented = presentOmittedAttentionCaptures({ transcript: "What's on my plate?" }, original);
    expect(presented).not.toBe(original);
    expect(original).toEqual(snapshot);
    expect(presented.surfacedEvidenceIds).toEqual(["ec7457e7", "3ae6ac9a"]);
  });

  it("a capture label appearing only inside a longer evidence label is not treated as presented — it is appended", () => {
    const call = item("c1", "todo", "Call", "unresolvedCaptures");
    const result = grounded({
      ownerResult: "Overdue: **Call Loulya**.",
      evidence: evidenceWith({
        overdueReminders: [item("r9", "reminder", "Call Loulya", "overdueReminders")],
        waiting: [],
        unresolvedCaptures: [call],
      }),
    });
    const presented = presentOmittedAttentionCaptures({ transcript: "What needs my attention?" }, result);
    expect(presented.ownerResult).toBe("Overdue: **Call Loulya**.\n\nAlso on your mind: Call (on your to-do list).");
    expect(presented.surfacedEvidenceIds).toEqual(["c1"]);
  });

  it("never throws on malformed evidence — returns the original result", () => {
    const result = grounded({ evidence: { ok: true, unresolvedCaptures: [NIMALA], overdueReminders: 7 } });
    expect(() => presentOmittedAttentionCaptures({ transcript: "What needs my attention?" }, result)).not.toThrow();
    expect(presentOmittedAttentionCaptures({ transcript: "What needs my attention?" }, result)).toBe(result);
  });

  it("uses the exact established deterministic wording", () => {
    expect(renderAlsoOnYourMindLine([NIMALA, IMPROVE])).toBe(
      "Also on your mind: Check on Nimala’s wedding invitation (a note you made); Improve the UI of Rahet Bal (on your to-do list).",
    );
  });
});
