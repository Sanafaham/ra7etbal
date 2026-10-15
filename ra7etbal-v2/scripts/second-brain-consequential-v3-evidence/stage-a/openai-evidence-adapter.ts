/**
 * EVIDENCE ONLY — isolated OpenAI adapter for the frozen V3 extraction
 * contract. Not wired into Production and imports nothing from api/ or src/.
 *
 * Credential isolation:
 *   - The only credential it reads is the evidence-only OPENAI_EVIDENCE_KEY,
 *     from an env object passed in by the caller.
 *   - It never reads, names or falls back to any other credential.
 *   - It uses plain fetch, not the `openai` SDK, because the SDK reads a
 *     default environment credential on its own when none is given.
 *   - A missing key throws before any network call can happen.
 *
 * Model: the candidate model is an explicit argument with no default and no
 * fallback model. The model the provider says produced the answer is recorded,
 * and any answer from a different model is rejected using the same rule as the
 * frozen boundary (plan.ts): the producing model must start with the requested
 * model name.
 *
 * Output: one forced, strict function call carrying the frozen V3 TOOL_SCHEMA,
 * through the Responses API (POST /v1/responses) with reasoning effort fixed
 * at "medium" (gpt-5.6-luna's documented default, stated explicitly). OpenAI
 * rejects function tools with reasoning on /v1/chat/completions for this
 * model (Stage-A diagnostic run 36909196714), so Chat Completions is not used.
 * The frozen system prompt is sent as `instructions` and the frozen user text
 * as the one user input. Each request is sent once, with no retry, and
 * nothing is stored by OpenAI (store: false).
 */
import type { ModelClient } from "../run";
import type { buildSkillRequest } from "../skill";

export const EVIDENCE_KEY_VAR = "OPENAI_EVIDENCE_KEY";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
/** Fixed for the V3 experiment. Not a parameter. */
export const REASONING_EFFORT = "medium";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MODEL_MISMATCH_ERROR = "auth:producing_model_mismatch";

export type SkillRequest = ReturnType<typeof buildSkillRequest>;

export interface EvidenceEnv {
  readonly OPENAI_EVIDENCE_KEY?: string;
}

/**
 * What OpenAI said about a rejected request, kept so the rejection can be
 * diagnosed. Only these fields are kept: never the request body, headers or
 * key. The key value and anything shaped like an OpenAI key are redacted,
 * and text fields are length-capped.
 */
export interface ProviderErrorDetail {
  status: number;
  type: string | null;
  code: string | null;
  param: string | null;
  message: string | null;
  requestId: string | null;
}

export interface EvidenceResult {
  producingModel?: string;
  extraction?: unknown;
  error?: string;
  providerError?: ProviderErrorDetail;
  ms: number;
  usage?: { promptTokens: number | null; completionTokens: number | null; reasoningTokens: number | null };
  /** The Responses API `status` of a 2xx response (expected "completed"). */
  responseStatus?: string | null;
  refusal?: boolean;
}

export interface OpenAIEvidenceClient extends ModelClient {
  extract(request: SkillRequest): Promise<EvidenceResult>;
}

export class EvidenceCredentialMissingError extends Error {
  constructor() {
    super(`${EVIDENCE_KEY_VAR} is not set. Stage A will not run without the evidence-only credential.`);
    this.name = "EvidenceCredentialMissingError";
  }
}

/** Same model-authorization rule as the frozen boundary (plan.ts). */
export function producingModelMatches(requestedModel: string, producingModel: string | undefined): boolean {
  return !!producingModel && producingModel.startsWith(requestedModel);
}

type JsonSchema = Record<string, unknown>;

/**
 * The frozen TOOL_SCHEMA written for OpenAI strict function calling. The frozen
 * schema itself is not changed. The only re-encoding: a node typed
 * ["object", "null"] becomes anyOf [object, null], the documented way to make
 * an object nullable in strict mode. Same fields, required lists, enums and
 * additionalProperties: false.
 */
export function toStrictParameters(schema: JsonSchema): JsonSchema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    const t = out.type;
    if (Array.isArray(t) && t.includes("object") && t.includes("null") && t.length === 2) {
      const { type: _type, description, ...objectBranch } = out;
      return { ...(description !== undefined ? { description } : {}), anyOf: [{ type: "object", ...objectBranch }, { type: "null" }] };
    }
    return out;
  };
  return walk(schema) as JsonSchema;
}

export function buildResponsesBody(model: string, request: SkillRequest) {
  return {
    model,
    instructions: request.system,
    input: [{ role: "user", content: request.user }],
    tools: [
      {
        type: "function",
        name: request.tool.name,
        description: request.tool.description,
        parameters: toStrictParameters(request.tool.input_schema as unknown as JsonSchema),
        strict: true,
      },
    ],
    tool_choice: { type: "function", name: request.tool.name },
    parallel_tool_calls: false,
    reasoning: { effort: REASONING_EFFORT },
    store: false,
  };
}

/**
 * Reads only the expected Responses API result. The extraction is the parsed
 * `arguments` of exactly one completed `function_call` for the frozen tool,
 * in a response whose status is "completed" and whose output holds nothing
 * but reasoning items and that one call. Anything else gives a null
 * extraction (or the unparsed string), which the frozen boundary marks
 * MALFORMED. Nothing is ever repaired here.
 */
export function extractFromResponses(data: Record<string, unknown>, toolName: string): { extraction: unknown; refusal: boolean } {
  const output = Array.isArray(data.output) ? (data.output as Array<Record<string, unknown>>) : null;
  const refusal = !!output?.some(
    (item) => item?.type === "message" && Array.isArray(item.content) && (item.content as Array<Record<string, unknown>>).some((c) => c?.type === "refusal"),
  );
  if (data.status !== "completed" || (data.error !== undefined && data.error !== null) || !output) return { extraction: null, refusal };
  if (output.some((item) => !item || (item.type !== "reasoning" && item.type !== "function_call"))) return { extraction: null, refusal };
  const calls = output.filter((item) => item.type === "function_call");
  if (calls.length !== 1) return { extraction: null, refusal };
  const call = calls[0];
  if (call.name !== toolName || typeof call.arguments !== "string" || (call.status !== undefined && call.status !== "completed")) return { extraction: null, refusal };
  try {
    return { extraction: JSON.parse(call.arguments), refusal };
  } catch {
    return { extraction: call.arguments, refusal };
  }
}

const KEY_SHAPE = /\b(sk|rk|ek)-[A-Za-z0-9_*\-]{6,}/g;
const MESSAGE_MAX = 600;
const FIELD_MAX = 200;

/** Removes the evidence key and anything shaped like an OpenAI key, then caps the length. */
export function redactProviderText(v: unknown, key: string, max: number): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  let out = key ? v.split(key).join("[REDACTED]") : v;
  out = out.replace(/bearer\s+\S+/gi, "Bearer [REDACTED]").replace(KEY_SHAPE, "[REDACTED]");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export function providerErrorDetail(status: number, body: unknown, requestId: string | null, key: string): ProviderErrorDetail {
  const e = (body && typeof body === "object" ? ((body as Record<string, unknown>).error ?? {}) : {}) as Record<string, unknown>;
  return {
    status,
    type: redactProviderText(e.type, key, FIELD_MAX),
    code: redactProviderText(typeof e.code === "number" ? String(e.code) : e.code, key, FIELD_MAX),
    param: redactProviderText(e.param, key, FIELD_MAX),
    message: redactProviderText(e.message, key, MESSAGE_MAX),
    requestId: redactProviderText(requestId, key, FIELD_MAX),
  };
}

function safeCode(v: unknown): string {
  return typeof v === "string" ? v.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64) : "";
}

export interface OpenAIEvidenceClientOptions {
  model: string;
  env: EvidenceEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export function createOpenAIEvidenceClient(opts: OpenAIEvidenceClientOptions): OpenAIEvidenceClient {
  const key = opts.env.OPENAI_EVIDENCE_KEY;
  if (typeof key !== "string" || key.trim() === "") throw new EvidenceCredentialMissingError();
  const model = opts.model;
  if (typeof model !== "string" || model.trim() === "" || /\s/.test(model)) throw new Error("stage-a: an explicit candidate model name is required");

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());

  return {
    requestedModel: model,
    async extract(request: SkillRequest): Promise<EvidenceResult> {
      const started = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(buildResponsesBody(model, request)),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const name = err instanceof Error ? safeCode(err.name) : "unknown";
        return { error: `provider_network:${name || "unknown"}`, ms: now() - started };
      }
      let data: Record<string, unknown> | null = null;
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch {
        data = null;
      } finally {
        clearTimeout(timer);
      }
      const ms = now() - started;

      if (!res.ok) {
        const e = (data?.error ?? {}) as Record<string, unknown>;
        return {
          error: `provider_http_${res.status}:${safeCode(e.code) || safeCode(e.type) || "unknown"}`,
          providerError: providerErrorDetail(res.status, data, res.headers.get("x-request-id"), key),
          ms,
        };
      }
      if (!data) return { error: "provider_bad_json", ms };

      const producingModel = typeof data.model === "string" ? data.model : undefined;
      const responseStatus = typeof data.status === "string" ? data.status : null;
      const u = (data.usage ?? {}) as Record<string, unknown>;
      const details = (u.output_tokens_details ?? {}) as Record<string, unknown>;
      const usage = {
        promptTokens: typeof u.input_tokens === "number" ? u.input_tokens : null,
        completionTokens: typeof u.output_tokens === "number" ? u.output_tokens : null,
        reasoningTokens: typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : null,
      };
      const { extraction, refusal } = extractFromResponses(data, request.tool.name);

      if (!producingModelMatches(model, producingModel)) {
        return { producingModel, extraction, error: MODEL_MISMATCH_ERROR, ms, usage, refusal, responseStatus };
      }
      return { producingModel, extraction, ms, usage, refusal, responseStatus };
    },
  };
}
