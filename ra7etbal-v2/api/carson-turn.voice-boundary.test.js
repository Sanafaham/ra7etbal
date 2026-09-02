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

  describe("multi-turn follow-up state, derived from ElevenLabs' own replayed message history (2026-09-02 live isolated canary regression)", () => {
    // The voice boundary is stateless (fresh HTTP request per turn) — state
    // for a follow-up must come from req.body.messages, which ElevenLabs
    // replays in full on every call. These tests build that two-turn
    // messages array explicitly, the same shape a real conversation sends.
    function twoTurnMessages(firstUser, firstAssistant, secondUser) {
      return [
        { role: "user", content: firstUser },
        { role: "assistant", content: firstAssistant },
        { role: "user", content: secondUser },
      ];
    }

    it('"What about the things I\'m waiting on?" after "What needs my attention?" fetches fresh evidence and returns ONLY the waiting subset, never repeating the broad answer', async () => {
      configure();
      const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
      const evidence = {
        ok: true,
        code: "attention_read_succeeded",
        completeness: "full",
        generatedAt: new Date().toISOString(),
        needsYou: [{ id: "n1", label: "buy TEREA cigarettes", type: "delegation", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "needsYou" }],
        overdueReminders: [{ id: "o1", label: "call the doctor", type: "reminder", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "overdueReminders" }],
        upcomingReminders: [],
        waiting: [{ id: "w1", label: "Christopher: confirm delivery", type: "delegation", status: "pending", dueAt: null, dueDescription: null, assignee: "Christopher", category: "waiting" }],
        later: [],
        unresolvedCaptures: [],
      };
      const fetchAttentionEvidence = vi.fn().mockResolvedValue({
        evidence,
        text: "Needs your decision: buy TEREA cigarettes. You do have 1 overdue reminder and 1 thing you're waiting on.",
      });
      const reasonOverEvidence = vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: ["w1"] });
      const handler = createCarsonTurnHandler({
        classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
        fetchAttentionEvidence,
        reasonOverEvidence,
        dedupStore: new Map(),
      });

      const turn1 = res();
      await handler(voiceReq({ bindingHeader: token, messages: [{ role: "user", content: "What needs my attention?" }] }), turn1);
      const turn1Text = turn1.chunks.join("");

      const turn2 = res();
      await handler(
        voiceReq({
          bindingHeader: token,
          messages: twoTurnMessages("What needs my attention?", "Needs your decision: buy TEREA cigarettes...", "What about the things I'm waiting on?"),
        }),
        turn2,
      );
      const turn2Text = turn2.chunks.join("");

      // Fresh evidence fetched again for the follow-up — never reused from turn 1.
      expect(fetchAttentionEvidence).toHaveBeenCalledTimes(2);
      // The reasoning model actually ran and was given the follow-up's own text.
      expect(reasonOverEvidence).toHaveBeenCalledOnce();
      expect(reasonOverEvidence.mock.calls[0][0].userMessage).toBe("What about the things I'm waiting on?");
      // Turn 2 must not just repeat turn 1's broad answer.
      expect(turn2Text).not.toContain("buy TEREA cigarettes");
      expect(turn2Text).not.toContain("call the doctor");
      expect(turn2Text).toContain("Christopher");
      expect(turn1Text).toContain("buy TEREA cigarettes"); // sanity: turn 1 itself was the broad answer
    });

    it("a reasoning-call failure during the SAME follow-up never masquerades as the broad turn-1 answer (2026-09-02 live isolated canary regression — the exact failure mode observed live)", async () => {
      configure();
      const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
      const evidence = {
        ok: true, code: "attention_read_succeeded", completeness: "full", generatedAt: new Date().toISOString(),
        needsYou: [{ id: "n1", label: "buy TEREA cigarettes", type: "delegation", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "needsYou" }],
        overdueReminders: [1, 2, 3, 4, 5].map((i) => ({ id: `o${i}`, label: `overdue ${i}`, type: "reminder", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "overdueReminders" })),
        upcomingReminders: [], waiting: [{ id: "w1", label: "Christopher: confirm delivery", type: "delegation", status: "pending", dueAt: null, dueDescription: null, assignee: "Christopher", category: "waiting" }],
        later: [], unresolvedCaptures: [],
      };
      const handler = createCarsonTurnHandler({
        classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
        fetchAttentionEvidence: vi.fn().mockResolvedValue({
          evidence,
          text: "Needs your decision: buy TEREA cigarettes. You do have 5 overdue reminders.",
        }),
        // Simulates the real observed failure: the reasoning call throws
        // (network/timeout/provider error — whatever the exact live cause,
        // this proves the OUTCOME is safe regardless).
        reasonOverEvidence: vi.fn().mockRejectedValue(new Error("Reasoning model request failed.")),
        dedupStore: new Map(),
      });

      const response = res();
      await handler(
        voiceReq({
          bindingHeader: token,
          messages: twoTurnMessages(
            "What needs my attention?",
            "Needs your decision: buy TEREA cigarettes. You do have 5 overdue reminders.",
            "What about the things I'm waiting on?",
          ),
        }),
        response,
      );
      const streamed = response.chunks.join("");
      // Must NOT silently re-answer with the broad turn-1 content — this is
      // exactly the defect a real conversation showed: reasoning failed and
      // the fallback returned the full unfiltered summary, indistinguishable
      // from a genuine (and wrong) answer to the filtered question.
      expect(streamed).not.toContain("buy TEREA cigarettes");
      expect(streamed).not.toContain("5 overdue reminders");
      // Must fail honestly and narrowly instead.
      expect(streamed).toContain("I couldn't confirm what you're asking about specifically");
    });

    it("an empty waiting subset says so plainly, never falling back to Needs You items", async () => {
      configure();
      const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
      const evidence = {
        ok: true, code: "attention_read_succeeded", completeness: "full", generatedAt: new Date().toISOString(),
        needsYou: [{ id: "n1", label: "buy TEREA cigarettes", type: "delegation", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "needsYou" }],
        overdueReminders: [], upcomingReminders: [], waiting: [], later: [], unresolvedCaptures: [],
      };
      const handler = createCarsonTurnHandler({
        classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
        fetchAttentionEvidence: vi.fn().mockResolvedValue({ evidence, text: "broad text" }),
        reasonOverEvidence: vi.fn().mockResolvedValue({ responseIntent: "list", selectedEvidenceIds: [] }),
        dedupStore: new Map(),
      });
      const response = res();
      await handler(
        voiceReq({
          bindingHeader: token,
          messages: twoTurnMessages("What needs my attention?", "broad text", "What about the things I'm waiting on?"),
        }),
        response,
      );
      const streamed = response.chunks.join("");
      expect(streamed).not.toContain("buy TEREA cigarettes");
      expect(streamed).toContain("Nothing matches that right now");
    });

    it('"Hello" after an attention turn does not stay in the attention domain — the reasoning model classifies it not_attention and the turn falls through to the conversational fallback', async () => {
      configure();
      const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
      const reasonOverEvidence = vi.fn().mockResolvedValue({ responseIntent: "not_attention", selectedEvidenceIds: [] });
      const handler = createCarsonTurnHandler({
        classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
        interpretIntent: vi.fn().mockResolvedValue({ capability: "unsupported", range: "today" }),
        fetchAttentionEvidence: vi.fn().mockResolvedValue({
          evidence: { ok: true, code: "attention_read_succeeded", completeness: "full", generatedAt: new Date().toISOString(), needsYou: [], overdueReminders: [], upcomingReminders: [], waiting: [], later: [], unresolvedCaptures: [] },
          text: "Nothing needs your attention right now.",
        }),
        reasonOverEvidence,
        dedupStore: new Map(),
      });
      const response = res();
      await handler(
        voiceReq({
          bindingHeader: token,
          messages: twoTurnMessages("What needs my attention?", "Nothing needs your attention right now.", "Hello"),
        }),
        response,
      );
      expect(reasonOverEvidence).toHaveBeenCalledOnce();
      const streamed = response.chunks.join("");
      expect(streamed).toContain("Hi! What can I help with?");
      expect(streamed).not.toContain("I couldn't confirm that");
    });

    it("a fresh conversation with no prior user turn never carries over attention state from a different, unrelated call", async () => {
      configure();
      const { token } = createSessionBinding({ accountId: "owner-1", jwt: "j" });
      const reasonOverEvidence = vi.fn();
      const handler = createCarsonTurnHandler({
        classifyOperationalIntent: vi.fn().mockResolvedValue("not_operational"),
        interpretIntent: vi.fn().mockResolvedValue({ capability: "unsupported", range: "today" }),
        reasonOverEvidence,
        dedupStore: new Map(),
      });
      const response = res();
      // Single-message history — no predecessor turn exists in THIS call at
      // all, unlike a real second turn in the same conversation.
      await handler(voiceReq({ bindingHeader: token, messages: [{ role: "user", content: "Hello" }] }), response);
      // Never even reaches the reasoning model — admitted as ordinary
      // conversation from the very first turn, exactly as if no other
      // conversation had ever happened.
      expect(reasonOverEvidence).not.toHaveBeenCalled();
      expect(response.chunks.join("")).toContain("Hi! What can I help with?");
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
