import { describe, expect, it, vi } from "vitest";
import {
  formatWebSource,
  researchWeb,
  WebIntelligenceError,
  type WebIntelligenceProvider,
  type WebIntelligenceProviderResult,
} from "./web-intelligence";

const now = new Date("2026-07-01T10:00:00Z");

function mockProvider(overrides: Partial<WebIntelligenceProvider> = {}): WebIntelligenceProvider {
  const result: WebIntelligenceProviderResult = {
    summary: "Two reliable options are available nearby.",
    findings: [
      {
        title: "Flower delivery option",
        snippet: "A local florist with same-day delivery and strong reviews.",
        url: "https://www.example.com/flowers",
        confidence: 0.88,
      },
      {
        title: "Household repair guide",
        snippet: "Official guidance for checking appliance leaks safely.",
        url: "https://support.example.org/leaks",
        confidence: 0.76,
      },
    ],
    sources: [
      {
        id: "source-flowers",
        title: "Example Flowers",
        url: "https://www.example.com/flowers",
      },
      {
        id: "source-leaks",
        title: "Example Support",
        url: "https://support.example.org/leaks",
      },
    ],
    risks: [
      {
        severity: "medium",
        message: "Check freshness and delivery window before ordering.",
        sourceId: "source-flowers",
      },
    ],
    suggestedNextSteps: [
      "Call the florist to confirm delivery timing.",
      "Compare at least one other option.",
    ],
  };
  return {
    name: "mock-search",
    search: vi.fn(async () => result),
    ...overrides,
  };
}

describe("researchWeb", () => {
  it("accepts a valid query and passes normalized options to the provider", async () => {
    const provider = mockProvider();
    await researchWeb("  nearby flower delivery  ", {
      provider,
      now,
      maxFindings: 3,
      region: "AE",
      language: "en",
      freshness: "week",
    });

    expect(provider.search).toHaveBeenCalledWith("nearby flower delivery", {
      now,
      maxFindings: 3,
      region: "AE",
      language: "en",
      freshness: "week",
    });
  });

  it("rejects an empty query", async () => {
    await expect(researchWeb("   ", { provider: mockProvider(), now })).rejects.toMatchObject({
      name: "WebIntelligenceError",
      code: "empty_query",
    });
  });

  it("returns typed findings, sources, risks, next steps, and metadata from a mock provider", async () => {
    const result = await researchWeb("compare flower delivery", {
      provider: mockProvider(),
      now,
    });

    expect(result.query).toBe("compare flower delivery");
    expect(result.summary).toBe("Two reliable options are available nearby.");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({
      id: "finding_1",
      title: "Flower delivery option",
      sourceId: "source-flowers",
      confidence: 0.88,
    });
    expect(result.sources[0]).toMatchObject({
      id: "source-flowers",
      displayUrl: "example.com",
      provider: "mock-search",
      retrievedAt: now.toISOString(),
    });
    expect(result.risks[0].severity).toBe("medium");
    expect(result.suggestedNextSteps[0]).toContain("florist");
    expect(result.metadata).toMatchObject({
      generatedAt: now.toISOString(),
      provider: "mock-search",
      readOnly: true,
      sourceCount: 2,
    });
    expect(result.metadata.requiredEnvVars).toContain("WEB_INTELLIGENCE_API_KEY");
  });

  it("throws a clear missing-provider error when no real provider is configured", async () => {
    await expect(researchWeb("current florist hours", { now })).rejects.toMatchObject({
      name: "WebIntelligenceError",
      code: "missing_provider",
    });

    try {
      await researchWeb("current florist hours", { now });
    } catch (error) {
      expect(error).toBeInstanceOf(WebIntelligenceError);
      expect((error as Error).message).toContain("WEB_INTELLIGENCE_PROVIDER");
      expect((error as Error).message).toContain("server-side search provider");
    }
  });

  it("formats sources for display", () => {
    expect(
      formatWebSource({
        title: "Example Flowers",
        url: "https://www.example.com/flowers?ref=test",
        displayUrl: "example.com",
      }),
    ).toBe("Example Flowers (example.com)");
  });

  it("falls back to a generated summary and next steps when provider returns minimal data", async () => {
    const provider = mockProvider({
      search: vi.fn(async () => ({
        findings: [
          {
            title: "One result",
            snippet: "A useful result.",
            url: "https://example.net/result",
          },
        ],
        sources: [{ title: "Example", url: "https://example.net/result" }],
      })),
    });

    const result = await researchWeb("household leak fix", { provider, now });

    expect(result.summary).toBe('Found 1 relevant web finding for "household leak fix".');
    expect(result.suggestedNextSteps).toContain("Review the sources before making a decision.");
  });

  it("wraps provider failures without leaking implementation details", async () => {
    const provider = mockProvider({
      search: vi.fn(async () => {
        throw new Error("upstream timeout");
      }),
    });

    await expect(researchWeb("compare cleaners", { provider, now })).rejects.toMatchObject({
      name: "WebIntelligenceError",
      code: "provider_failure",
      message: "Web research failed: upstream timeout",
    });
  });
});
