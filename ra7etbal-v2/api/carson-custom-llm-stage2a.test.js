import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STAGE2A_RESPONSE,
  createSessionBinding,
  createStage2aHandler,
  extractLatestOwnerMessage,
  verifySessionBinding,
} from "./carson-custom-llm-stage2a.js";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL_ENV }; vi.restoreAllMocks(); });

function request(body, authorization = "Bearer provider-secret-that-is-at-least-32-bytes") {
  return { method: "POST", body, headers: { authorization }, on: vi.fn() };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    chunks: [],
    writableEnded: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    setHeader: vi.fn(),
    write(value) { this.chunks.push(value); },
    end() { this.writableEnded = true; },
    on: vi.fn(),
  };
}

function configure() {
  process.env.CARSON_STAGE2A_SESSION_SECRET = "session-secret-that-is-at-least-32-bytes";
  process.env.CARSON_STAGE2A_PROVIDER_SECRET = "provider-secret-that-is-at-least-32-bytes";
}

describe("Stage 2A account binding", () => {
  it("issues a short-lived account-bound signed binding only after server authentication", async () => {
    configure();
    const handler = createStage2aHandler({ authenticate: vi.fn().mockResolvedValue("account-a") });
    const res = response();
    await handler(request({ action: "issue_session_binding", scenario: "fixed" }, "Bearer owner-session"), res);
    expect(res.statusCode).toBe(200);
    expect(verifySessionBinding(res.payload.binding)).toMatchObject({ sub: "account-a", sid: res.payload.sessionId, scenario: "fixed" });
    expect(res.payload.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000));
  });

  it("rejects unsigned, tampered, expired, and unauthenticated bindings", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "account-a", now: 1_000 });
    expect(verifySessionBinding(token, { now: 700_000 })).toBeNull();
    expect(verifySessionBinding(`${token}x`, { now: 1_000 })).toBeNull();
    const handler = createStage2aHandler({ authenticate: vi.fn().mockResolvedValue(null) });
    const res = response();
    await handler(request({ action: "issue_session_binding" }, "Bearer invalid-owner"), res);
    expect(res.statusCode).toBe(401);
  });
});

describe("Stage 2A Custom LLM boundary", () => {
  it("extracts the latest authoritative user message from OpenAI message content", () => {
    expect(extractLatestOwnerMessage([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: [{ type: "text", text: "latest owner turn" }] },
    ])).toBe("latest owner turn");
  });

  it("rejects a provider request before transcript processing when provider auth is wrong", async () => {
    configure();
    const res = response();
    await createStage2aHandler()(request({ messages: [{ role: "user", content: "hello" }] }, "Bearer wrong"), res);
    expect(res.statusCode).toBe(401);
    expect(res.chunks).toEqual([]);
  });

  it("rejects a valid provider with a missing or invalid account binding", async () => {
    configure();
    const res = response();
    await createStage2aHandler()(request({ messages: [{ role: "user", content: "hello" }] }), res);
    expect(res.statusCode).toBe(401);
    expect(res.chunks).toEqual([]);
  });

  it("streams exactly one fixed OpenAI-compatible answer with no model or tool call", async () => {
    vi.useFakeTimers();
    configure();
    const { token } = createSessionBinding({ accountId: "account-a" });
    const res = response();
    await createStage2aHandler()(request({
      model: "carson-stage2a-fixed",
      stream: true,
      messages: [{ role: "system", content: "ignored" }, { role: "user", content: "prove the boundary" }],
      elevenlabs_extra_body: { carson_stage2a_binding: token },
    }), res);
    await vi.runAllTimersAsync();
    const joined = res.chunks.join("");
    expect(joined.match(new RegExp(STAGE2A_RESPONSE.replace(".", "\\."), "g"))).toHaveLength(1);
    expect(joined.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(joined).not.toContain("tool_calls");
    expect(res.writableEnded).toBe(true);
    vi.useRealTimers();
  });

  it("uses one stable completion identity for a provider retry and emits no first-attempt answer", async () => {
    vi.useFakeTimers();
    configure();
    const { token } = createSessionBinding({ accountId: "account-a", scenario: "retry_once" });
    const body = {
      messages: [{ role: "user", content: "retry proof" }],
      elevenlabs_extra_body: { carson_stage2a_binding: token },
    };
    const first = response();
    const second = response();
    const handler = createStage2aHandler();
    await handler(request(body), first);
    await handler(request(body), second);
    await vi.runAllTimersAsync();
    expect(first.statusCode).toBe(503);
    expect(first.chunks).toEqual([]);
    expect(second.chunks.join("")).toContain(STAGE2A_RESPONSE);
    vi.useRealTimers();
  });
});
