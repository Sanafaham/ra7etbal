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
  authorizationToken?: string | null;
}

const STORED_INFORMATION_PATTERNS = [
  /\b(?:my|our)\s+(?:tasks?|reminders?|calendar|schedule|notes?|todos?|to-dos?)\b/i,
  /\bwhat(?:'s|\s+is)\s+(?:on|in)\s+(?:my|our)\s+(?:calendar|schedule)\b/i,
  /\bwhat\s+do\s+i\s+need\s+to\s+(?:do|handle)\b/i,
  /\b(?:anything|what)\s+(?:i|we)\s+need\s+to\s+(?:do|handle)\b/i,
  /\bwhat(?:'s|\s+is)\s+on\s+(?:today|tomorrow|this\s+week)\b/i,
  /\b(?:what|which)\s+(?:tasks?|reminders?|notes?|todos?|to-dos?)\s+do\s+i\s+have\b/i,
  /\bwhat\s+(?:am\s+i|are\s+we)\s+waiting\s+(?:for|on)\b/i,
  /\bwhat\s+(?:needs?|requires?)\s+my\s+attention\b/i,
  /\b(?:did|has|have)\s+\w+\s+(?:confirm(?:ed)?|complete(?:d)?|finish(?:ed)?|repl(?:y|ied))\b/i,
  /\b(?:in|inside|from)\s+ra7etbal\b/i,
  /\bwhat\s+do\s+you\s+(?:remember|know)\s+about\s+(?:me|my|our)\b/i,
];

const LIVE_INFORMATION_PATTERNS = [
  /\bweather\b|\bforecast\b|\btemperature\b/i,
  /\bnews\b|\bheadlines?\b|\bbreaking\b/i,
  /\bflight\b.*\b(?:status|delayed?|delay|arrival|departure)\b|\b(?:delayed?|delay|arrival|departure)\b.*\bflight\b|\b[A-Z]{2}\s?\d{2,4}\b.*\b(?:delayed?|on\s+time|land|arriv|depart)\w*\b|\bairport\s+delays?\b/i,
  /\btraffic\b|\btravel\s+time\b|\broad\s+closure\b/i,
  /\bexchange\s+rate\b|\bcurrency\s+(?:rate|conversion)\b|\bhow\s+much\s+is\s+(?:one|\d+(?:\.\d+)?)\s+\w+\s+in\s+\w+\b|\b[A-Z]{3}\s+(?:to|in)\s+[A-Z]{3}\b/i,
  /\bstock\s+(?:price|quote|market)\b|\bshare\s+price\b/i,
  /\bcrypto(?:currency)?\s+(?:price|market)\b|\bbitcoin\s+price\b/i,
  /\bearthquakes?\b|\bwildfires?\b|\bfires?\b|\bfloods?\b|\bair\s+quality\b/i,
  /\bopening\s+hours?\b|\bbusiness\s+hours?\b|\b(?:open|close[sd]?)\s+(?:now|today|tomorrow|at|when)\b|\bwhen\s+does\s+.+\s+(?:open|close)\b/i,
  /\bpublic\s+holidays?\b|\bbank\s+holidays?\b/i,
  /\brestaurants?\b|\bhotels?\b|\bmovie\s+showtimes?\b/i,
  /\bshipping\s+status\b|\bpackage\s+tracking\b|\btrack\s+(?:my\s+)?package\b/i,
  /\bsports?\s+(?:score|result|schedule)\b|\bleague\s+standings?\b|\bscore\s+(?:of\b|today\b)|\bscore\b.*\b(?:today|tonight|yesterday)\b/i,
  /\belection\s+(?:result|count|poll)\b|\bgovernment\s+announcement\b/i,
  /\bvisa\s+(?:rule|requirement|information)\b|\b(?:need|require)\s+(?:a\s+)?visa\b|\btravel\s+advisory\b/i,
  /\b(?:ferry|train|bus)\s+(?:schedule|status|times?)\b|\bwhen\s+is\s+(?:the\s+)?next\s+(?:ferry|train|bus)\b/i,
  /\bfuel\s+prices?\b|\bconcert\s+schedule\b|\blocal\s+events?\b/i,
  /\bproduct\s+(?:availability|recall)\b|\bin\s+stock\b/i,
  /\btechnology\s+releases?\b|\bsoftware\s+(?:version|release)\b|\bwhat\s+version\s+of\s+\S+\s+(?:is\s+)?(?:available|current|latest)\b/i,
  /\bcompany\s+(?:news|status|announcement|information)\b/i,
  /\bscientific\s+(?:discovery|breakthrough|news)\b/i,
  /\bcurrent\s+(?:medical|health)\s+(?:guidance|recommendation|advice)\b/i,
];

const CURRENT_WEATHER_PATTERNS = [
  /\bcurrent(?:ly)?\b/i,
  /\bright\s+now\b/i,
  /\bnow\b/i,
  /\btoday\b/i,
  /\btonight\b/i,
  /\bthis\s+(?:morning|afternoon|evening)\b/i,
  /\btemperature\b/i,
];

const FUTURE_WEATHER_PATTERNS = [
  /\btomorrow\b/i,
  /\bday\s+after\s+tomorrow\b/i,
  /\bthis\s+week(?:end)?\b/i,
  /\bnext\s+(?:week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bin\s+\d+\s+days?\b/i,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
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

  const requestsDeepResearch = DEEP_RESEARCH_PATTERNS.some((pattern) => pattern.test(text));
  if (
    LIVE_INFORMATION_PATTERNS.some((pattern) => pattern.test(text)) ||
    requestsDeepResearch
  ) {
    const isWeather = /\bweather\b|\bforecast\b|\btemperature\b/i.test(text);
    const isFutureWeather =
      isWeather && FUTURE_WEATHER_PATTERNS.some((pattern) => pattern.test(text));
    const capability: LiveInformationCapability =
      isWeather && !isFutureWeather &&
      (CURRENT_WEATHER_PATTERNS.some((pattern) => pattern.test(text)) ||
        !/\bforecast\b/i.test(text))
        ? "current_weather"
        : requestsDeepResearch
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
      const response = await fetchWithTimeout(
        fetchFn,
        `/api/weather?city=${encodeURIComponent(location)}`,
        undefined,
      );
      const data = await response.json().catch(() => null);
      if (data?.code === "ambiguous_location") {
        const options = Array.isArray(data?.candidates)
          ? data.candidates.filter((value: unknown): value is string => typeof value === "string")
          : [];
        return `LIVE_LOOKUP_NEEDS_CLARIFICATION: Which ${location} do you mean${options.length ? `: ${options.join("; ")}` : ""}?`;
      }
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
    const response = await fetchWithTimeout(fetchFn, "/api/anthropic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(request.authorizationToken
          ? { Authorization: `Bearer ${request.authorizationToken}` }
          : {}),
      },
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

const BROWSER_LIVE_LOOKUP_TIMEOUT_MS = 27_000;

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BROWSER_LIVE_LOOKUP_TIMEOUT_MS);
  try {
    return await fetchFn(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
