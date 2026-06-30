export type WebIntelligenceRiskSeverity = "low" | "medium" | "high";

export interface WebIntelligenceOptions {
  provider?: WebIntelligenceProvider;
  now?: Date;
  maxFindings?: number;
  region?: string;
  language?: string;
  freshness?: "any" | "day" | "week" | "month";
}

export interface WebIntelligenceProviderOptions {
  now: Date;
  maxFindings: number;
  region?: string;
  language?: string;
  freshness?: WebIntelligenceOptions["freshness"];
}

export interface WebIntelligenceProvider {
  name: string;
  search(query: string, options: WebIntelligenceProviderOptions): Promise<WebIntelligenceProviderResult>;
}

export interface WebIntelligenceProviderResult {
  summary?: string;
  findings: WebIntelligenceFindingInput[];
  sources?: WebIntelligenceSourceInput[];
  risks?: WebIntelligenceRiskInput[];
  suggestedNextSteps?: string[];
}

export interface WebIntelligenceFindingInput {
  title: string;
  snippet: string;
  url?: string | null;
  sourceId?: string | null;
  publishedAt?: string | null;
  confidence?: number | null;
}

export interface WebIntelligenceSourceInput {
  id?: string;
  title: string;
  url: string;
  provider?: string;
  retrievedAt?: string;
}

export interface WebIntelligenceRiskInput {
  severity: WebIntelligenceRiskSeverity;
  message: string;
  sourceId?: string | null;
}

export interface WebIntelligenceFinding {
  id: string;
  title: string;
  snippet: string;
  url: string | null;
  sourceId: string | null;
  publishedAt: string | null;
  confidence: number | null;
}

export interface WebIntelligenceSource {
  id: string;
  title: string;
  url: string;
  displayUrl: string;
  provider: string;
  retrievedAt: string;
}

export interface WebIntelligenceRisk {
  severity: WebIntelligenceRiskSeverity;
  message: string;
  sourceId: string | null;
}

export interface WebIntelligenceResult {
  query: string;
  summary: string;
  findings: WebIntelligenceFinding[];
  sources: WebIntelligenceSource[];
  risks: WebIntelligenceRisk[];
  suggestedNextSteps: string[];
  metadata: {
    generatedAt: string;
    provider: string;
    readOnly: true;
    maxFindings: number;
    sourceCount: number;
    requiredEnvVars: string[];
  };
}

export type WebIntelligenceErrorCode =
  | "empty_query"
  | "missing_provider"
  | "provider_failure";

export class WebIntelligenceError extends Error {
  code: WebIntelligenceErrorCode;

  constructor(code: WebIntelligenceErrorCode, message: string) {
    super(message);
    this.name = "WebIntelligenceError";
    this.code = code;
  }
}

/**
 * Required env vars for a future real provider. This module intentionally does
 * not read or expose secrets client-side; a real provider should be wired
 * through a server-owned route or server-only runtime first.
 */
export const WEB_INTELLIGENCE_REQUIRED_ENV_VARS = [
  "WEB_INTELLIGENCE_PROVIDER",
  "WEB_INTELLIGENCE_API_KEY",
  "WEB_INTELLIGENCE_ENDPOINT",
] as const;

export async function researchWeb(
  query: string,
  options: WebIntelligenceOptions = {},
): Promise<WebIntelligenceResult> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new WebIntelligenceError("empty_query", "Research query cannot be empty.");
  }

  const provider = options.provider ?? getConfiguredWebIntelligenceProvider();
  if (!provider) {
    throw new WebIntelligenceError(
      "missing_provider",
      [
        "Web Intelligence provider is not configured.",
        `Required env vars: ${WEB_INTELLIGENCE_REQUIRED_ENV_VARS.join(", ")}.`,
        "Wire a server-side search provider before enabling live web research.",
      ].join(" "),
    );
  }

  const now = options.now ?? new Date();
  const maxFindings = clampMaxFindings(options.maxFindings ?? 5);

  let providerResult: WebIntelligenceProviderResult;
  try {
    providerResult = await provider.search(trimmedQuery, {
      now,
      maxFindings,
      region: options.region,
      language: options.language,
      freshness: options.freshness,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown provider failure.";
    throw new WebIntelligenceError("provider_failure", `Web research failed: ${detail}`);
  }

  const generatedAt = now.toISOString();
  const sources = normalizeSources(providerResult.sources ?? [], provider.name, generatedAt);
  const sourceByUrl = new Map(sources.map((source) => [source.url, source.id]));
  const findings = normalizeFindings(providerResult.findings, sourceByUrl, maxFindings);
  const risks = normalizeRisks(providerResult.risks ?? []);

  return {
    query: trimmedQuery,
    summary: providerResult.summary?.trim() || summarizeFindings(trimmedQuery, findings),
    findings,
    sources,
    risks,
    suggestedNextSteps: normalizeNextSteps(providerResult.suggestedNextSteps ?? [], findings),
    metadata: {
      generatedAt,
      provider: provider.name,
      readOnly: true,
      maxFindings,
      sourceCount: sources.length,
      requiredEnvVars: [...WEB_INTELLIGENCE_REQUIRED_ENV_VARS],
    },
  };
}

export function formatWebSource(source: Pick<WebIntelligenceSource, "title" | "displayUrl" | "url">): string {
  const title = source.title.trim() || source.displayUrl || source.url;
  const displayUrl = source.displayUrl.trim() || toDisplayUrl(source.url);
  return `${title} (${displayUrl})`;
}

function getConfiguredWebIntelligenceProvider(): WebIntelligenceProvider | null {
  return null;
}

function normalizeSources(
  sources: WebIntelligenceSourceInput[],
  defaultProvider: string,
  generatedAt: string,
): WebIntelligenceSource[] {
  return sources
    .filter((source) => source.url.trim())
    .map((source, index) => ({
      id: source.id?.trim() || `source_${index + 1}`,
      title: source.title.trim() || toDisplayUrl(source.url),
      url: source.url.trim(),
      displayUrl: toDisplayUrl(source.url),
      provider: source.provider?.trim() || defaultProvider,
      retrievedAt: source.retrievedAt?.trim() || generatedAt,
    }));
}

function normalizeFindings(
  findings: WebIntelligenceFindingInput[],
  sourceByUrl: Map<string, string>,
  maxFindings: number,
): WebIntelligenceFinding[] {
  return findings
    .filter((finding) => finding.title.trim() || finding.snippet.trim())
    .slice(0, maxFindings)
    .map((finding, index) => {
      const url = finding.url?.trim() || null;
      return {
        id: `finding_${index + 1}`,
        title: finding.title.trim() || "Untitled finding",
        snippet: finding.snippet.trim(),
        url,
        sourceId: finding.sourceId?.trim() || (url ? sourceByUrl.get(url) ?? null : null),
        publishedAt: finding.publishedAt?.trim() || null,
        confidence: normalizeConfidence(finding.confidence),
      };
    });
}

function normalizeRisks(risks: WebIntelligenceRiskInput[]): WebIntelligenceRisk[] {
  return risks
    .filter((risk) => risk.message.trim())
    .map((risk) => ({
      severity: risk.severity,
      message: risk.message.trim(),
      sourceId: risk.sourceId?.trim() || null,
    }));
}

function normalizeNextSteps(steps: string[], findings: WebIntelligenceFinding[]): string[] {
  const cleaned = steps.map((step) => step.trim()).filter(Boolean);
  if (cleaned.length > 0) return cleaned.slice(0, 5);
  if (findings.length === 0) return ["Try a more specific search query."];
  return ["Review the sources before making a decision.", "Compare at least two credible options."];
}

function summarizeFindings(query: string, findings: WebIntelligenceFinding[]): string {
  if (findings.length === 0) return `No web findings were returned for "${query}".`;
  if (findings.length === 1) return `Found 1 relevant web finding for "${query}".`;
  return `Found ${findings.length} relevant web findings for "${query}".`;
}

function normalizeConfidence(confidence: number | null | undefined): number | null {
  if (confidence == null || Number.isNaN(confidence)) return null;
  return Math.max(0, Math.min(1, confidence));
}

function clampMaxFindings(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function toDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url.trim();
  }
}
