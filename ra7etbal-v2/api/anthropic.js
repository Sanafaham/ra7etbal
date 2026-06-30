export default async function handler(req, res) {
  if (isWebResearchRequest(req)) {
    return handleWebResearch(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Key is stored in Vercel environment variables -- never hardcoded
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal,
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Anthropic request timed out. Please try again.' });
    }
    return res.status(500).json({ error: 'Anthropic request failed. Please try again.' });
  } finally {
    clearTimeout(timeout);
  }
}

const SUPPORTED_WEB_RESEARCH_PROVIDER = "tavily";
const DEFAULT_TAVILY_ENDPOINT = "https://api.tavily.com/search";
const WEB_RESEARCH_REQUIRED_ENV_VARS = [
  "WEB_INTELLIGENCE_PROVIDER",
  "WEB_INTELLIGENCE_API_KEY",
  "WEB_INTELLIGENCE_ENDPOINT",
];

function isWebResearchRequest(req) {
  return req.query?.webResearch === "1" || req.url?.includes("webResearch=1");
}

async function handleWebResearch(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      code: "method_not_allowed",
      error: "Method not allowed.",
    });
  }

  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    return res.status(400).json({
      ok: false,
      code: "empty_query",
      error: "Research query cannot be empty.",
    });
  }

  const provider = (process.env.WEB_INTELLIGENCE_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) {
    return res.status(500).json({
      ok: false,
      code: "missing_provider",
      error: "Web Intelligence provider is not configured.",
      requiredEnvVars: WEB_RESEARCH_REQUIRED_ENV_VARS,
    });
  }

  if (provider !== SUPPORTED_WEB_RESEARCH_PROVIDER) {
    return res.status(500).json({
      ok: false,
      code: "missing_provider",
      error: `Unsupported Web Intelligence provider: ${provider}.`,
      requiredEnvVars: WEB_RESEARCH_REQUIRED_ENV_VARS,
    });
  }

  const apiKey = (process.env.WEB_INTELLIGENCE_API_KEY ?? "").trim();
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      code: "missing_api_key",
      error: "Web Intelligence API key is not configured.",
      requiredEnvVars: WEB_RESEARCH_REQUIRED_ENV_VARS,
    });
  }

  try {
    const result = await searchTavily({
      apiKey,
      endpoint: (process.env.WEB_INTELLIGENCE_ENDPOINT ?? DEFAULT_TAVILY_ENDPOINT).trim() || DEFAULT_TAVILY_ENDPOINT,
      query,
      maxFindings: clampMaxFindings(req.body?.maxFindings),
      freshness: req.body?.freshness,
    });

    return res.status(200).json({
      ok: true,
      ...result,
      metadata: {
        provider,
        readOnly: true,
        generatedAt: new Date().toISOString(),
        requiredEnvVars: WEB_RESEARCH_REQUIRED_ENV_VARS,
      },
    });
  } catch (error) {
    console.error("[web-research] provider error:", error?.message);
    return res.status(502).json({
      ok: false,
      code: "provider_error",
      error: "Web research provider failed.",
    });
  }
}

export async function searchTavily({ apiKey, endpoint, query, maxFindings, freshness }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: true,
      include_raw_content: false,
      max_results: maxFindings,
      ...(toTavilyTimeRange(freshness) ? { time_range: toTavilyTimeRange(freshness) } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily request failed with status ${response.status}.`);
  }

  const data = await response.json().catch(() => null);
  return normalizeTavilyResult(data, maxFindings);
}

export function normalizeTavilyResult(data, maxFindings = 5) {
  const results = Array.isArray(data?.results) ? data.results.slice(0, maxFindings) : [];
  const sources = results
    .filter((item) => typeof item?.url === "string" && item.url.trim())
    .map((item, index) => ({
      id: `source_${index + 1}`,
      title: cleanText(item.title) || displayUrl(item.url),
      url: item.url.trim(),
      provider: SUPPORTED_WEB_RESEARCH_PROVIDER,
    }));
  const sourceIdByUrl = new Map(sources.map((source) => [source.url, source.id]));

  const findings = results
    .filter((item) => cleanText(item?.title) || cleanText(item?.content))
    .map((item) => {
      const url = typeof item?.url === "string" ? item.url.trim() : "";
      return {
        title: cleanText(item?.title) || "Untitled result",
        snippet: cleanText(item?.content),
        url: url || null,
        sourceId: url ? sourceIdByUrl.get(url) ?? null : null,
        publishedAt: cleanText(item?.published_date) || null,
        confidence: normalizeScore(item?.score),
      };
    });

  return {
    summary: cleanText(data?.answer) || undefined,
    findings,
    sources,
    risks: [],
    suggestedNextSteps:
      findings.length > 0
        ? ["Review the sources before making a decision.", "Compare the strongest options."]
        : ["Try a more specific search query."],
  };
}

function clampMaxFindings(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 5;
  return Math.max(1, Math.min(10, Math.floor(numeric)));
}

function toTavilyTimeRange(freshness) {
  if (freshness === "day" || freshness === "week" || freshness === "month") return freshness;
  return null;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeScore(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(1, numeric));
}

function displayUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return cleanText(url);
  }
}
