export type InformationSource = "known" | "ra7etbal" | "live";
export type LiveInformationCapability =
  | "current_weather"
  | "live_search"
  | "deep_research";

export interface LiveInformationDecision {
  source: InformationSource;
  capability: LiveInformationCapability | null;
  reason: string;
}

export interface LiveInformationRequest {
  query: string;
  capability?: LiveInformationCapability | null;
  location?: string | null;
}

const STORED_INFORMATION_PATTERNS = [
  /\b(?:my|our)\s+(?:tasks?|reminders?|calendar|schedule|notes?|todos?|to-dos?)\b/i,
  /\b(?:what|which)\s+(?:tasks?|reminders?|notes?|todos?|to-dos?)\s+do\s+i\s+have\b/i,
  /\bwhat\s+(?:am\s+i|are\s+we)\s+waiting\s+(?:for|on)\b/i,
  /\bwhat\s+(?:needs?|requires?)\s+my\s+attention\b/i,
  /\b(?:did|has|have)\s+\w+\s+(?:confirm|complete|finish|reply)\b/i,
  /\b(?:in|inside|from)\s+ra7etbal\b/i,
  /\bwhat\s+do\s+you\s+(?:remember|know)\s+about\s+(?:me|my|our)\b/i,
];

const LIVE_INFORMATION_PATTERNS = [
  /\bweather\b|\bforecast\b|\btemperature\b/i,
  /\bnews\b|\bheadlines?\b|\bbreaking\b/i,
  /\bflight\b.*\b(?:status|delayed?|delay|arrival|departure)\b|\bairport\s+delays?\b/i,
  /\btraffic\b|\btravel\s+time\b|\broad\s+closure\b/i,
  /\bexchange\s+rate\b|\bcurrency\s+(?:rate|conversion)\b/i,
  /\bstock\s+(?:price|quote|market)\b|\bshare\s+price\b/i,
  /\bcrypto(?:currency)?\s+(?:price|market)\b|\bbitcoin\s+price\b/i,
  /\bearthquakes?\b|\bwildfires?\b|\bfires?\b|\bfloods?\b|\bair\s+quality\b/i,
  /\bopening\s+hours?\b|\bbusiness\s+hours?\b|\bopen\s+(?:now|today|tomorrow)\b/i,
  /\bpublic\s+holidays?\b|\bbank\s+holidays?\b/i,
  /\brestaurants?\b|\bhotels?\b|\bmovie\s+showtimes?\b/i,
  /\bshipping\s+status\b|\bpackage\s+tracking\b|\btrack\s+(?:my\s+)?package\b/i,
  /\bsports?\s+(?:score|result|schedule)\b|\bleague\s+standings?\b|\bscore\s+of\b/i,
  /\belection\s+(?:result|count|poll)\b|\bgovernment\s+announcement\b/i,
  /\bvisa\s+(?:rule|requirement|information)\b|\btravel\s+advisory\b/i,
  /\b(?:ferry|train|bus)\s+(?:schedule|status|times?)\b/i,
  /\bfuel\s+prices?\b|\bconcert\s+schedule\b|\blocal\s+events?\b/i,
  /\bproduct\s+(?:availability|recall)\b|\bin\s+stock\b/i,
  /\btechnology\s+releases?\b|\bsoftware\s+(?:version|release)\b/i,
  /\bcompany\s+(?:news|status|announcement|information)\b/i,
  /\bscientific\s+(?:discovery|breakthrough|news)\b/i,
  /\bcurrent\s+(?:medical|health)\s+(?:guidance|recommendation|advice)\b/i,
  /\b(?:latest|current|today(?:'s)?|right\s+now|as\s+of\s+now|this\s+week)\b/i,
];

const DEEP_RESEARCH_PATTERNS = [
  /\bdeep\s+research\b/i,
  /\bin[-\s]?depth\b/i,
  /\bcomprehensive(?:ly)?\b/i,
  /\bacross\s+multiple\s+sources\b/i,
  /\bdetailed\s+research\b/i,
];

export function decideInformationSource(query: string): LiveInformationDecision {
  const text = query.trim();
  if (!text) {
    return {
      source: "known",
      capability: null,
      reason: "No factual request was supplied.",
    };
  }

  if (STORED_INFORMATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      source: "ra7etbal",
      capability: null,
      reason: "The request targets owner or Ra7etBal state.",
    };
  }

  if (LIVE_INFORMATION_PATTERNS.some((pattern) => pattern.test(text))) {
    const capability: LiveInformationCapability =
      /\bweather\b|\bforecast\b|\btemperature\b/i.test(text)
        ? "current_weather"
        : DEEP_RESEARCH_PATTERNS.some((pattern) => pattern.test(text))
          ? "deep_research"
          : "live_search";
    return {
      source: "live",
      capability,
      reason: "Fresh external information materially affects correctness.",
    };
  }

  return {
    source: "known",
    capability: null,
    reason: "The request can be answered from stable general knowledge.",
  };
}

export function extractRequestedWeatherLocation(query: string): string | null {
  const match = query.match(
    /\b(?:weather|forecast|temperature)\s+(?:in|for|at)\s+(.+?)(?:[?.!]|$)/i,
  );
  if (!match?.[1]) return null;
  const location = match[1]
    .replace(/\b(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening|week))\b.*$/i, "")
    .trim()
    .replace(/[,;:]$/, "")
    .trim();
  return location || null;
}

export async function retrieveLiveInformation(
  request: LiveInformationRequest,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const query = request.query.trim();
  if (!query) {
    return "LIVE_LOOKUP_FAILED: No information request was supplied.";
  }

  const decision = decideInformationSource(query);
  if (decision.source !== "live" || !decision.capability) {
    return `LIVE_LOOKUP_NOT_REQUIRED: ${decision.reason}`;
  }

  // The deterministic decision layer chooses the smallest sufficient
  // capability. A model may request a broader capability, but cannot upgrade
  // a weather lookup to deep research or downgrade deep research to a simple
  // search.
  const capability = decision.capability;

  if (capability === "current_weather") {
    const location =
      extractRequestedWeatherLocation(query) || request.location?.trim();
    if (!location) {
      return "LIVE_LOOKUP_NEEDS_CLARIFICATION: Which city or location should I check?";
    }

    try {
      const response = await fetchFn(`/api/weather?city=${encodeURIComponent(location)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || !data?.spoken) {
        const reason = data?.error || `weather service returned ${response.status}`;
        return `LIVE_LOOKUP_FAILED: I attempted current weather for ${location}, but ${reason}.`;
      }
      return `LIVE_LOOKUP_SUCCEEDED\nCapability: current_weather\nLocation: ${location}\nAnswer: ${String(data.spoken).trim()}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the weather service was unavailable";
      return `LIVE_LOOKUP_FAILED: I attempted current weather for ${location}, but ${reason}.`;
    }
  }

  try {
    const response = await fetchFn("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ra7etbal_mode: "live_information",
        query,
        capability,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || !data?.answer) {
      const reason = data?.error || `live retrieval returned ${response.status}`;
      return `LIVE_LOOKUP_FAILED: I attempted ${capability} for "${query}", but ${reason}.`;
    }

    const sources = Array.isArray(data.sources)
      ? data.sources.filter((value: unknown): value is string => typeof value === "string")
      : [];
    return [
      "LIVE_LOOKUP_SUCCEEDED",
      `Capability: ${capability}`,
      `Answer: ${String(data.answer).trim()}`,
      sources.length > 0 ? `Sources: ${sources.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "the live retrieval service was unavailable";
    return `LIVE_LOOKUP_FAILED: I attempted ${capability} for "${query}", but ${reason}.`;
  }
}
