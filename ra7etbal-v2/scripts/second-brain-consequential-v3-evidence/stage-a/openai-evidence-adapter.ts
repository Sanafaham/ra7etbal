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
 * Output: one forced, strict function call carrying the frozen V3 TOOL_SCHEMA.
 * Each request is sent once, with no retry.
 */
import type { ModelClient } from "../run";
import type { buildSkillRequest } from "../skill";

export const EVIDENCE_KEY_VAR = "OPENAI_EVIDENCE_KEY";
export const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
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
  usage?: { promptTokens: number | null; completionTokens: number | null };
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

export function buildChatCompletionsBody(model: string, request: SkillRequest) {
  return {
    model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: request.tool.name,
          description: request.tool.description,
          parameters: toStrictParameters(request.tool.input_schema as unknown as JsonSchema),
          strict: true,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: request.tool.name } },
    parallel_tool_calls: false,
    store: false,
  };
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
        res = await fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(buildChatCompletionsBody(model, request)),
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
      const u = (data.usage ?? {}) as Record<string, unknown>;
      const usage = {
        promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
        completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
      };

      const message = ((data.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message ?? {}) as Record<string, unknown>;
      const refusal = typeof message.refusal === "string" && message.refusal.length > 0;
      const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
      // Anything other than exactly one call to the frozen tool is left for the
      // frozen boundary to mark MALFORMED. It is never repaired here.
      let extraction: unknown = null;
      if (calls.length === 1) {
        const fn = (calls[0].function ?? {}) as Record<string, unknown>;
        if (fn.name === request.tool.name && typeof fn.arguments === "string") {
          try {
            extraction = JSON.parse(fn.arguments);
          } catch {
            extraction = fn.arguments;
          }
        }
      }

      if (!producingModelMatches(model, producingModel)) {
        return { producingModel, extraction, error: MODEL_MISMATCH_ERROR, ms, usage, refusal };
      }
      return { producingModel, extraction, ms, usage, refusal };
    },
  };
}
