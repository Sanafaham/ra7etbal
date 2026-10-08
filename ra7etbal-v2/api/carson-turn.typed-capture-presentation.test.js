/**
 * P3 Step 3 / S2b — owner-visible recovery of eligible captures on the
 * OpenAI-agent attention path (CARSON_OPENAI_AGENT_ATTENTION_V1), shared by
 * the typed path and the Second Brain voice boundary.
 *
 * Production failure (2026-10-08 10:42 UTC, conv_9001m4dhp0yjfttt9xz070j9pqfp):
 * "What needs my attention?", capture retrieval succeeded (Supabase edge logs:
 * carson_notes 3 rows / carson_todos 5 rows, 200, <1s), three captures were
 * eligible, and the agent's answer named none of them.
 *
 * Contract: the agent returns a structured { answer, answerKind } in the same
 * run. Omitted eligible captures are appended only for a grounded "summary"
 * answer to the existing general attention question that itself presents live
 * evidence. surfacedEvidenceIds — the only input to the awaited mark — is
 * derived on the server from the final answer. Nothing else changes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCarsonTurnHandler, markPresentedAttentionCapturesThroughServerPath } from "./carson-turn.js";
import { createSessionBinding } from "./_carson-second-brain-voice-boundary.js";
import {
  ATTENTION_AGENT_INSTRUCTIONS,
  ATTENTION_AGENT_OUTPUT,
  presentOmittedAttentionCaptures,
} from "./_carson-attention-agent.js";
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
  item("r2", "reminder", "Call Loulya", "overdueReminders", { dueDescription: "Overdue by 17 days" }),
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

// The model's 10:42 answer shape: overdue reminders + a Christopher
// delegation, no captures.
const SUMMARY_WITHOUT_CAPTURES =
  "As of now, these are overdue:\n\n- **charge your phone** — 12 hours\n- **Call Loulya** — 17 days\n\nYou’re also waiting on **Christopher: call me now**.";

const ALSO_LINE_ALL_THREE =
  "Also on your mind: Check on Nimala’s wedding invitation (a note you made); Improve the UI of Rahet Bal (on your to-do list); Review the Rahet Bal home screen (on your to-do list).";

const summary = (answer = SUMMARY_WITHOUT_CAPTURES) => ({ answer, answerKind: "summary" });

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
  runError = null,
  markPresentedAttentionCaptures = markPresentedAttentionCapturesThroughServerPath,
  dedupStore = new Map(),
  built = {},
}) {
  vi.stubEnv("CARSON_OPENAI_AGENT_ATTENTION_V1", "1");
  const runAgent = vi.fn(async (agent) => {
    if (callTool) await agent.tools[0].invoke({}, "{}");
    if (runError) throw runError;
    return { finalOutput, newItems: callTool ? [{ type: "tool_call_item" }] : [] };
  });
  const handler = createCarsonTurnHandler({
    authenticate: vi.fn().mockResolvedValue("account-a"),
    classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
    interpretIntent: vi.fn().mockResolvedValue({ capability: "unsupported" }),
    readCalendar: vi.fn(),
    fetchAttentionEvidence,
    runAgent,
    buildAgent: (opts) => {
      built.opts = opts;
      return { __fakeAgent: true, ...opts };
    },
    markPresentedAttentionCaptures,
    dedupStore,
  });
  return { handler, runAgent, fetchAttentionEvidence };
}

function patchedUrls(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => url).sort();
}

describe("S2b — structured result is requested from the same single agent run", () => {
  it("the agent is built with the { answer, answerKind } output type, its one existing tool, and runAgent is called exactly once", async () => {
    stubSupabase();
    const built = {};
    const { handler, runAgent } = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }),
      finalOutput: summary(),
      built,
    });
    await handler(req(TURN), res());
    expect(built.opts.outputType).toBe(ATTENTION_AGENT_OUTPUT);
    expect(built.opts.tools).toHaveLength(1);
    expect(built.opts.tools[0].name).toBe("get_ra7etbal_attention_state");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("the output schema accepts exactly the four answer kinds and requires both fields", () => {
    for (const answerKind of ["summary", "narrow", "clarification", "nothing_new"]) {
      expect(ATTENTION_AGENT_OUTPUT.safeParse({ answer: "x", answerKind }).success).toBe(true);
    }
    expect(ATTENTION_AGENT_OUTPUT.safeParse({ answer: "x", answerKind: "list" }).success).toBe(false);
    expect(ATTENTION_AGENT_OUTPUT.safeParse({ answer: "x" }).success).toBe(false);
    expect(ATTENTION_AGENT_OUTPUT.safeParse({ answerKind: "summary" }).success).toBe(false);
  });

  it("the instructions keep every existing rule and only add the output-format contract", () => {
    expect(ATTENTION_AGENT_INSTRUCTIONS).toContain("you MUST call get_ra7etbal_attention_state");
    expect(ATTENTION_AGENT_INSTRUCTIONS).toContain("Every fact you state must come from the tool result.");
    for (const kind of ['"summary"', '"narrow"', '"clarification"', '"nothing_new"']) {
      expect(ATTENTION_AGENT_INSTRUCTIONS).toContain(kind);
    }
    expect(ATTENTION_AGENT_INSTRUCTIONS).toContain('If you are unsure, use "narrow".');
  });
});

describe("S2b — completed general summary presents eligible captures the model omitted", () => {
  it("RED (10:42 reproduction): the final answer includes all three eligible captures and marks exactly them", async () => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE, REVIEW] }),
      finalOutput: summary(),
    });
    const response = res();
    await handler(req(TURN), response);

    expect(response.statusCode).toBe(200);
    expect(response.payload.groundingStatus).toBe("grounded");
    expect(response.payload.answerKind).toBe("summary");
    // The model's natural answer is preserved verbatim, then the line.
    expect(response.payload.ownerResult).toBe(`${SUMMARY_WITHOUT_CAPTURES}\n\n${ALSO_LINE_ALL_THREE}`);
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
    stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: captures }), finalOutput: summary() });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(`${SUMMARY_WITHOUT_CAPTURES}\n\n${line}`);
    expect(response.payload.surfacedEvidenceIds).toEqual(captures.map((c) => c.id));
  });

  it("an already-presented capture is not repeated — only the omitted ones are appended, each id once", async () => {
    const fetchMock = stubSupabase();
    const answer = `${SUMMARY_WITHOUT_CAPTURES}\n\nAlso: **Improve the UI of Rahet Bal** is still on your list.`;
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE, REVIEW] }), finalOutput: summary(answer) });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(
      `${answer}\n\nAlso on your mind: Check on Nimala’s wedding invitation (a note you made); Review the Rahet Bal home screen (on your to-do list).`,
    );
    expect(response.payload.ownerResult.match(/Improve the UI of Rahet Bal/g)).toHaveLength(1);
    expect(response.payload.surfacedEvidenceIds).toEqual(["ec7457e7", "3ae6ac9a", "7c7816de"]);
    expect(patchedUrls(fetchMock)).toEqual([
      "https://example.supabase.co/rest/v1/carson_notes?id=in.(ec7457e7)",
      "https://example.supabase.co/rest/v1/carson_todos?id=in.(3ae6ac9a,7c7816de)",
    ]);
  });

  it("an answer that already presents every capture is returned unchanged", async () => {
    stubSupabase();
    const answer = `${SUMMARY_WITHOUT_CAPTURES}\n\nOn your mind: Check on Nimala’s wedding invitation, Improve the UI of Rahet Bal, and Review the Rahet Bal home screen.`;
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE, REVIEW] }), finalOutput: summary(answer) });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(answer);
    expect(response.payload.surfacedEvidenceIds).toEqual(["ec7457e7", "3ae6ac9a", "7c7816de"]);
  });

  it("no eligible captures: answer unchanged, nothing marked", async () => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [] }), finalOutput: summary() });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(SUMMARY_WITHOUT_CAPTURES);
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("partial evidence that still carries eligible captures presents them truthfully", async () => {
    stubSupabase();
    const { handler } = agentHandler({
      evidence: evidenceWith({ completeness: "partial", unresolvedCaptures: [NIMALA] }),
      finalOutput: summary(),
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toContain("Also on your mind: Check on Nimala’s wedding invitation (a note you made).");
    expect(response.payload.surfacedEvidenceIds).toEqual(["ec7457e7"]);
  });
});

describe("S2b — narrow questions, clarifications and nothing-new never gain a capture line or a mark", () => {
  it.each([
    ["narrow Christopher question", "What's pending with Christopher?", { answer: "**Christopher: call me now** is still open.", answerKind: "narrow" }],
    ['"Am I clear to leave?"', "Am I clear to leave?", { answer: "Not quite — **Call Loulya** is overdue.", answerKind: "narrow" }],
    ["clarification naming a live item", "What needs my attention?", { answer: "Do you mean **Call Loulya**?", answerKind: "clarification" }],
    ["nothing new", "What needs my attention?", { answer: "Nothing else beyond **Call Loulya**, which I already mentioned.", answerKind: "nothing_new" }],
  ])("%s: answer unchanged, nothing marked", async (_name, transcript, finalOutput) => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE] }), finalOutput });
    const response = res();
    await handler(req({ ...TURN, transcript }), response);
    expect(response.payload.groundingStatus).toBe("grounded");
    expect(response.payload.ownerResult).toBe(finalOutput.answer);
    expect(response.payload.ownerResult).not.toContain("Also on your mind");
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a waiting-only question", "What am I waiting on?"],
    ["a follow-up in an active attention exchange", "What else?"],
    ["a Stage-1-admitted novel question", "Anything overdue?"],
  ])("answerKind summary is not enough on %s — answer unchanged", async (_name, transcript) => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE] }), finalOutput: summary() });
    const response = res();
    await handler(
      req({ ...TURN, transcript, previousCapability: "attention_summary_read", previousGroundingStatus: "grounded" }),
      response,
    );
    expect(response.payload.ownerResult).toBe(SUMMARY_WITHOUT_CAPTURES);
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a bare clarification", "Could you tell me which list you mean?"],
    ["a bare nothing-new", "Nothing else needs your attention right now."],
  ])("misleading answerKind summary on %s (names no live item) is not enough — answer unchanged", async (_name, answer) => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }), finalOutput: summary(answer) });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.ownerResult).toBe(answer);
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a plain-text final output (no structure)", SUMMARY_WITHOUT_CAPTURES],
    ["an unknown answerKind", { answer: SUMMARY_WITHOUT_CAPTURES, answerKind: "list" }],
    ["a missing answerKind", { answer: SUMMARY_WITHOUT_CAPTURES }],
  ])("%s carries no summary signal — answer kept, nothing added or marked", async (_name, finalOutput) => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }), finalOutput });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.groundingStatus).toBe("grounded");
    expect(response.payload.answerKind).toBeNull();
    expect(response.payload.ownerResult).toBe(SUMMARY_WITHOUT_CAPTURES);
    expect(response.payload.surfacedEvidenceIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("S2b — failed or incomplete answers never gain a capture line or a mark", () => {
  const HONEST_FAILURE = "I couldn't check your live Ra7etBal state right now — please try again in a moment.";

  it.each([
    ["failed evidence", { evidence: evidenceWith({ ok: false, unresolvedCaptures: [NIMALA] }), finalOutput: summary() }],
    ["evidence fetch threw / timed out", {
      fetchAttentionEvidence: vi.fn().mockRejectedValue(new Error("attention evidence source timed out")),
      finalOutput: summary(),
    }],
    ["model answered without calling the tool", {
      evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }),
      finalOutput: summary(),
      callTool: false,
    }],
    ["structured output failed to parse (SDK throws)", {
      evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }),
      finalOutput: null,
      runError: new SyntaxError("Unexpected token in JSON at position 0"),
    }],
    ["empty structured answer", { evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }), finalOutput: { answer: "   ", answerKind: "summary" } }],
    ["no final output", { evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }), finalOutput: undefined }],
  ])("%s: honest failure answer, nothing marked", async (_name, options) => {
    const fetchMock = stubSupabase();
    const { handler } = agentHandler(options);
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload.groundingStatus).toBe("failed");
    expect(response.payload.ownerResult).toBe(HONEST_FAILURE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("S2b — presentation-only marking, write ordering and dedup", () => {
  it("the mark runs once, after the final answer is assembled, before the response; the marked object is the returned object", async () => {
    const events = [];
    const markPresentedAttentionCaptures = vi.fn(async ({ result }) => {
      events.push(["mark", result.ownerResult.includes(ALSO_LINE_ALL_THREE), [...result.surfacedEvidenceIds]]);
    });
    const fetchAttentionEvidence = vi.fn(async () => {
      events.push(["retrieve"]);
      return { evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE, REVIEW] }), text: "unused" };
    });
    const { handler } = agentHandler({ fetchAttentionEvidence, finalOutput: summary(), markPresentedAttentionCaptures });
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
    expect(markPresentedAttentionCaptures).toHaveBeenCalledTimes(1);
    expect(markPresentedAttentionCaptures.mock.calls[0][0].result).toBe(response.payload);
  });

  it("a duplicate replay returns the same final answer and never marks again", async () => {
    const markPresentedAttentionCaptures = vi.fn();
    const { handler } = agentHandler({
      evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }),
      finalOutput: summary(),
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

  it("marking never uses model-reported ids: extra structured fields are ignored", () => {
    const result = presentOmittedAttentionCaptures(
      { transcript: "What needs my attention?" },
      {
        handled: true,
        status: 200,
        code: "attention_agent_ok",
        capability: "attention_summary_read",
        groundingStatus: "grounded",
        answerKind: "summary",
        ownerResult: SUMMARY_WITHOUT_CAPTURES,
        evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }),
        surfacedEvidenceIds: [],
        presentedCaptureIds: ["someone-elses-id", "7c7816de"],
      },
    );
    expect(result.surfacedEvidenceIds).toEqual(["ec7457e7"]);
  });
});

describe("S2b — the non-agent paths are untouched", () => {
  it("a non-attention turn: no agent run, no capture line, no mark", async () => {
    const fetchMock = stubSupabase();
    vi.stubEnv("CARSON_OPENAI_AGENT_ATTENTION_V1", "1");
    const runAgent = vi.fn();
    const markPresentedAttentionCaptures = vi.fn();
    const handler = createCarsonTurnHandler({
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
    const response = res();
    await handler(req({ ...TURN, transcript: "Hello" }), response);
    expect(runAgent).not.toHaveBeenCalled();
    expect(JSON.stringify(response.payload ?? {})).not.toContain("Also on your mind");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a calendar turn is untouched", async () => {
    const fetchMock = stubSupabase();
    vi.stubEnv("CARSON_OPENAI_AGENT_ATTENTION_V1", "1");
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
      interpretIntent: vi.fn().mockResolvedValue({ capability: "calendar_read", range: "today" }),
      readCalendar: vi.fn().mockResolvedValue({ events: [] }),
      fetchAttentionEvidence: vi.fn(),
      runAgent: vi.fn(),
      buildAgent: (opts) => ({ __fakeAgent: true, ...opts }),
      markPresentedAttentionCaptures: vi.fn(),
      dedupStore: new Map(),
    });
    const response = res();
    await handler(req({ ...TURN, transcript: "What's on my calendar today?" }), response);
    expect(JSON.stringify(response.payload ?? {})).not.toContain("Also on your mind");
    expect(response.payload?.surfacedEvidenceIds).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the flag-off typed read path (Stage 1/2 coordinator) is unchanged", async () => {
    stubSupabase();
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
    expect(response.payload.ownerResult).toBe("Deterministic summary without the line.");
  });
});

describe("S2b — Second Brain voice boundary shares the same coordinator contract", () => {
  const PROVIDER = "provider-secret-for-tests-only-32bytes!!";

  function voiceHandler({ finalOutput, markPresentedAttentionCaptures }) {
    process.env.CARSON_SECOND_BRAIN_SESSION_SECRET = "session-signing-secret-for-tests-32b!!";
    process.env.CARSON_SECOND_BRAIN_PROVIDER_SECRET = PROVIDER;
    vi.stubEnv("CARSON_OPENAI_AGENT_ATTENTION_V1", "1");
    return createCarsonTurnHandler({
      classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
      fetchAttentionEvidence: vi.fn().mockResolvedValue({
        evidence: evidenceWith({ unresolvedCaptures: [NIMALA, IMPROVE] }),
        text: "unused",
      }),
      runAgent: vi.fn(async (agent) => {
        await agent.tools[0].invoke({}, "{}");
        return { finalOutput, newItems: [{ type: "tool_call_item" }] };
      }),
      buildAgent: (opts) => ({ __fakeAgent: true, ...opts }),
      markPresentedAttentionCaptures,
      dedupStore: new Map(),
    });
  }

  async function speak(handler, content) {
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "owner-jwt-voice" });
    const response = res();
    await handler(
      {
        method: "POST",
        headers: { authorization: `Bearer ${PROVIDER}`, "x-carson-second-brain-binding": token },
        body: { messages: [{ role: "user", content }] },
      },
      response,
    );
    return response.chunks.join("");
  }

  it("a summary answer streams the same final text typed receives (with the capture line) and marks exactly those captures", async () => {
    const events = [];
    const markPresentedAttentionCaptures = vi.fn(async ({ authorization, result }) => {
      events.push("mark");
      expect(authorization).toBe("Bearer owner-jwt-voice");
      expect(result.surfacedEvidenceIds).toEqual(["ec7457e7", "3ae6ac9a"]);
    });
    const handler = voiceHandler({ finalOutput: summary(), markPresentedAttentionCaptures });
    const streamed = await speak(handler, "What needs my attention?");
    expect(streamed).toContain("Also on your mind: Check on Nimala’s wedding invitation (a note you made); Improve the UI of Rahet Bal (on your to-do list).");
    expect(markPresentedAttentionCaptures).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["mark"]);
  });

  it("a narrow voice answer streams unchanged and marks nothing", async () => {
    const markPresentedAttentionCaptures = vi.fn();
    const handler = voiceHandler({
      finalOutput: { answer: "**Christopher: call me now** is still open.", answerKind: "narrow" },
      markPresentedAttentionCaptures,
    });
    const streamed = await speak(handler, "What's pending with Christopher?");
    expect(streamed).not.toContain("Also on your mind");
    expect(markPresentedAttentionCaptures.mock.calls[0][0].result.surfacedEvidenceIds).toEqual([]);
  });
});

describe("S2b — tenant isolation and evidence ownership", () => {
  it("evidence is fetched with this turn's owner identity, and only this turn's own evidence labels can be appended", async () => {
    const fetchMock = stubSupabase();
    const fetchAttentionEvidence = vi.fn().mockResolvedValue({ evidence: evidenceWith({ unresolvedCaptures: [NIMALA] }), text: "unused" });
    const { handler } = agentHandler({ fetchAttentionEvidence, finalOutput: summary() });
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
    answerKind: "summary",
    ownerResult: SUMMARY_WITHOUT_CAPTURES,
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
      grounded({ answerKind: null }),
      grounded({ answerKind: "narrow" }),
      grounded({ answerKind: "clarification" }),
      grounded({ answerKind: "nothing_new" }),
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
      evidence: evidenceWith({ waiting: [], unresolvedCaptures: [call] }),
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
