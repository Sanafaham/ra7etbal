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
      continuation_cycles: 0,
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
      continuation_cycles: 1,
    });
    const secondBody = JSON.parse(fetchFn.mock.calls[1][1].body);
    expect(secondBody.messages).toHaveLength(2);
    expect(secondBody.tools[0]).toMatchObject({ name: "web_search", max_uses: 5 });
  });

  it("supports multiple bounded provider continuation cycles", async () => {
    const paused = {
      stop_reason: "pause_turn",
      content: [{ type: "server_tool_use", name: "web_search", input: {} }],
      usage: { server_tool_use: { web_search_requests: 1 } },
    };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(providerResponse(paused))
      .mockResolvedValueOnce(providerResponse(paused))
      .mockResolvedValueOnce(
        providerResponse({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Confirmed after two continuations." }],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
      );

    const result = await performLiveInformationLookup({
      fetchFn,
      apiKey: "test-key",
      query: "Comprehensive current transport disruption research",
      capability: "deep_research",
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      ok: true,
      searches: 3,
      continuation_cycles: 2,
    });
    expect(JSON.parse(fetchFn.mock.calls[2][1].body).messages).toHaveLength(3);
  });

  it("fails truthfully when continuation does not complete within its bound", async () => {
    const fetchFn = vi.fn(async () =>
      providerResponse({
        stop_reason: "pause_turn",
        content: [{ type: "server_tool_use", name: "web_search", input: {} }],
        usage: { server_tool_use: { web_search_requests: 1 } },
      }),
    );

    const result = await performLiveInformationLookup({
      fetchFn,
      apiKey: "test-key",
      query: "Latest news",
      capability: "live_search",
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ok: false,
      error: "the live search did not finish within the allowed continuation limit",
    });
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
