import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { OTHER_OWNER_PEOPLE, OWNER_NAME, OWNER_PEOPLE } from "../corpus";
import { planFromExtraction } from "../plan";
import { buildSkillRequest, TOOL_NAME, TOOL_SCHEMA } from "../skill";
import {
  buildChatCompletionsBody, createOpenAIEvidenceClient, EVIDENCE_KEY_VAR, EvidenceCredentialMissingError, OPENAI_CHAT_COMPLETIONS_URL,
  producingModelMatches, toStrictParameters, type EvidenceEnv,
} from "./openai-evidence-adapter";

const HERE = dirname(fileURLToPath(import.meta.url));
// Built from parts so this test file never contains the Production credential name itself.
const PRODUCTION_KEY_NAME = ["OPENAI", "API", "KEY"].join("_");
const SECRET = "sk-evidence-TEST-ONLY-not-a-real-key-123";
const MODEL = "candidate-model-x";
const request = buildSkillRequest({ utterance: "Ask Grace to call me.", people: OWNER_PEOPLE.map(({ name, relationship }) => ({ name, relationship })) });

const okExtraction = { outcome: "act", recipient: "Grace", responsibilities: [{ text: "call {owner}", nature: "operational_outcome", source: "call me" }], carson_instructions: [], clarification: null };
function okResponse(over: Record<string, unknown> = {}, args: unknown = JSON.stringify(okExtraction)) {
  return new Response(JSON.stringify({
    model: MODEL, usage: { prompt_tokens: 1200, completion_tokens: 140 },
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: TOOL_NAME, arguments: args } }] } }],
    ...over,
  }), { status: 200, headers: { "content-type": "application/json" } });
}
const env = (key: string | undefined): EvidenceEnv => ({ OPENAI_EVIDENCE_KEY: key });

function stageAFiles(): string[] {
  return readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(HERE, f));
}

describe("Credential isolation", () => {
  it("the evidence variable is OPENAI_EVIDENCE_KEY", () => {
    expect(EVIDENCE_KEY_VAR).toBe("OPENAI_EVIDENCE_KEY");
  });

  it.each([
    ["absent", {}],
    ["undefined", env(undefined)],
    ["empty", env("")],
    ["whitespace", env("   ")],
    ["only the Production credential name present", { [PRODUCTION_KEY_NAME]: "sk-production-should-never-be-read" }],
  ])("missing evidence key (%s) fails closed before any network call", (_label, e) => {
    const fetchImpl = vi.fn();
    expect(() => createOpenAIEvidenceClient({ model: MODEL, env: e as EvidenceEnv, fetchImpl })).toThrow(EvidenceCredentialMissingError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads exactly one env property, OPENAI_EVIDENCE_KEY, even when the Production credential is also present", async () => {
    const read: PropertyKey[] = [];
    const target = { OPENAI_EVIDENCE_KEY: SECRET, [PRODUCTION_KEY_NAME]: "sk-production-should-never-be-read" };
    const spyEnv = new Proxy(target, { get: (t, p) => (read.push(p), Reflect.get(t, p)) });
    const fetchImpl = vi.fn(async () => okResponse());
    const client = createOpenAIEvidenceClient({ model: MODEL, env: spyEnv, fetchImpl });
    await client.extract(request);
    expect(read).toEqual(["OPENAI_EVIDENCE_KEY"]);
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("sk-production");
  });

  it("no Stage-A source file names the Production credential, and only the CLI touches process.env (one variable)", () => {
    for (const file of stageAFiles()) {
      const src = readFileSync(file, "utf8");
      expect(src.includes(PRODUCTION_KEY_NAME), file).toBe(false);
      const envUses = src.match(/process\.env(\.[A-Za-z_]+|\[)?/g) ?? [];
      if (file.endsWith("cli.ts")) expect(envUses).toEqual(["process.env.OPENAI_EVIDENCE_KEY"]);
      else expect(envUses, file).toEqual([]);
    }
  });

  it("the frozen V3 files the evidence path imports never name the Production credential", () => {
    for (const f of ["skill.ts", "plan.ts", "policy.ts", "grade.ts", "run.ts", "corpus.ts", "anchors.ts"]) {
      expect(readFileSync(join(HERE, "..", f), "utf8").includes(PRODUCTION_KEY_NAME), f).toBe(false);
    }
  });

  it("imports only node built-ins, the frozen V3 modules and its own Stage-A files (no SDK, Production, database or messaging code)", () => {
    const allowed = new Set(["node:fs", "node:path", "node:url", "../corpus", "../grade", "../plan", "../run", "../skill", "./cases", "./runner", "./openai-evidence-adapter"]);
    for (const file of stageAFiles()) {
      for (const m of readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)) expect(allowed.has(m[1]), `${file} imports ${m[1]}`).toBe(true);
    }
  });

  it("the secret never appears in any returned result or error", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => okResponse(),
      async () => new Response(JSON.stringify({ error: { code: "insufficient_quota", message: `bad key ${SECRET}` } }), { status: 429 }),
      async () => new Response("not json", { status: 500 }),
      async () => { throw new TypeError(`connect failed ${SECRET}`); },
    ];
    for (const f of cases) {
      const client = createOpenAIEvidenceClient({ model: MODEL, env: env(SECRET), fetchImpl: vi.fn(f) });
      expect(JSON.stringify(await client.extract(request))).not.toContain(SECRET);
    }
  });
});

describe("No fallback", () => {
  it.each([[""], ["  "], ["two words"]])("an explicit candidate model is required (%j)", (model) => {
    const fetchImpl = vi.fn();
    expect(() => createOpenAIEvidenceClient({ model, env: env(SECRET), fetchImpl })).toThrow(/explicit candidate model/);
    expect(() => createOpenAIEvidenceClient({ env: env(SECRET), fetchImpl } as unknown as Parameters<typeof createOpenAIEvidenceClient>[0])).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends exactly one request, to the fixed endpoint, naming only the requested model", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await createOpenAIEvidenceClient({ model: MODEL, env: env(SECRET), fetchImpl }).extract(request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(JSON.parse(init.body as string).model).toBe(MODEL);
  });

  it.each([[429, "insufficient_quota"], [404, "model_not_found"], [500, "server_error"], [400, "invalid_request_error"]])(
    "HTTP %i is preserved as evidence with no retry and no second model", async (status, code) => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code } }), { status }));
      const r = await createOpenAIEvidenceClient({ model: MODEL, env: env(SECRET), fetchImpl }).extract(request);
      expect(r.error).toBe(`provider_http_${status}:${code}`);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("a network failure or timeout is preserved as evidence with no retry", async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    const r = await createOpenAIEvidenceClient({ model: MODEL, env: env(SECRET), fetchImpl }).extract(request);
    expect(r.error).toBe("provider_network:AbortError");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Producing-model verification (same rule as the frozen boundary)", () => {
  it("records the provider's model and accepts a dated snapshot of the requested model", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ model: `${MODEL}-2026-09-01` }));
    const r = await createOpenAIEvidenceClient({ model: MODEL, env: env(SECRET), fetchImpl }).extract(request);
    expect(r).toMatchObject({ producingModel: `${MODEL}-2026-09-01`, extraction: okExtraction, usage: { promptTokens: 1200, completionTokens: 140 } });
    expect(r.error).toBeUndefined();
  });

  it.each([["other-model"], [undefined]])("a different or missing producing model (%j) is rejected but kept as evidence", async (producing) => {
    const fetchImpl = vi.fn(async () => okResponse({ model: producing }));
    const r = await createOpenAIEvidenceClient({ model: MODEL, env: env(SECRET), fetchImpl }).extract(request);
    expect(r.error).toBe("auth:producing_model_mismatch");
    expect(r.extraction).toEqual(okExtraction);
  });

  it("agrees with the frozen plan.ts authorization rule", () => {
    for (const [requested, producing] of [[MODEL, MODEL], [MODEL, `${MODEL}-2026-09-01`], [MODEL, "other"], [MODEL, undefined], [MODEL, MODEL.slice(0, 5)]] as const) {
      const plan = planFromExtraction({
        extraction: okExtraction, utterance: "Ask Grace to call me.", ownerName: OWNER_NAME, people: OWNER_PEOPLE, otherOwnerPeople: OTHER_OWNER_PEOPLE,
        requestedModel: requested, producingModel: producing, candidateModels: [requested],
      });
      expect(producingModelMatches(requested, producing)).toBe(!plan.failures.includes("auth:producing_model_mismatch"));
    }
  });

  it("records latency", async () => {
    const times = [1_000, 1_250];
    const fetchImpl = vi.fn(async () => okResponse());
    const r = await createOpenAIEvidenceClient({ model: MODEL, env: env(SECRET), fetchImpl, now: () => times.shift()! }).extract(request);
    expect(r.ms).toBe(250);
  });
});

describe("Structured output: forced, strict, frozen schema", () => {
  const body = buildChatCompletionsBody(MODEL, request);

  it("forces exactly one strict call to the frozen tool, stores nothing, and sends the frozen prompt unchanged", () => {
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function).toMatchObject({ name: TOOL_NAME, description: TOOL_SCHEMA.description, strict: true });
    expect(body.tool_choice).toEqual({ type: "function", function: { name: TOOL_NAME } });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.store).toBe(false);
    expect(body.messages).toEqual([{ role: "system", content: request.system }, { role: "user", content: request.user }]);
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "parallel_tool_calls", "store", "tool_choice", "tools"]);
  });

  it("every object in the sent schema is closed and requires all its fields (strict-mode rules)", () => {
    const visit = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(visit);
      if (!n || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      if (o.type === "object") {
        expect(o.additionalProperties).toBe(false);
        expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
      }
      Object.values(o).forEach(visit);
    };
    visit(body.tools[0].function.parameters);
  });

  it("is the frozen schema, with only the nullable clarification object re-encoded as anyOf", () => {
    const before = JSON.stringify(TOOL_SCHEMA);
    const strict = toStrictParameters(TOOL_SCHEMA.input_schema as unknown as Record<string, unknown>) as { properties: Record<string, unknown> };
    expect(JSON.stringify(TOOL_SCHEMA)).toBe(before); // frozen schema not mutated
    const frozen = TOOL_SCHEMA.input_schema;
    const { clarification: sc, ...strictRest } = strict.properties;
    const { clarification: fc, ...frozenRest } = frozen.properties;
    expect(strictRest).toEqual(frozenRest);
    const { type: _t, ...fcObject } = fc;
    expect(sc).toEqual({ anyOf: [{ type: "object", ...fcObject }, { type: "null" }] });
    expect({ ...strict, properties: undefined }).toEqual({ ...frozen, properties: undefined });
  });

  it("output that is not exactly one call to the frozen tool is left for the frozen boundary to reject (never repaired)", async () => {
    const variants = [
      okResponse({}, "{not json"),
      okResponse({ choices: [{ message: { content: "Sure!", tool_calls: [] } }] }),
      okResponse({ choices: [{ message: { refusal: "I can't help", tool_calls: [] } }] }),
    ];
    for (const v of variants) {
      const r = await createOpenAIEvidenceClient({ model: MODEL, env: env(SECRET), fetchImpl: vi.fn(async () => v) }).extract(request);
      expect(r.error).toBeUndefined();
      const plan = planFromExtraction({
        extraction: r.extraction, utterance: "Ask Grace to call me.", ownerName: OWNER_NAME, people: OWNER_PEOPLE, otherOwnerPeople: OTHER_OWNER_PEOPLE,
        requestedModel: MODEL, producingModel: r.producingModel, candidateModels: [MODEL],
      });
      expect(plan.outcome).toBe("MALFORMED");
    }
  });
});

describe("Stage-A workflow wiring (static; never executed by tests)", () => {
  const WORKFLOWS = join(HERE, "..", "..", "..", "..", ".github", "workflows");
  const wf = readFileSync(join(WORKFLOWS, "v3-stage-a-evidence.yml"), "utf8");
  const OTHER_CREDENTIALS = [PRODUCTION_KEY_NAME, ["LLM", "API", "KEY"].join("_"), ["ANTHROPIC", "EVIDENCE", "KEY"].join("_"), ["ANTHROPIC", "API", "KEY"].join("_")];

  it("references exactly one secret, OPENAI_EVIDENCE_KEY, and no other credential name", () => {
    expect(new Set([...wf.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))).toEqual(new Set(["OPENAI_EVIDENCE_KEY"]));
    for (const name of OTHER_CREDENTIALS) expect(wf.includes(name), name).toBe(false);
    expect(wf).not.toMatch(/secrets\s*\[|toJSON\(\s*secrets|secrets:\s*inherit|OPENAI_BASE_URL/);
  });

  it("exposes the key to exactly one step, the Stage-A run", () => {
    const assignments = [...wf.matchAll(/^\s+OPENAI_EVIDENCE_KEY:\s*\$\{\{\s*secrets\.OPENAI_EVIDENCE_KEY\s*\}\}\s*$/gm)];
    expect(assignments).toHaveLength(1);
    const after = wf.slice(assignments[0].index);
    expect(after).toMatch(/^[\s\S]*?run: >-\s+npx --no-install vite-node scripts\/second-brain-consequential-v3-evidence\/stage-a\/cli\.ts --/);
  });

  it("runs only on an owner-added label for this exact branch, with read-only permissions", () => {
    expect(wf).toMatch(/^on:\n {2}pull_request:\n {4}types: \[labeled\]\n\n/m);
    expect(wf).not.toMatch(/^\s+(push|workflow_dispatch|schedule|pull_request_target|workflow_run|issue_comment):/m);
    expect(wf).toContain("github.event.label.name == 'run-v3-stage-a'");
    expect(wf).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(wf).toContain("github.event.pull_request.head.ref == 'claude/second-brain-consequential-v3-stage-a'");
    expect(wf).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(wf).toContain("persist-credentials: false");
  });

  it("names exactly one candidate model and checks the frozen V3 files before any call", () => {
    expect([...wf.matchAll(/^\s+STAGE_A_MODEL:\s*(\S+)\s*$/gm)].map((m) => m[1])).toEqual(["gpt-5.6-luna"]);
    expect(wf).toContain("FROZEN_V3_SHA: e3c2e1458d9b40133ce3aa90430ee09cce8ed91c");
    expect(wf.indexOf("git diff --exit-code")).toBeLessThan(wf.indexOf("stage-a/cli.ts"));
    expect(wf.indexOf("vitest run")).toBeLessThan(wf.indexOf("stage-a/cli.ts"));
  });

  it("no other workflow references the evidence key", () => {
    for (const f of readdirSync(WORKFLOWS).filter((x) => x !== "v3-stage-a-evidence.yml")) {
      expect(readFileSync(join(WORKFLOWS, f), "utf8").includes("OPENAI_EVIDENCE_KEY"), f).toBe(false);
    }
  });
});
