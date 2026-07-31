import { describe, expect, it, vi } from "vitest";
import { performLiveInformationLookup } from "./live-information-provider.js";

function providerResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("live information provider boundary", () => {
  it("returns verified evidence only when a web search actually occurred", async () => {
    const fetchFn = vi.fn(async () =>
      providerResponse({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: "The confirmed current result.",
            citations: [{ url: "https://example.com/current", title: "Current source" }],
          },
        ],
        usage: { server_tool_use: { web_search_requests: 1 } },
      }),
    );

    const result = await performLiveInformationLookup({
      fetchFn,
      apiKey: "test-key",
      query: "Latest result",
      capability: "live_search",
    });

    expect(result).toEqual({
      ok: true,
      answer: "The confirmed current result.",
      sources: ["https://example.com/current"],
      searches: 1,
    });
  });

  it("fails closed when the model answers without using web search", async () => {
    const fetchFn = vi.fn(async () =>
      providerResponse({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "A plausible answer from memory." }],
        usage: { server_tool_use: { web_search_requests: 0 } },
      }),
    );

    const result = await performLiveInformationLookup({
      fetchFn,
      apiKey: "test-key",
      query: "Current flight status",
      capability: "live_search",
    });

    expect(result).toEqual({
      ok: false,
      error: "the provider did not complete a live web search",
    });
  });

  it("continues a paused server-tool turn and preserves total search evidence", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        providerResponse({
          stop_reason: "pause_turn",
          content: [{ type: "server_tool_use", name: "web_search", input: {} }],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
      )
      .mockResolvedValueOnce(
        providerResponse({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Confirmed after continuation." }],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
      );

    const result = await performLiveInformationLookup({
      fetchFn,
      apiKey: "test-key",
      query: "Comprehensive latest research",
      capability: "deep_research",
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      answer: "Confirmed after continuation.",
      searches: 2,
    });
    const secondBody = JSON.parse(fetchFn.mock.calls[1][1].body);
    expect(secondBody.messages).toHaveLength(2);
    expect(secondBody.tools[0]).toMatchObject({ name: "web_search", max_uses: 5 });
  });

  it("reports provider failures without fabricating content or sources", async () => {
    const fetchFn = vi.fn(async () =>
      providerResponse({ error: { message: "search unavailable" } }, 503),
    );

    const result = await performLiveInformationLookup({
      fetchFn,
      apiKey: "test-key",
      query: "Current earthquake information",
      capability: "live_search",
    });

    expect(result).toEqual({ ok: false, error: "search unavailable" });
  });

  it("rejects unsupported capabilities before calling a provider", async () => {
    const fetchFn = vi.fn();
    const result = await performLiveInformationLookup({
      fetchFn,
      apiKey: "test-key",
      query: "Weather",
      capability: "current_weather",
    });

    expect(result).toEqual({
      ok: false,
      error: "unsupported live retrieval capability",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
