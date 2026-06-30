import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { normalizeTavilyResult, searchTavily } from "./anthropic.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockReq({ method = "POST", body = {} } = {}) {
  return { method, body, query: { webResearch: "1" }, url: "/api/anthropic?webResearch=1" };
}

function mockRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function tavilyResponse() {
  return {
    answer: "Two current options are available.",
    results: [
      {
        title: "Option A",
        url: "https://www.example.com/a",
        content: "A useful option with current details.",
        score: 0.91,
        published_date: "2026-07-01",
      },
      {
        title: "Option B",
        url: "https://example.org/b",
        content: "Another useful option.",
        score: 1.7,
      },
    ],
  };
}

describe("api/web-research", () => {
  it("rejects empty queries before contacting the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(mockReq({ body: { query: "   " } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({
      ok: false,
      code: "empty_query",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a clear missing-provider error", async () => {
    delete process.env.WEB_INTELLIGENCE_PROVIDER;
    process.env.WEB_INTELLIGENCE_API_KEY = "test-secret";
    const res = mockRes();

    await handler(mockReq({ body: { query: "find nearby cleaners" } }), res);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({
      ok: false,
      code: "missing_provider",
    });
    expect(JSON.stringify(res.payload)).not.toContain("test-secret");
  });

  it("returns a clear missing-api-key error without leaking secrets", async () => {
    process.env.WEB_INTELLIGENCE_PROVIDER = "tavily";
    delete process.env.WEB_INTELLIGENCE_API_KEY;
    const res = mockRes();

    await handler(mockReq({ body: { query: "compare flower delivery" } }), res);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({
      ok: false,
      code: "missing_api_key",
    });
    expect(JSON.stringify(res.payload)).not.toContain("test-secret");
  });

  it("calls Tavily and normalizes successful results", async () => {
    process.env.WEB_INTELLIGENCE_PROVIDER = "tavily";
    process.env.WEB_INTELLIGENCE_API_KEY = "test-secret";
    process.env.WEB_INTELLIGENCE_ENDPOINT = "https://api.tavily.com/search";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => tavilyResponse(),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const res = mockRes();

    await handler(
      mockReq({
        body: {
          query: "compare flower delivery",
          maxFindings: 2,
          freshness: "week",
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      summary: "Two current options are available.",
      metadata: {
        provider: "tavily",
        readOnly: true,
      },
    });
    expect(res.payload.findings[0]).toMatchObject({
      title: "Option A",
      snippet: "A useful option with current details.",
      sourceId: "source_1",
      confidence: 0.91,
    });
    expect(res.payload.findings[1].confidence).toBe(1);
    expect(res.payload.sources[0]).toMatchObject({
      id: "source_1",
      title: "Option A",
      url: "https://www.example.com/a",
      provider: "tavily",
    });
    expect(JSON.stringify(res.payload)).not.toContain("test-secret");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      query: "compare flower delivery",
      search_depth: "basic",
      include_answer: true,
      include_raw_content: false,
      max_results: 2,
      time_range: "week",
    });
  });

  it("returns provider errors without exposing the API key", async () => {
    process.env.WEB_INTELLIGENCE_PROVIDER = "tavily";
    process.env.WEB_INTELLIGENCE_API_KEY = "test-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: "upstream unavailable" }),
      })),
    );
    const res = mockRes();

    await handler(mockReq({ body: { query: "current restaurant hours" } }), res);

    expect(res.statusCode).toBe(502);
    expect(res.payload).toMatchObject({
      ok: false,
      code: "provider_error",
      error: "Web research provider failed.",
    });
    expect(JSON.stringify(res.payload)).not.toContain("test-secret");
  });

  it("normalizes Tavily sources into the Web Intelligence shape", () => {
    const result = normalizeTavilyResult(tavilyResponse(), 1);

    expect(result.findings).toHaveLength(1);
    expect(result.sources).toEqual([
      {
        id: "source_1",
        title: "Option A",
        url: "https://www.example.com/a",
        provider: "tavily",
      },
    ]);
    expect(result.findings[0]).toMatchObject({
      sourceId: "source_1",
      publishedAt: "2026-07-01",
    });
  });

  it("keeps API credentials server-side inside the provider call", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => tavilyResponse(),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await searchTavily({
      apiKey: "server-only-key",
      endpoint: "https://api.tavily.com/search",
      query: "find a plumber",
      maxFindings: 3,
      freshness: "month",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1];
    expect(request.headers.Authorization).toBe("Bearer server-only-key");
    expect(JSON.parse(request.body)).toMatchObject({
      api_key: "server-only-key",
      query: "find a plumber",
      time_range: "month",
    });
  });
});
