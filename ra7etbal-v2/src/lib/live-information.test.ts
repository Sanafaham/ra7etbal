import { describe, expect, it, vi } from "vitest";
import {
  decideInformationSource,
  extractRequestedWeatherLocation,
  retrieveLiveInformation,
} from "./live-information";

describe("Carson live information decision layer", () => {
  it.each([
    ["What's the weather in Hamburg?", "current_weather"],
    ["What is the latest news from Lebanon?", "live_search"],
    ["What's the USD to AED exchange rate?", "live_search"],
    ["Is flight TK1984 delayed?", "live_search"],
    ["How is traffic from Fethiye to Dalaman Airport?", "live_search"],
    ["Are there active fires near Izmir?", "live_search"],
    ["Was there an earthquake in Japan today?", "live_search"],
    ["What time does Harrods open today?", "live_search"],
    ["When does Harrods close?", "live_search"],
    ["How much is one euro in Turkish lira?", "live_search"],
    ["Do I need a visa for Turkey?", "live_search"],
    ["When is the next ferry?", "live_search"],
    ["What version of React is available?", "live_search"],
    ["What was the Galatasaray score today?", "live_search"],
    ["Is tomorrow a public holiday in Turkey?", "live_search"],
  ])("routes %s to the smallest live capability", (query, capability) => {
    expect(decideInformationSource(query)).toMatchObject({
      source: "live",
      capability,
    });
  });

  it.each([
    "What is photosynthesis?",
    "Explain how compound interest works.",
    "How do I boil an egg?",
  ])("keeps timeless knowledge out of live retrieval: %s", (query) => {
    expect(decideInformationSource(query)).toMatchObject({
      source: "known",
      capability: null,
    });
  });

  it.each([
    "What's on my calendar tomorrow?",
    "What reminders do I have today?",
    "What am I waiting on?",
    "Did Christopher confirm dinner?",
    "Has Christopher confirmed dinner?",
    "What do I need to do today?",
    "What is on today?",
    "Anything I need to handle this week?",
    "What do you remember about my preferences?",
  ])("keeps stored owner information in Ra7etBal: %s", (query) => {
    expect(decideInformationSource(query)).toMatchObject({
      source: "ra7etbal",
      capability: null,
    });
  });

  it("uses deep research only when the user explicitly asks for depth", () => {
    expect(
      decideInformationSource(
        "Do comprehensive research across multiple sources on the latest airline disruptions.",
      ),
    ).toMatchObject({ source: "live", capability: "deep_research" });
  });

  it.each([
    ["What's the weather in Hamburg?", "current_weather"],
    ["What's the temperature in Hamburg tomorrow?", "live_search"],
    ["Forecast for Tokyo tomorrow", "live_search"],
    ["What is the forecast for Tokyo next week?", "live_search"],
  ])("distinguishes current conditions from future forecasts: %s", (query, capability) => {
    expect(decideInformationSource(query)).toMatchObject({ source: "live", capability });
  });

  it.each([
    ["What's the weather in Hamburg?", "Hamburg"],
    ["Forecast for Tokyo tomorrow", "Tokyo"],
    ["Temperature at New York tonight", "New York"],
    ["What's the weather in São Paulo this week?", "São Paulo"],
  ])("extracts the requested international location: %s", (query, location) => {
    expect(extractRequestedWeatherLocation(query)).toBe(location);
  });

  it("never replaces an explicit requested city with a supplied owner location", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, spoken: "Hamburg is 18°C." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await retrieveLiveInformation(
      {
        query: "What's the weather in Hamburg?",
        capability: "current_weather",
        location: "Fethiye",
      },
      fetchFn as typeof fetch,
    );

    expect(fetchFn).toHaveBeenCalledWith(
      "/api/weather?city=Hamburg",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain("Location: Hamburg");
  });

  it("asks one concise clarification when a weather location is missing", async () => {
    const fetchFn = vi.fn();
    const result = await retrieveLiveInformation(
      { query: "What's the weather?", capability: "current_weather" },
      fetchFn as typeof fetch,
    );

    expect(result).toBe(
      "LIVE_LOOKUP_NEEDS_CLARIFICATION: Which city or location should I check?",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not retrieve timeless or stored information even if the model asks for live search", async () => {
    const fetchFn = vi.fn();

    await expect(
      retrieveLiveInformation(
        { query: "What is photosynthesis?", capability: "deep_research" },
        fetchFn as typeof fetch,
      ),
    ).resolves.toContain("LIVE_LOOKUP_NOT_REQUIRED");
    await expect(
      retrieveLiveInformation(
        { query: "What's on my calendar tomorrow?", capability: "live_search" },
        fetchFn as typeof fetch,
      ),
    ).resolves.toContain("LIVE_LOOKUP_NOT_REQUIRED");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("downgrades an unnecessarily broad request to the smallest capability", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, spoken: "Tokyo is 24°C." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await retrieveLiveInformation(
      {
        query: "What's the weather in Tokyo?",
        capability: "deep_research",
      },
      fetchFn as typeof fetch,
    );

    expect(result).toContain("Capability: current_weather");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reports retrieval failures truthfully without inventing an answer", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "provider unavailable" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await retrieveLiveInformation(
      { query: "What is the latest news from Lebanon?" },
      fetchFn as typeof fetch,
    );

    expect(result).toContain("LIVE_LOOKUP_FAILED");
    expect(result).toContain("attempted live_search");
    expect(result).toContain("provider unavailable");
    expect(result).not.toContain("LIVE_LOOKUP_SUCCEEDED");
  });

  it("returns provider location ambiguity as one clarification instead of guessing", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          code: "ambiguous_location",
          candidates: ["Cambridge, England, United Kingdom", "Cambridge, Massachusetts, United States"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      retrieveLiveInformation({ query: "What's the weather in Cambridge?" }, fetchFn as typeof fetch),
    ).resolves.toContain("Which Cambridge do you mean");
  });
});
