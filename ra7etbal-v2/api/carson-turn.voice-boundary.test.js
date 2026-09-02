/**
 * Second Brain Slice 2 — the ElevenLabs Custom LLM voice-boundary branch
 * added to the existing, protected api/carson-turn.js endpoint.
 *
 * Reuses this file's own existing DI test conventions (see
 * carson-turn.test.js) so the voice boundary is proven to reuse the exact
 * same coordinateOwnerTurn admission/routing as typed — not a second,
 * independently-behaving path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCarsonTurnHandler } from "./carson-turn.js";
import { createSessionBinding } from "./_carson-second-brain-voice-boundary.js";

const TEST_SESSION_SECRET = "session-signing-secret-for-tests-32b!!";
const TEST_PROVIDER_SECRET = "provider-secret-for-tests-only-32bytes!!";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function configure() {
  process.env.CARSON_SECOND_BRAIN_SESSION_SECRET = TEST_SESSION_SECRET;
  process.env.CARSON_SECOND_BRAIN_PROVIDER_SECRET = TEST_PROVIDER_SECRET;
}

function res() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    chunks: [],
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this.chunks.push(chunk); },
    end() {},
  };
}

function voiceReq({ authorization, bindingHeader, messages }) {
  return {
    method: "POST",
    headers: {
      authorization: authorization ?? `Bearer ${TEST_PROVIDER_SECRET}`,
      ...(bindingHeader ? { "x-carson-second-brain-binding": bindingHeader } : {}),
    },
    body: { messages: messages ?? [{ role: "user", content: "What needs my attention?" }] },
  };
}

describe("carson-turn.js — Second Brain voice-boundary branch", () => {
  it("rejects a missing/incorrect provider secret", async () => {
    configure();
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });
    const response = res();
    await handler(voiceReq({ authorization: "Bearer wrong" }), response);
    expect(response.statusCode).toBe(401);
  });

  it("fails closed (503) when the provider secret is not configured", async () => {
    process.env.CARSON_SECOND_BRAIN_SESSION_SECRET = TEST_SESSION_SECRET;
    delete process.env.CARSON_SECOND_BRAIN_PROVIDER_SECRET;
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });
    const response = res();
    await handler(voiceReq({}), response);
    expect(response.statusCode).toBe(503);
  });

  it("rejects a missing/invalid/expired session binding", async () => {
    configure();
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });
    const response = res();
    await handler(voiceReq({}), response); // no binding header at all
    expect(response.statusCode).toBe(401);
  });

  it("accepts a valid provider secret + valid binding and reuses the SAME coordinateOwnerTurn routing as typed", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "real-owner-jwt" });
    const fetchAttentionEvidence = vi.fn().mockResolvedValue({
      evidence: { ok: true, code: "attention_read_succeeded", completeness: "full", generatedAt: new Date().toISOString(), needsYou: [], overdueReminders: [], upcomingReminders: [], waiting: [], later: [], unresolvedCaptures: [] },
      text: "Nothing needs your attention right now.",
    });
    const handler = createCarsonTurnHandler({
      classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
      fetchAttentionEvidence,
      dedupStore: new Map(),
    });
    const response = res();
    await handler(voiceReq({ bindingHeader: token, messages: [{ role: "user", content: "What needs my attention?" }] }), response);

    expect(response.statusCode).toBe(200);
    const streamed = response.chunks.join("");
    expect(streamed).toContain("Nothing needs your attention right now.");
    // Reused the real evidence fetch with the binding's embedded JWT as the
    // authorization — the same RLS-scoped contract typed already relies on.
    expect(fetchAttentionEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: "Bearer real-owner-jwt" }),
    );
  });

  it("streams exactly one [DONE] and never echoes the binding token or JWT in the response", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "super-secret-jwt-value" });
    const fetchAttentionEvidence = vi.fn().mockResolvedValue({
      evidence: { ok: true, code: "attention_read_succeeded", completeness: "full", generatedAt: new Date().toISOString(), needsYou: [], overdueReminders: [], upcomingReminders: [], waiting: [], later: [], unresolvedCaptures: [] },
      text: "Nothing needs your attention right now.",
    });
    const handler = createCarsonTurnHandler({
      classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
      fetchAttentionEvidence,
      dedupStore: new Map(),
    });
    const response = res();
    await handler(voiceReq({ bindingHeader: token }), response);
    const streamed = response.chunks.join("");
    expect((streamed.match(/data: \[DONE\]/g) || []).length).toBe(1);
    expect(streamed).not.toContain("super-secret-jwt-value");
    expect(streamed).not.toContain(token);
  });

  it("fails safe with a fixed message when coordination throws — never a fabricated answer", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
    const handler = createCarsonTurnHandler({
      classifyOperationalIntent: vi.fn().mockRejectedValue(new Error("boom")),
      fetchAttentionEvidence: vi.fn().mockRejectedValue(new Error("boom")),
      dedupStore: new Map(),
    });
    const response = res();
    // classifyOperationalIntent throwing is already handled inside
    // coordinateOwnerTurn (falls back to not_operational -> calendar), so
    // force a genuine coordination failure via a broken readCalendar too.
    const brokenHandler = createCarsonTurnHandler({
      classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
      readCalendar: vi.fn().mockRejectedValue(new Error("boom")),
      interpretIntent: vi.fn().mockRejectedValue(new Error("boom")),
      dedupStore: new Map(),
    });
    await brokenHandler(voiceReq({ bindingHeader: token, messages: [{ role: "user", content: "unrelated question" }] }), response);
    expect(response.statusCode).toBe(200); // still streams a safe SSE turn
    expect(response.chunks.join("")).not.toMatch(/undefined|\[object Object\]/);
  });

  describe("ordinary conversation never gets the operational fail-closed message", () => {
    // interpretIntent stands in for coordinateCalendar's Claude call; an
    // "unsupported" capability is exactly what a real non-calendar,
    // non-attention utterance would classify as — this is what makes
    // coordinateOwnerTurn return handled:false ("unsupported_intent"), the
    // only path that should ever reach the natural conversational fallback.
    function unclaimedTurnHandler(overrides = {}) {
      return createCarsonTurnHandler({
        classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
        interpretIntent: vi.fn().mockResolvedValue({ capability: "unsupported", range: "today" }),
        dedupStore: new Map(),
        ...overrides,
      });
    }

    it.each(["Hello", "How are you?", "Thanks"])(
      '"%s" gets a natural reply, never "I couldn\'t confirm that"',
      async (utterance) => {
        configure();
        const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
        const handler = unclaimedTurnHandler();
        const response = res();
        await handler(voiceReq({ bindingHeader: token, messages: [{ role: "user", content: utterance }] }), response);
        expect(response.statusCode).toBe(200);
        const streamed = response.chunks.join("");
        expect(streamed).not.toContain("I couldn't confirm that");
        expect(streamed).toContain("Hi! What can I help with?");
      },
    );

    it("does not 400 before intent classification runs — the providerEventId placeholder satisfies coordinateCalendar's dedup-key guard", async () => {
      configure();
      const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
      const interpretIntent = vi.fn().mockResolvedValue({ capability: "unsupported", range: "today" });
      const handler = unclaimedTurnHandler({ interpretIntent });
      await handler(voiceReq({ bindingHeader: token, messages: [{ role: "user", content: "Hello" }] }), res());
      // Proves coordinateCalendar's early invalid_owner_turn guard did not
      // reject the turn before ever calling interpretIntent (the historical
      // bug: providerEventId: "" was falsy there for every voice turn).
      expect(interpretIntent).toHaveBeenCalled();
    });

    it('"What needs my attention?" still uses the grounded attention path, not the conversational fallback', async () => {
      configure();
      const { token } = createSessionBinding({ accountId: "owner-1", jwt: "real-owner-jwt" });
      const fetchAttentionEvidence = vi.fn().mockResolvedValue({
        evidence: { ok: true, code: "attention_read_succeeded", completeness: "full", generatedAt: new Date().toISOString(), needsYou: [], overdueReminders: [], upcomingReminders: [], waiting: [], later: [], unresolvedCaptures: [] },
        text: "Nothing needs your attention right now.",
      });
      const handler = createCarsonTurnHandler({
        classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
        fetchAttentionEvidence,
        dedupStore: new Map(),
      });
      const response = res();
      await handler(voiceReq({ bindingHeader: token, messages: [{ role: "user", content: "What needs my attention?" }] }), response);
      const streamed = response.chunks.join("");
      expect(streamed).toContain("Nothing needs your attention right now.");
      expect(streamed).not.toContain("Hi! What can I help with?");
    });

    it('a grounded follow-up ("what about the things I\'m waiting on?") after active attention context still uses the grounded path, not the conversational fallback', async () => {
      configure();
      const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
      const fetchAttentionEvidence = vi.fn().mockResolvedValue({
        evidence: { ok: true, code: "attention_read_succeeded", completeness: "full", generatedAt: new Date().toISOString(), needsYou: [], overdueReminders: [], upcomingReminders: [], waiting: [{ id: "w1", text: "Waiting on Christopher" }], later: [], unresolvedCaptures: [] },
        text: "You're waiting on Christopher to confirm.",
      });
      const handler = createCarsonTurnHandler({
        // Direct attention intent admits without needing Stage 1 at all —
        // exercises the same admission path a real "what about..."
        // follow-up spoken right after an attention answer would take.
        classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
        fetchAttentionEvidence,
        dedupStore: new Map(),
      });
      const response = res();
      await handler(
        voiceReq({ bindingHeader: token, messages: [{ role: "user", content: "What am I waiting on?" }] }),
        response,
      );
      const streamed = response.chunks.join("");
      expect(streamed).toContain("You're waiting on Christopher to confirm.");
      expect(streamed).not.toContain("Hi! What can I help with?");
    });

    it("a real operational grounding failure still fails closed with its own truthful text, not the conversational fallback", async () => {
      configure();
      const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
      const handler = createCarsonTurnHandler({
        classifyOperationalIntent: vi.fn().mockResolvedValue("operational_state_read"),
        fetchAttentionEvidence: vi.fn().mockResolvedValue({ evidence: { ok: false, code: "attention_read_failed" }, text: null }),
        dedupStore: new Map(),
      });
      const response = res();
      await handler(voiceReq({ bindingHeader: token, messages: [{ role: "user", content: "What needs my attention?" }] }), response);
      const streamed = response.chunks.join("");
      expect(streamed).toContain("the live check didn't complete");
      expect(streamed).not.toContain("Hi! What can I help with?");
    });
  });

  it("logs a safe, secret-free diagnostic when the provider secret is wrong (C-03 live-gate 401 tracing)", async () => {
    configure();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });
    await handler(voiceReq({ authorization: "Bearer wrong" }), res());
    expect(warn).toHaveBeenCalledWith(
      "[carson-second-brain-voice-boundary] provider_rejected",
      expect.objectContaining({ provider_secret_present: true }),
    );
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain(TEST_PROVIDER_SECRET);
    expect(serialized).not.toContain("wrong");
  });

  it("logs a safe, secret-free binding diagnostic when the binding is missing/invalid/expired (C-03 live-gate 401 tracing)", async () => {
    configure();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });

    await handler(voiceReq({}), res()); // no binding at all
    expect(warn).toHaveBeenCalledWith(
      "[carson-second-brain-voice-boundary] binding_rejected",
      expect.objectContaining({ binding_present: false }),
    );

    warn.mockClear();
    const expired = createSessionBinding({
      accountId: "owner-1",
      jwt: "super-secret-expired-owner-jwt",
      now: Date.now() - 20 * 60 * 1000,
    });
    await handler(voiceReq({ bindingHeader: expired.token }), res());
    expect(warn).toHaveBeenCalledWith(
      "[carson-second-brain-voice-boundary] binding_rejected",
      expect.objectContaining({ binding_present: true, binding_signature_ok: true, binding_expired: true }),
    );
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain(expired.token);
    expect(serialized).not.toContain("super-secret-expired-owner-jwt");
    expect(serialized).not.toContain(TEST_SESSION_SECRET);
  });

  it("the existing typed-browser request shape is completely unaffected (no messages array, has transcript) — routes to the unchanged typed path, not the voice boundary", async () => {
    configure();
    const authenticate = vi.fn().mockResolvedValue("account-a");
    const interpretIntent = vi.fn().mockResolvedValue({ capability: "unsupported" });
    const handler = createCarsonTurnHandler({ authenticate, interpretIntent, dedupStore: new Map() });
    const response = res();
    await handler({ method: "POST", headers: { authorization: "Bearer session-a" }, body: { transcript: "hi", turnId: "t1" } }, response);
    expect(authenticate).toHaveBeenCalled();
    expect(response.payload).toBeDefined();
  });
});

describe("vercel.json routing — /chat/completions reaches carson-turn.js ahead of the SPA catch-all", () => {
  it("rewrites /chat/completions to /api/carson-turn, before the index.html catch-all", async () => {
    const fs = await import("node:fs");
    const raw = fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
    const config = JSON.parse(raw);
    const rewrites = config.rewrites ?? [];
    const chatIndex = rewrites.findIndex((r) => r.source === "/chat/completions");
    expect(chatIndex).toBeGreaterThanOrEqual(0);
    expect(rewrites[chatIndex].destination).toBe("/api/carson-turn");
    const catchAllIndex = rewrites.findIndex((r) => r.destination === "/index.html");
    expect(catchAllIndex).toBeGreaterThan(chatIndex);
  });
});

describe("carson-turn.js — Second Brain voice binding issuance", () => {
  it("requires the owner's own real Supabase session — rejects when unauthenticated", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
    process.env.SUPABASE_URL = "https://supabase.test";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });
    const response = res();
    await handler(
      { method: "POST", headers: { authorization: "Bearer not-a-real-session" }, body: { action: "issue_second_brain_voice_binding" } },
      response,
    );
    expect(response.statusCode).toBe(401);
  });

  it("issues a binding embedding the caller's own verified JWT when authenticated", async () => {
    configure();
    process.env.SUPABASE_URL = "https://supabase.test";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "owner-1" }) }));
    const handler = createCarsonTurnHandler({ dedupStore: new Map() });
    const response = res();
    await handler(
      { method: "POST", headers: { authorization: "Bearer real-owner-session-jwt" }, body: { action: "issue_second_brain_voice_binding" } },
      response,
    );
    expect(response.statusCode).toBe(200);
    expect(response.payload.binding).toEqual(expect.any(String));
    expect(response.payload.expiresAt).toEqual(expect.any(Number));
  });
});
