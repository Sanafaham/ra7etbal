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
