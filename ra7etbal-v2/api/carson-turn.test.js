import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCarsonTurnHandler,
  interpretReadIntentWithClaude,
  readCalendarThroughExistingHandler,
} from "./carson-turn.js";
import { shouldClearRevokedCalendarCredentials } from "./google-calendar.js";
import googleCalendarHandler from "./google-calendar.js";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function req(body = {}, headers = { authorization: "Bearer session-a" }) {
  return { method: "POST", body, headers };
}

function res() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function httpResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function configureRealBoundaryFetch({ profileToken = "refresh-token", tokenStatus = 200, events = [] } = {}) {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  const requests = [];
  const fetchMock = vi.fn(async (url, options = {}) => {
    const href = String(url);
    const method = options.method ?? "GET";
    requests.push({ href, method });
    if (href === "https://api.anthropic.com/v1/messages") {
      return httpResponse(200, { content: [{ type: "tool_use", name: "select_read_capability", input: { capability: "calendar_read", range: "tomorrow" } }] });
    }
    if (href === "https://supabase.test/auth/v1/user") return httpResponse(200, { id: "account-a" });
    if (href.startsWith("https://supabase.test/rest/v1/profiles") && method === "GET") {
      return httpResponse(200, profileToken ? [{ google_refresh_token: profileToken }] : [{}]);
    }
    if (href === "https://oauth2.googleapis.com/token") {
      return tokenStatus === 200 ? httpResponse(200, { access_token: "access-token" }) : httpResponse(tokenStatus, { error: "invalid_grant" });
    }
    if (href.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?")) {
      return httpResponse(200, { items: events });
    }
    if (href.startsWith("https://supabase.test/rest/v1/profiles") && method === "PATCH") return httpResponse(204, null);
    throw new Error(`Unexpected external request: ${method} ${href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

const TURN = {
  turnId: "turn-1",
  providerEventId: "eleven-event-1",
  transcript: "What do I have on my calendar tomorrow?",
};

describe("Claude strict read intent", () => {
  it("forces a strict schema tool call and returns its structured input", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "tool_use", name: "select_read_capability", input: { capability: "calendar_read", range: "tomorrow" } }] }),
    });
    await expect(interpretReadIntentWithClaude(TURN.transcript, fetchMock)).resolves.toEqual({ capability: "calendar_read", range: "tomorrow" });
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.tool_choice).toEqual({ type: "tool", name: "select_read_capability" });
    expect(requestBody.tools[0]).toMatchObject({ name: "select_read_capability", strict: true });
    expect(requestBody.tools[0].input_schema.additionalProperties).toBe(false);
  });

  it("rejects model prose without a structured tool result", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: "text", text: "Tomorrow is clear." }] }) });
    await expect(interpretReadIntentWithClaude(TURN.transcript, fetchMock)).rejects.toThrow("no structured intent");
  });
});

describe("existing Calendar read adapter", () => {
  it("suppresses the existing revoked-token cleanup write only for the read-only proof", () => {
    expect(shouldClearRevokedCalendarCredentials({ suppressCredentialCleanup: "true" })).toBe(false);
    expect(shouldClearRevokedCalendarCredentials({})).toBe(true);
  });

  it("calls the existing authenticated Calendar handler as GET and returns its evidence", async () => {
    const existingHandler = vi.fn(async (request, response) => {
      expect(request).toEqual({ method: "GET", query: { range: "tomorrow", suppressCredentialCleanup: "true" }, headers: { authorization: "Bearer session-a" } });
      return response.status(200).json({ connected: true, events: [{ id: "evt-1", title: "Dentist" }] });
    });
    await expect(readCalendarThroughExistingHandler({ authorization: "Bearer session-a", range: "tomorrow" }, existingHandler)).resolves.toEqual({
      connected: true,
      events: [{ id: "evt-1", title: "Dentist" }],
    });
    expect(existingHandler).toHaveBeenCalledOnce();
  });
});

describe("production-shaped Carson read turn", () => {
  it("runs owner input through strict intent, policy, existing Calendar read, evidence, and canonical result", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const modelFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "tool_use", name: "select_read_capability", input: { capability: "calendar_read", range: "tomorrow" } }] }),
    });
    const existingCalendarHandler = vi.fn(async (request, response) => response.status(200).json({
      connected: true,
      events: [{ id: "evt-1", title: "Dentist", start: "2026-08-20T10:00:00+03:00", end: null, location: null, allDay: false }],
    }));
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      interpretIntent: (transcript) => interpretReadIntentWithClaude(transcript, modelFetch),
      readCalendar: (input) => readCalendarThroughExistingHandler(input, existingCalendarHandler),
      dedupStore: new Map(),
    });
    const response = res();
    await handler(req(TURN), response);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      handled: true,
      turnId: "turn-1",
      capability: "calendar_read",
      ownerResult: "Tomorrow: Dentist.",
      evidence: { code: "calendar_read_succeeded", connected: true, range: "tomorrow" },
    });
    expect(existingCalendarHandler).toHaveBeenCalledOnce();
    expect(existingCalendarHandler.mock.calls[0][0].method).toBe("GET");
  });

  it("preserves authenticated account isolation and rejects unauthenticated turns before model/tool calls", async () => {
    const interpretIntent = vi.fn();
    const readCalendar = vi.fn();
    const handler = createCarsonTurnHandler({ authenticate: vi.fn().mockResolvedValue(null), interpretIntent, readCalendar, dedupStore: new Map() });
    const response = res();
    await handler(req(TURN), response);
    expect(response.statusCode).toBe(401);
    expect(interpretIntent).not.toHaveBeenCalled();
    expect(readCalendar).not.toHaveBeenCalled();
  });

  it("deduplicates the same provider event before a second model or Calendar call", async () => {
    const interpretIntent = vi.fn().mockResolvedValue({ capability: "calendar_read", range: "tomorrow" });
    const readCalendar = vi.fn().mockResolvedValue({ connected: true, events: [] });
    const handler = createCarsonTurnHandler({ authenticate: vi.fn().mockResolvedValue("account-a"), interpretIntent, readCalendar, dedupStore: new Map() });
    const first = res();
    const second = res();
    await handler(req(TURN), first);
    await handler(req(TURN), second);
    expect(interpretIntent).toHaveBeenCalledOnce();
    expect(readCalendar).toHaveBeenCalledOnce();
    expect(second.payload).toMatchObject({ duplicate: true, ownerResult: "You have nothing on your calendar tomorrow." });
  });

  it("shares one in-flight result when duplicate provider events arrive concurrently", async () => {
    let releaseRead;
    const interpretIntent = vi.fn().mockResolvedValue({ capability: "calendar_read", range: "tomorrow" });
    const readCalendar = vi.fn(() => new Promise((resolve) => { releaseRead = resolve; }));
    const handler = createCarsonTurnHandler({ authenticate: vi.fn().mockResolvedValue("account-a"), interpretIntent, readCalendar, dedupStore: new Map() });
    const first = res();
    const second = res();
    const firstCall = handler(req(TURN), first);
    await vi.waitFor(() => expect(readCalendar).toHaveBeenCalledOnce());
    const secondCall = handler(req(TURN), second);
    releaseRead({ connected: true, events: [] });
    await Promise.all([firstCall, secondCall]);
    expect(interpretIntent).toHaveBeenCalledOnce();
    expect(readCalendar).toHaveBeenCalledOnce();
    expect(second.payload).toMatchObject({ duplicate: true, ownerResult: "You have nothing on your calendar tomorrow." });
  });

  it("scopes duplicate identity by authenticated account", async () => {
    const accounts = ["account-a", "account-b"];
    const interpretIntent = vi.fn().mockResolvedValue({ capability: "calendar_read", range: "tomorrow" });
    const readCalendar = vi.fn().mockResolvedValue({ connected: true, events: [] });
    const handler = createCarsonTurnHandler({ authenticate: vi.fn(async () => accounts.shift()), interpretIntent, readCalendar, dedupStore: new Map() });
    await handler(req(TURN), res());
    await handler(req(TURN), res());
    expect(interpretIntent).toHaveBeenCalledTimes(2);
    expect(readCalendar).toHaveBeenCalledTimes(2);
    expect(readCalendar.mock.calls.map(([input]) => input.accountId)).toEqual(["account-a", "account-b"]);
  });

  it("returns ownership collision without invoking either new dependency", async () => {
    const interpretIntent = vi.fn();
    const readCalendar = vi.fn();
    const handler = createCarsonTurnHandler({ authenticate: vi.fn().mockResolvedValue("account-a"), interpretIntent, readCalendar, dedupStore: new Map() });
    const response = res();
    await handler(req({ ...TURN, legacyClaimed: true }), response);
    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({ handled: false, code: "ownership_collision" });
    expect(interpretIntent).not.toHaveBeenCalled();
    expect(readCalendar).not.toHaveBeenCalled();
  });
});

describe("Carson turn handler — attention_summary_read routing (typed hard-grounding)", () => {
  const ATTENTION_TURN = { turnId: "turn-attn-1", providerEventId: "eleven-event-attn-1", transcript: "What needs my attention?" };

  it("routes an attention-classified transcript to the deterministic attention path — Claude/calendar are never invoked", async () => {
    const interpretIntent = vi.fn();
    const readCalendar = vi.fn();
    const fetchAttentionEvidence = vi.fn().mockResolvedValue({
      evidence: { ok: true, code: "attention_read_succeeded", completeness: "full" },
      text: "Needs your attention: call the dentist.",
    });
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      interpretIntent,
      readCalendar,
      fetchAttentionEvidence,
      dedupStore: new Map(),
    });
    const response = res();

    await handler(req(ATTENTION_TURN), response);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      handled: true,
      capability: "attention_summary_read",
      groundingStatus: "grounded",
      ownerResult: "Needs your attention: call the dentist.",
    });
    expect(interpretIntent).not.toHaveBeenCalled();
    expect(readCalendar).not.toHaveBeenCalled();
    expect(fetchAttentionEvidence).toHaveBeenCalledWith({ accountId: "account-a", authorization: "Bearer session-a" });
  });

  it("never falls through to the calendar/Claude path even when the grounded retrieval fails — no plausible answer is substituted", async () => {
    const interpretIntent = vi.fn();
    const readCalendar = vi.fn();
    const fetchAttentionEvidence = vi.fn().mockResolvedValue({
      evidence: { ok: false, code: "attention_read_failed", completeness: "none" },
      text: "I couldn't check what needs your attention right now — the live check didn't complete.",
    });
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      interpretIntent,
      readCalendar,
      fetchAttentionEvidence,
      dedupStore: new Map(),
    });
    const response = res();

    await handler(req(ATTENTION_TURN), response);

    expect(response.statusCode).toBe(502);
    expect(response.payload).toMatchObject({
      handled: true,
      groundingStatus: "failed",
      ownerResult: "I couldn't check what needs your attention right now — the live check didn't complete.",
    });
    expect(interpretIntent).not.toHaveBeenCalled();
    expect(readCalendar).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated attention turn before any retrieval, exactly like calendar turns", async () => {
    const fetchAttentionEvidence = vi.fn();
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue(null),
      fetchAttentionEvidence,
      dedupStore: new Map(),
    });
    const response = res();
    await handler(req(ATTENTION_TURN), response);
    expect(response.statusCode).toBe(401);
    expect(fetchAttentionEvidence).not.toHaveBeenCalled();
  });

  it("a non-attention transcript still reaches the existing calendar path unchanged", async () => {
    const interpretIntent = vi.fn().mockResolvedValue({ capability: "calendar_read", range: "tomorrow" });
    const readCalendar = vi.fn().mockResolvedValue({ connected: true, events: [] });
    const fetchAttentionEvidence = vi.fn();
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      interpretIntent,
      readCalendar,
      fetchAttentionEvidence,
      dedupStore: new Map(),
    });
    const response = res();
    await handler(req(TURN), response);
    expect(response.payload).toMatchObject({ capability: "calendar_read" });
    expect(fetchAttentionEvidence).not.toHaveBeenCalled();
  });
});

describe("Carson turn handler — Second Brain stateful reasoning admission (2026-08-28)", () => {
  const EVIDENCE = {
    ok: true,
    code: "attention_read_succeeded",
    completeness: "full",
    needsAttention: [{ id: "task-1", label: "call the dentist", reason: "overdue" }],
    waiting: [],
    unresolvedCaptures: [],
  };
  const CONTINUATION_BODY = {
    turnId: "turn-continue-1",
    providerEventId: "eleven-event-continue-1",
    transcript: "What else?",
    previousCapability: "attention_summary_read",
    previousGroundingStatus: "grounded",
    previouslySurfacedEvidenceIds: ["task-0"],
    priorObjective: "reviewing attention list",
  };

  it("admits a context-only (no direct regex match) message into the reasoning path and threads conversationState through to reasonOverEvidence", async () => {
    const interpretIntent = vi.fn();
    const readCalendar = vi.fn();
    const fetchAttentionEvidence = vi.fn().mockResolvedValue({ evidence: EVIDENCE, text: "Needs your attention: call the dentist." });
    const reasonOverEvidence = vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: ["task-1"] });
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      interpretIntent,
      readCalendar,
      fetchAttentionEvidence,
      reasonOverEvidence,
      dedupStore: new Map(),
    });
    const response = res();

    await handler(req(CONTINUATION_BODY), response);

    expect(interpretIntent).not.toHaveBeenCalled();
    expect(readCalendar).not.toHaveBeenCalled();
    expect(reasonOverEvidence).toHaveBeenCalledOnce();
    expect(reasonOverEvidence.mock.calls[0][0].conversationState).toMatchObject({
      priorCapability: "attention_summary_read",
      priorGroundingStatus: "grounded",
      previouslySurfacedEvidenceIds: ["task-0"],
      priorObjective: "reviewing attention list",
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ handled: true, capability: "attention_summary_read", groundingStatus: "grounded" });
  });

  it("not_attention falls through to the existing calendar/Claude path, which independently evaluates the same transcript", async () => {
    const interpretIntent = vi.fn().mockResolvedValue({ capability: "unsupported", range: "tomorrow" });
    const readCalendar = vi.fn();
    const fetchAttentionEvidence = vi.fn().mockResolvedValue({ evidence: EVIDENCE, text: "Needs your attention: call the dentist." });
    const reasonOverEvidence = vi.fn().mockResolvedValue({ responseIntent: "not_attention", selectedEvidenceIds: [] });
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      interpretIntent,
      readCalendar,
      fetchAttentionEvidence,
      reasonOverEvidence,
      dedupStore: new Map(),
    });
    const response = res();

    await handler(req({ ...CONTINUATION_BODY, transcript: "Send Christopher a message." }), response);

    expect(fetchAttentionEvidence).toHaveBeenCalledOnce();
    expect(reasonOverEvidence).toHaveBeenCalledOnce();
    // Fell through to the calendar/Claude coordinator, which itself found
    // nothing to claim either — final result is unhandled, exactly what
    // tells the typed widget to fall through to the normal chat path.
    expect(interpretIntent).toHaveBeenCalledOnce();
    expect(response.payload).toMatchObject({ handled: false, code: "unsupported_intent" });
  });

  it("a message with neither a direct match nor active context never invokes reasonOverEvidence", async () => {
    const reasonOverEvidence = vi.fn();
    const fetchAttentionEvidence = vi.fn();
    const handler = createCarsonTurnHandler({
      authenticate: vi.fn().mockResolvedValue("account-a"),
      interpretIntent: vi.fn().mockResolvedValue({ capability: "calendar_read", range: "tomorrow" }),
      readCalendar: vi.fn().mockResolvedValue({ connected: true, events: [] }),
      fetchAttentionEvidence,
      reasonOverEvidence,
      dedupStore: new Map(),
    });
    await handler(req(TURN), res());
    expect(reasonOverEvidence).not.toHaveBeenCalled();
    expect(fetchAttentionEvidence).not.toHaveBeenCalled();
  });
});

describe("production-shaped Carson turn through the real Calendar handler", () => {
  it("returns canonical evidence for a connected calendar without any write boundary", async () => {
    const { requests } = configureRealBoundaryFetch({
      events: [{
        id: "evt-1",
        summary: "Dentist",
        start: { dateTime: "2026-08-20T10:00:00+03:00" },
        end: { dateTime: "2026-08-20T11:00:00+03:00" },
      }],
    });
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });
    const response = res();

    await handler(req(TURN), response);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      handled: true,
      capability: "calendar_read",
      ownerResult: "Tomorrow: Dentist.",
      evidence: {
        code: "calendar_read_succeeded",
        events: [{ id: "evt-1", title: "Dentist" }],
      },
    });
    expect(requests.filter(({ href }) => href === "https://supabase.test/auth/v1/user")).toHaveLength(2);
    expect(requests.some(({ href }) => href.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?"))).toBe(true);
    expect(requests.every(({ method }) => method === "GET" || method === "POST")).toBe(true);
  });

  it("returns the canonical disconnected result through the real Calendar handler without mutation", async () => {
    const { requests } = configureRealBoundaryFetch({ profileToken: null });
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });
    const response = res();

    await handler(req({ ...TURN, providerEventId: "eleven-event-disconnected" }), response);

    expect(response.statusCode).toBe(502);
    expect(response.payload).toMatchObject({
      handled: true,
      code: "calendar_not_connected",
      ownerResult: "I couldn't read your calendar. Please reconnect it in Settings.",
      evidence: { connected: false, events: [] },
    });
    expect(requests.some(({ method }) => method === "PATCH")).toBe(false);
  });

  it("runs the real revoked-token path without Stage 1 credential cleanup, while preserving ordinary cleanup", async () => {
    const stageOne = configureRealBoundaryFetch({ tokenStatus: 401 });
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });
    const response = res();

    await handler(req({ ...TURN, providerEventId: "eleven-event-revoked" }), response);

    expect(response.statusCode).toBe(502);
    expect(response.payload).toMatchObject({
      handled: true,
      code: "calendar_reconnect_required",
      ownerResult: "I couldn't read your calendar. Please reconnect it in Settings.",
    });
    expect(stageOne.requests.some(({ method }) => method === "PATCH")).toBe(false);

    const ordinary = configureRealBoundaryFetch({ tokenStatus: 401 });
    const calendarResponse = {
      statusCode: 200,
      payload: null,
      headers: {},
      status(code) { this.statusCode = code; return this; },
      json(value) { this.payload = value; return this; },
      setHeader(name, value) { this.headers[name] = value; return this; },
    };
    await googleCalendarHandler({ method: "GET", query: { range: "tomorrow" }, headers: { authorization: "Bearer session-a" } }, calendarResponse);
    expect(ordinary.requests.filter(({ method }) => method === "PATCH")).toHaveLength(1);
    expect(calendarResponse.payload).toMatchObject({ connected: false, revoked: true });
  });
});
