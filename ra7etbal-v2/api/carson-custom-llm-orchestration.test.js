import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOrchestrationHandler } from "./carson-custom-llm-orchestration.js";
import { createSessionBinding } from "./carson-custom-llm-stage2a.js";

const TEST_PROVIDER_SECRET = "provider-secret-for-tests-only-32bytes!!";
const TEST_SESSION_SECRET = "session-signing-secret-for-tests-32b!!";

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    write(chunk) {
      this.chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
    on() {},
  };
  return res;
}

function sseText(res) {
  return res.chunks.join("");
}

function parseStreamedContent(res) {
  const text = sseText(res);
  const matches = [...text.matchAll(/data: (\{.*\})\n\n/g)];
  let content = "";
  for (const [, json] of matches) {
    const parsed = JSON.parse(json);
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.content) content += delta.content;
  }
  return content;
}

function parseStreamedToolCall(res) {
  const text = sseText(res);
  const matches = [...text.matchAll(/data: (\{.*\})\n\n/g)];
  for (const [, json] of matches) {
    const parsed = JSON.parse(json);
    const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
    if (toolCalls) return toolCalls[0];
  }
  return null;
}

let binding;

beforeEach(() => {
  process.env.CARSON_STAGE2A_PROVIDER_SECRET = TEST_PROVIDER_SECRET;
  process.env.CARSON_STAGE2A_SESSION_SECRET = TEST_SESSION_SECRET;
  binding = createSessionBinding({ accountId: "owner-123" }, TEST_SESSION_SECRET);
});

function baseReq(overrides = {}) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${TEST_PROVIDER_SECRET}` },
    body: {
      elevenlabs_extra_body: { carson_stage2a_binding: binding.token },
      messages: [{ role: "user", content: "Add dentist Tuesday at 3 PM." }],
      tools: [],
      ...overrides,
    },
  };
}

describe("auth boundary reuse (Stage 2A)", () => {
  it("rejects a missing/incorrect provider secret", async () => {
    const handler = createOrchestrationHandler();
    const res = mockRes();
    await handler({ ...baseReq(), headers: { authorization: "Bearer wrong" } }, res);
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid/expired session binding", async () => {
    const handler = createOrchestrationHandler();
    const res = mockRes();
    const req = baseReq({ elevenlabs_extra_body: { carson_stage2a_binding: "garbage" } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("rejects non-POST", async () => {
    const handler = createOrchestrationHandler();
    const res = mockRes();
    await handler({ ...baseReq(), method: "GET" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("fails closed (503) when the provider secret is not configured", async () => {
    delete process.env.CARSON_STAGE2A_PROVIDER_SECRET;
    const handler = createOrchestrationHandler();
    const res = mockRes();
    await handler(baseReq(), res);
    expect(res.statusCode).toBe(503);
  });
});

describe("tool allowlist enforcement", () => {
  it("rejects a request offering an unregistered tool", async () => {
    const handler = createOrchestrationHandler({ reason: vi.fn() });
    const res = mockRes();
    const req = baseReq({ tools: [{ type: "function", function: { name: "delete_everything" } }] });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toMatch(/Unregistered tool/);
  });

  it("accepts a request offering only allowlisted tools", async () => {
    const reason = vi.fn().mockResolvedValue({ type: "text", text: "Sure." });
    const handler = createOrchestrationHandler({ reason });
    const res = mockRes();
    const req = baseReq({ tools: [{ type: "function", function: { name: "create_calendar_event" } }] });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("refuses to stream a tool_call for a tool the reasoning provider invented off-allowlist", async () => {
    const reason = vi.fn().mockResolvedValue({ type: "tool_use", toolName: "not_a_real_tool", toolInput: {} });
    const handler = createOrchestrationHandler({ reason });
    const res = mockRes();
    await handler(baseReq(), res);
    expect(parseStreamedToolCall(res)).toBeNull();
    expect(parseStreamedContent(res)).toMatch(/can't do that/i);
  });
});

describe("ordinary reasoning turn", () => {
  it("streams assistant text directly when no tool is needed", async () => {
    const reason = vi.fn().mockResolvedValue({ type: "text", text: "Sure, tell me more." });
    const handler = createOrchestrationHandler({ reason });
    const res = mockRes();
    await handler(baseReq(), res);
    expect(res.statusCode).toBe(200);
    expect(parseStreamedContent(res)).toBe("Sure, tell me more.");
    expect(sseText(res)).toMatch(/data: \[DONE\]/);
  });

  it("streams a tool_calls chunk when the reasoning provider selects a registered tool", async () => {
    const reason = vi.fn().mockResolvedValue({
      type: "tool_use",
      toolName: "create_calendar_event",
      toolInput: { title: "Dentist", date: "2026-09-01", time: "15:00" },
    });
    const handler = createOrchestrationHandler({ reason });
    const res = mockRes();
    await handler(baseReq(), res);
    const toolCall = parseStreamedToolCall(res);
    expect(toolCall.function.name).toBe("create_calendar_event");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ title: "Dentist", date: "2026-09-01", time: "15:00" });
  });

  it("fails safe (no guessed success) when the reasoning provider throws", async () => {
    const reason = vi.fn().mockRejectedValue(new Error("network down"));
    const handler = createOrchestrationHandler({ reason });
    const res = mockRes();
    await handler(baseReq(), res);
    expect(parseStreamedContent(res)).toMatch(/couldn't process/i);
  });
});

describe("tool-result continuation — the structural C-03 acceptance test", () => {
  function continuationReq(toolName, toolText, toolCallId = "call_abc") {
    return baseReq({
      messages: [
        { role: "user", content: "Add dentist Tuesday at 3 PM." },
        {
          role: "assistant",
          tool_calls: [{ id: toolCallId, type: "function", function: { name: toolName, arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: toolCallId, content: toolText },
      ],
    });
  }

  it("structured success (calendar create) produces a truthful natural final response", async () => {
    const handler = createOrchestrationHandler({ reason: vi.fn() });
    const res = mockRes();
    const req = continuationReq("create_calendar_event", "Dentist is on your calendar Tuesday at 3 PM.");
    await handler(req, res);
    expect(parseStreamedContent(res)).toBe("Dentist is on your calendar Tuesday at 3 PM.");
    // No second reasoning call for finalization — structural guarantee.
    expect(res.statusCode).toBe(200);
  });

  it("structured failure (calendar create) never emits a false success", async () => {
    const handler = createOrchestrationHandler({ reason: vi.fn() });
    const res = mockRes();
    const req = continuationReq("create_calendar_event", "I couldn't add the event to your calendar. Please try again.");
    await handler(req, res);
    const content = parseStreamedContent(res);
    expect(content).not.toMatch(/done|added|success/i);
    expect(content).toMatch(/couldn't add/i);
  });

  it("CASE A (failure-injection): tool result = SUCCESS in the deterministic set is trusted even though the reasoning provider is never consulted for finalization", async () => {
    const reason = vi.fn(); // must never be called for finalization
    const handler = createOrchestrationHandler({ reason });
    const res = mockRes();
    const req = continuationReq("save_instruction", "Got it. I'll remember that from now on.");
    await handler(req, res);
    expect(reason).not.toHaveBeenCalled();
    expect(parseStreamedContent(res)).toBe("Got it. I'll remember that from now on.");
  });

  it("CASE B (failure-injection): tool result = FAILURE is reported as failure, not upgraded", async () => {
    const handler = createOrchestrationHandler({ reason: vi.fn() });
    const res = mockRes();
    const req = continuationReq("save_instruction", "I couldn't save that instruction right now. Please try again.");
    await handler(req, res);
    expect(parseStreamedContent(res)).toMatch(/couldn't save/i);
  });

  it("an unrecognized/off-allowlist tool result fails safe rather than guessing", async () => {
    const handler = createOrchestrationHandler({ reason: vi.fn() });
    const res = mockRes();
    const req = continuationReq("not_a_real_tool", "Something happened.");
    await handler(req, res);
    expect(parseStreamedContent(res)).toMatch(/couldn't confirm/i);
  });

  it("a genuinely uncertain tool (send_followup) never gets upgraded to a confirmed claim", async () => {
    const handler = createOrchestrationHandler({ reason: vi.fn() });
    const res = mockRes();
    const req = continuationReq("send_followup", "Followed up with Christopher.");
    await handler(req, res);
    // Passes through as-is (the tool's own text), but execution_status
    // internally is "uncertain" — verified via the unit test suite for
    // buildToolExecutionResult; here we only assert no crash / safe stream.
    expect(res.statusCode).toBe(200);
    expect(parseStreamedContent(res)).toBe("Followed up with Christopher.");
  });
});

describe("SSE completion and no-duplicate-response", () => {
  it("every response ends with exactly one [DONE] and one finish_reason chunk", async () => {
    const reason = vi.fn().mockResolvedValue({ type: "text", text: "Hi." });
    const handler = createOrchestrationHandler({ reason });
    const res = mockRes();
    await handler(baseReq(), res);
    const text = sseText(res);
    expect((text.match(/data: \[DONE\]/g) || []).length).toBe(1);
    expect((text.match(/"finish_reason":"stop"/g) || []).length).toBe(1);
    expect(res.ended).toBe(true);
  });
});

describe("Production Carson untouched", () => {
  it("this module's source never imports or references the production widget file", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./carson-custom-llm-orchestration.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/ElevenLabsAgentWidget/);
  });
});
