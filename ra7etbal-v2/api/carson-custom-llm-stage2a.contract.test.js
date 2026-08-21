/**
 * Stage 2A — ElevenLabs Custom LLM wire-contract protection.
 *
 * Repo-resident version of the contract suite that was originally run
 * ad hoc against the deployed isolated endpoint during the 2026-08-20
 * boundary investigation. Those assertions proved the wire contract but
 * lived outside the repository, so nothing stopped a future change from
 * silently breaking the OpenAI Chat Completions / SSE shape that
 * ElevenLabs requires.
 *
 * Everything here runs against the real handler in-process:
 *   - no network, no deployed endpoint
 *   - no ElevenLabs conversation and therefore no credits
 *   - no real owner credentials, no production read or write
 *
 * Complements (does not duplicate) carson-custom-llm-stage2a.test.js:
 * that file protects auth/binding/retry semantics; this file protects the
 * request shape ElevenLabs actually sends and the SSE bytes it must be
 * able to parse.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionBinding, createStage2aHandler, STAGE2A_RESPONSE } from "./carson-custom-llm-stage2a.js";

const PROVIDER_SECRET = "contract-provider-secret-at-least-32-bytes";
const SESSION_SECRET = "contract-session-secret-at-least-32-bytes";
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function configure() {
  process.env.CARSON_STAGE2A_PROVIDER_SECRET = PROVIDER_SECRET;
  process.env.CARSON_STAGE2A_SESSION_SECRET = SESSION_SECRET;
}

/**
 * The request body ElevenLabs actually sends for a Chat Completions custom
 * LLM, per its documented schema: messages/model/temperature/max_tokens/
 * stream/user_id/tools plus the client-supplied `elevenlabs_extra_body`.
 * Fields we do not read must not break parsing.
 */
function elevenLabsRequestBody(binding, overrides = {}) {
  return {
    messages: [
      { role: "system", content: "system prompt" },
      { role: "assistant", content: "Boundary proof session." },
      { role: "user", content: "Hi Carson" },
    ],
    model: "carson-stage2a-fixed",
    temperature: 0.7,
    max_tokens: 500,
    stream: true,
    user_id: "elevenlabs-user",
    tools: [
      { type: "function", function: { name: "end_call", description: "End the call", parameters: { type: "object", properties: {} } } },
    ],
    ...(binding ? { elevenlabs_extra_body: { carson_stage2a_binding: binding } } : {}),
    ...overrides,
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    chunks: [],
    headers: {},
    writableEnded: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    write(value) { this.chunks.push(value); },
    end() { this.writableEnded = true; },
    on: vi.fn(),
  };
}

function request(body, authorization = `Bearer ${PROVIDER_SECRET}`) {
  return { method: "POST", body, headers: { authorization }, on: vi.fn() };
}

async function invoke(body, authorization) {
  vi.useFakeTimers();
  const res = response();
  await createStage2aHandler()(request(body, authorization), res);
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  return res;
}

function parseStream(res) {
  const raw = res.chunks.join("");
  const payloads = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  return {
    raw,
    payloads,
    done: payloads.filter((p) => p === "[DONE]"),
    objects: payloads.filter((p) => p !== "[DONE]").map((p) => JSON.parse(p)),
  };
}

describe("Stage 2A wire contract — request parsing", () => {
  it("accepts the full documented ElevenLabs request body without choking on unread fields", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const res = await invoke(elevenLabsRequestBody(token));
    expect(res.statusCode).toBe(200);
  });

  it("reads the owner turn from the last user message, ignoring system and assistant turns", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const res = await invoke(elevenLabsRequestBody(token));
    expect(parseStream(res).objects.map((c) => c.choices[0].delta.content ?? "").join("")).toBe(STAGE2A_RESPONSE);
  });

  it("reads the binding from elevenlabs_extra_body, which is where ElevenLabs places custom_llm_extra_body", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const body = elevenLabsRequestBody(null);
    body.elevenlabs_extra_body = { carson_stage2a_binding: token };
    const res = await invoke(body);
    expect(res.statusCode).toBe(200);
  });
});

describe("Stage 2A wire contract — SSE response shape", () => {
  it("sets Content-Type: text/event-stream", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const res = await invoke(elevenLabsRequestBody(token));
    expect(String(res.headers["content-type"])).toContain("text/event-stream");
  });

  it("frames every event as 'data: {json}\\n\\n'", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const { raw } = parseStream(await invoke(elevenLabsRequestBody(token)));
    expect(raw).toMatch(/data: \{.*\}\n\n/);
    for (const chunk of raw.split("\n\n").filter(Boolean)) expect(chunk.startsWith("data: ")).toBe(true);
  });

  it("terminates with exactly one data: [DONE]", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const parsed = parseStream(await invoke(elevenLabsRequestBody(token)));
    expect(parsed.done).toHaveLength(1);
    expect(parsed.raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("emits OpenAI-compatible chunk objects with a stable completion id", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const { objects } = parseStream(await invoke(elevenLabsRequestBody(token)));
    expect(objects.length).toBeGreaterThan(0);
    for (const chunk of objects) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(typeof chunk.id).toBe("string");
      expect(chunk.id.length).toBeGreaterThan(0);
      expect(Number.isInteger(chunk.created)).toBe(true);
      expect(typeof chunk.model).toBe("string");
      expect(chunk.choices[0]).toHaveProperty("delta");
    }
    expect(new Set(objects.map((c) => c.id)).size).toBe(1);
  });

  it("opens the stream with delta.role assistant and closes with exactly one finish_reason stop", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const { objects } = parseStream(await invoke(elevenLabsRequestBody(token)));
    expect(objects[0].choices[0].delta.role).toBe("assistant");
    const terminal = objects.filter((c) => c.choices[0].finish_reason);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].choices[0].finish_reason).toBe("stop");
  });

  it("returns the canonical sentence exactly, with no additional model output", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const { objects } = parseStream(await invoke(elevenLabsRequestBody(token)));
    expect(objects.map((c) => c.choices[0].delta.content ?? "").join("")).toBe("Boundary proof successful.");
  });
});

describe("Stage 2A wire contract — no tool or execution surface", () => {
  it("never emits tool_calls or function_call, even when ElevenLabs offers tools", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const { raw } = parseStream(await invoke(elevenLabsRequestBody(token)));
    expect(raw).not.toContain("tool_calls");
    expect(raw).not.toContain("function_call");
    expect(raw).not.toContain("end_call");
  });

  it("ignores a client-supplied model override and still answers canonically", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const res = await invoke(elevenLabsRequestBody(token, { model: "gpt-4o" }));
    expect(parseStream(res).objects.map((c) => c.choices[0].delta.content ?? "").join("")).toBe(STAGE2A_RESPONSE);
  });
});

describe("Stage 2A wire contract — fails closed before streaming", () => {
  it("returns 503 JSON, not a stream, when the provider secret is not configured", async () => {
    process.env.CARSON_STAGE2A_SESSION_SECRET = SESSION_SECRET;
    delete process.env.CARSON_STAGE2A_PROVIDER_SECRET;
    const res = await invoke(elevenLabsRequestBody("irrelevant"));
    expect(res.statusCode).toBe(503);
    expect(res.chunks).toEqual([]);
  });

  it("rejects a wrong provider credential with 401 and no stream", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "owner-1" }, SESSION_SECRET);
    const res = await invoke(elevenLabsRequestBody(token), "Bearer wrong-provider-secret");
    expect(res.statusCode).toBe(401);
    expect(res.chunks).toEqual([]);
  });

  it("rejects a binding signed with a different session secret", async () => {
    configure();
    const { token } = createSessionBinding({ accountId: "attacker" }, "a-different-session-secret-32-bytes+");
    const res = await invoke(elevenLabsRequestBody(token));
    expect(res.statusCode).toBe(401);
    expect(res.chunks).toEqual([]);
  });

  it("rejects a non-POST method without streaming", async () => {
    configure();
    const res = response();
    await createStage2aHandler()({ method: "GET", headers: {}, on: vi.fn() }, res);
    expect(res.statusCode).toBe(405);
    expect(res.chunks).toEqual([]);
  });
});
