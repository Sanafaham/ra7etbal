import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./anthropic.js";

function responseRecorder() {
  const state = { status: null, body: null };
  return {
    state,
    res: {
      status(code) {
        state.status = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    },
  };
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LIVE_INFORMATION_MODEL;
  vi.unstubAllGlobals();
});

describe("/api/anthropic live-information opt-in branch", () => {
  it("performs verified live search only for the explicit internal mode", async () => {
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Current verified answer." }],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { state, res } = responseRecorder();

    await handler(
      {
        method: "POST",
        body: {
          ra7etbal_mode: "live_information",
          query: "Latest airline status",
          capability: "live_search",
        },
      },
      res,
    );

    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      answer: "Current verified answer.",
      searches: 1,
    });
    const providerBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(providerBody.tools[0]).toMatchObject({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 2,
    });
  });

  it("preserves the existing proxy behavior for every ordinary Anthropic request", async () => {
    const ordinaryBody = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: "Stable question" }],
    };
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "Answer" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { state, res } = responseRecorder();

    await handler({ method: "POST", body: ordinaryBody }, res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({ content: [{ type: "text", text: "Answer" }] });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(ordinaryBody);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty("tools");
  });

  it("returns a failed operation when no web search was completed", async () => {
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Unverified model memory." }],
          usage: { server_tool_use: { web_search_requests: 0 } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { state, res } = responseRecorder();

    await handler(
      {
        method: "POST",
        body: {
          ra7etbal_mode: "live_information",
          query: "Current exchange rate",
          capability: "live_search",
        },
      },
      res,
    );

    expect(state.status).toBe(502);
    expect(state.body).toEqual({
      ok: false,
      error: "the provider did not complete a live web search",
    });
  });
});
