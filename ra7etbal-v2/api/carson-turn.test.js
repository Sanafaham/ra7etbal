import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCarsonTurnHandler,
  interpretReadIntentWithClaude,
  readCalendarThroughExistingHandler,
} from "./carson-turn.js";
import { shouldClearRevokedCalendarCredentials } from "./google-calendar.js";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
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
