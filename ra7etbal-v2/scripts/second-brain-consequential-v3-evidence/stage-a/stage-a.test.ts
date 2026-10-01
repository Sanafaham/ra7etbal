import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { V3_CASES, type V3Case } from "../corpus";
import { runGate, type ModelClient, type RunRecord } from "../run";
import type { buildSkillRequest, CarsonInstruction, V3Extraction } from "../skill";
import { STAGE_A_GROUPS, STAGE_A_IDS, STAGE_A_RUNS_PER_CASE, stageACases, stageAJobs } from "./cases";
import { parseMaxCalls, resolveStageACase, runStageA, type StageARecord } from "./runner";
import { buildResponsesBody, createOpenAIEvidenceClient } from "./openai-evidence-adapter";
import { OWNER_PEOPLE } from "../corpus";
import { buildSkillRequest as buildRequest } from "../skill";
import { vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = "candidate-model-x";

/** An extraction built from the frozen expected facts: what a correct model would record. */
function truthExtraction(c: V3Case): V3Extraction {
  const e = c.expected;
  if (e.outcome === "CLARIFY") {
    return { outcome: "clarify", recipient: null, responsibilities: [], carson_instructions: [], clarification: { reason: e.reason, question: "Who do you mean?" } };
  }
  return {
    outcome: "act",
    recipient: e.recipient,
    responsibilities: e.responsibilities.map((r) => ({ text: r.meaning, nature: r.nature, source: "truth" })),
    carson_instructions: e.instructions.map((alts): CarsonInstruction => ({ type: alts[0], owner_words: "truth" })),
    clarification: null,
  };
}

type Answer = (c: V3Case, call: number) => { extraction?: unknown; error?: string; producingModel?: string; providerError?: unknown };
function mockClient(answer: Answer): ModelClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    requestedModel: MODEL,
    calls,
    async extract(request: ReturnType<typeof buildSkillRequest>) {
      const c = V3_CASES.filter((x) => request.user.includes(x.u)).sort((a, b) => b.u.length - a.u.length)[0];
      calls.push(c.id);
      return { producingModel: MODEL, ms: 10, ...answer(c, calls.length) };
    },
  };
}

describe("Stage-A selection references the frozen corpus", () => {
  it("is exactly the 26 approved case ids, in the approved groups, with no duplicates", () => {
    expect(STAGE_A_GROUPS).toEqual({
      loulya: ["O-T1", "O-T2", "O-T3", "A-D1", "O-D1", "V-AR9"],
      grace_call_me: ["A-T1", "A-T2", "A-T4", "V-AR7"],
      ghulam_car: ["A-T9", "A-T6", "P-5"],
      presence_vs_operational: ["O-T4", "O-D3", "A-D3", "A-D4"],
      explicit_custody: ["A-C1", "V-AR3"],
      hold: ["V-R5", "V-U1"],
      arabic_information: ["V-AR5"],
      mixed_language: ["V-M2", "V-M3", "V-M4"],
      wrong_owner_person: ["V-A4"],
    });
    expect(STAGE_A_IDS).toHaveLength(26);
    expect(new Set(STAGE_A_IDS).size).toBe(26);
  });

  it("returns the frozen case objects themselves, not copies", () => {
    for (const c of stageACases()) expect(V3_CASES.includes(c)).toBe(true);
  });

  it("the selection file holds ids only: no utterance or expected answer is duplicated", () => {
    const src = readFileSync(join(HERE, "cases.ts"), "utf8");
    for (const c of V3_CASES) expect(src.includes(c.u), c.id).toBe(false);
    expect(src).not.toMatch(/responsibilities|operational_outcome|personal_message|meaning:/);
  });

  it("covers every required risk: Loulya, Grace, Ghulam, presence, custody, hold, Arabic, mixed, wrong owner", () => {
    const cs = stageACases();
    expect(cs.filter((c) => c.lang === "ar").length).toBe(4);
    expect(cs.filter((c) => c.lang === "mixed").length).toBe(3);
    expect(cs.filter((c) => c.expected.outcome === "HOLD").length).toBe(2);
    expect(cs.filter((c) => c.expected.outcome === "CLARIFY").length).toBe(1);
    const routes = cs.flatMap((c) => (c.expected.outcome === "CLARIFY" ? [] : [c.expected.route]));
    expect(routes.filter((r) => r === "tracked").length).toBe(15);
    expect(routes.filter((r) => r === "direct").length).toBe(10);
  });

  it("is exactly 78 planned calls: 26 cases × 3 runs", () => {
    expect(STAGE_A_RUNS_PER_CASE).toBe(3);
    expect(stageAJobs()).toHaveLength(78);
  });
});

describe("Stage-A runner", () => {
  it("a model that records the frozen facts completes all 78 calls with zero unsafe, and still needs hand review", async () => {
    const client = mockClient((c) => ({ extraction: truthExtraction(c) }));
    const s = await runStageA(client, () => {});
    expect(client.calls).toHaveLength(78);
    expect(s).toMatchObject({ verdict: "ZERO_AUTOMATIC_UNSAFE_HAND_REVIEW_REQUIRED", completed: 78, planned: 78, unsafe: [], stopReason: null });
    expect(s.sentForHandReview.length).toBeGreaterThan(0);
  });

  it("stops at the first unsafe result, keeps the evidence, and fails the model", async () => {
    // A-D1 (Loulya wish, direct) recorded as an operational outcome → tracked: unsafe.
    const client = mockClient((c) => {
      const t = truthExtraction(c);
      if (c.id !== "A-D1") return { extraction: t };
      return { extraction: { ...t, responsibilities: t.responsibilities.map((r) => ({ ...r, nature: "operational_outcome" })) } };
    });
    const records: StageARecord[] = [];
    const s = await runStageA(client, (r) => records.push(r));
    const firstAD1 = STAGE_A_IDS.indexOf("A-D1") * 3 + 1;
    expect(client.calls).toHaveLength(firstAD1);
    expect(records).toHaveLength(firstAD1);
    expect(s.verdict).toBe("FAIL_UNSAFE");
    expect(s.stopReason).toBe("unsafe");
    expect(s.unsafe).toEqual([{ id: "A-D1", run: 1, reasons: ["wrong_route:tracked"] }]);
    expect(s.natureFindings).toContainEqual({ id: "A-D1", run: 1, findings: ["nature_error_changes_route"] });
  });

  it("a masked nature error is reported but is not unsafe and does not stop the screen", async () => {
    const client = mockClient((c) => {
      const t = truthExtraction(c);
      if (c.id !== "A-C1") return { extraction: t };
      return { extraction: { ...t, responsibilities: t.responsibilities.map((r) => ({ ...r, nature: "information" })) } };
    });
    const s = await runStageA(client, () => {});
    expect(s.completed).toBe(78);
    expect(s.unsafe).toEqual([]);
    expect(s.natureFindings.filter((f) => f.id === "A-C1")).toHaveLength(3);
  });

  it("a provider error stops the screen as INCOMPLETE (never a pass), with no retry", async () => {
    const client = mockClient((_c, call) => (call === 5 ? { error: "provider_http_429:insufficient_quota" } : { extraction: truthExtraction(_c) }));
    const s = await runStageA(client, () => {});
    expect(client.calls).toHaveLength(5);
    expect(s).toMatchObject({ verdict: "INCOMPLETE", stopReason: "provider_error", completed: 5 });
    expect(s.providerErrors).toEqual([{ id: STAGE_A_IDS[1], run: 2, error: "provider_http_429:insufficient_quota", detail: null }]);
  });

  it("a rejected request with no producing model stops as provider_error (not model_mismatch) and keeps OpenAI's diagnostic", async () => {
    const detail = { status: 400, type: "invalid_request_error", code: "invalid_value", param: "tools[0]", message: "Invalid schema", requestId: "req_1" };
    const client = mockClient(() => ({ error: "provider_http_400:invalid_value", producingModel: undefined, providerError: detail }));
    const records: StageARecord[] = [];
    const s = await runStageA(client, (r) => records.push(r));
    expect(client.calls).toHaveLength(1);
    expect(s).toMatchObject({ verdict: "INCOMPLETE", stopReason: "provider_error", completed: 1 });
    expect(s.providerErrors).toEqual([{ id: STAGE_A_IDS[0], run: 1, error: "provider_http_400:invalid_value", detail }]);
    expect(records[0].providerError).toEqual(detail);
  });

  it("an answer the adapter rejected for coming from another model still stops as model_mismatch", async () => {
    const client = mockClient((c) => ({ extraction: truthExtraction(c), producingModel: "other-model", error: "auth:producing_model_mismatch" }));
    const s = await runStageA(client, () => {});
    expect(s).toMatchObject({ verdict: "INCOMPLETE", stopReason: "model_mismatch", completed: 1 });
  });

  it.each([["some-other-model"], [undefined]])("a wrong or missing producing model (%j) stops the screen as INCOMPLETE, even if the client did not flag it", async (producing) => {
    const client = mockClient((c) => ({ extraction: truthExtraction(c), producingModel: producing }));
    const s = await runStageA(client, () => {});
    expect(s).toMatchObject({ verdict: "INCOMPLETE", stopReason: "model_mismatch", completed: 1 });
  });

  it("malformed output is counted as usability, not hidden", async () => {
    const client = mockClient((c) => (c.id === "O-T1" ? { extraction: { outcome: "act", route: "tracked" } } : { extraction: truthExtraction(c) }));
    const s = await runStageA(client, () => {});
    expect(s.usability.MALFORMED).toBe(3);
    expect(s.verdict).toBe("ZERO_AUTOMATIC_UNSAFE_HAND_REVIEW_REQUIRED");
  });

  it("each job is processed exactly as the frozen runGate processes it", async () => {
    const answer: Answer = (c) => {
      const t = truthExtraction(c);
      return c.id === "V-M3" ? { extraction: { ...t, carson_instructions: [{ type: "track", owner_words: "x" }] } } : { extraction: t };
    };
    const frozen: RunRecord[] = [];
    await runGate(mockClient(answer), [MODEL], (r) => frozen.push(r), 1);
    const stageA: StageARecord[] = [];
    // V-M3 with an invented custody instruction is unsafe, so compare up to that stop.
    await runStageA(mockClient(answer), (r) => stageA.push(r));
    expect(stageA.length).toBeGreaterThan(1);
    for (const r of stageA) {
      const { usage: _u, refusal: _r, providerError: _p, responseStatus: _s, ...core } = r;
      expect(core).toEqual(frozen.find((f) => f.id === r.id && f.run === r.run));
    }
  });
});

describe("Owner call ceiling (one-call diagnostic)", () => {
  it("parses only a whole number from 1 to 78; default is the full 78", () => {
    expect(parseMaxCalls(undefined)).toBe(78);
    expect(parseMaxCalls("1")).toBe(1);
    expect(parseMaxCalls("78")).toBe(78);
    for (const bad of ["0", "79", "1.5", "-1", "abc", "", " 1", "1e1"]) expect(() => parseMaxCalls(bad), bad).toThrow(/--max-calls/);
  });

  it("an invalid ceiling is refused before any call", async () => {
    const client = mockClient((c) => ({ extraction: truthExtraction(c) }));
    await expect(runStageA(client, () => {}, { maxCalls: 0 })).rejects.toThrow(/call ceiling/);
    await expect(runStageA(client, () => {}, { maxCalls: 79 })).rejects.toThrow(/call ceiling/);
    expect(client.calls).toHaveLength(0);
  });

  it("with a ceiling of 1, a SUCCESSFUL first answer still stops after exactly one call, on O-T1, never a pass", async () => {
    const client = mockClient((c) => ({ extraction: truthExtraction(c) }));
    const records: StageARecord[] = [];
    const s = await runStageA(client, (r) => records.push(r), { maxCalls: 1 });
    expect(client.calls).toEqual(["O-T1"]);
    expect(records.map((r) => r.id)).toEqual(["O-T1"]);
    expect(s).toMatchObject({ verdict: "INCOMPLETE", stopReason: "call_ceiling", completed: 1, planned: 78 });
  });

  it("with a ceiling of 1, a rejected first request stops as provider_error after one call", async () => {
    const client = mockClient(() => ({ error: "provider_http_400:invalid_request_error", producingModel: undefined }));
    const s = await runStageA(client, () => {}, { maxCalls: 1 });
    expect(client.calls).toEqual(["O-T1"]);
    expect(s).toMatchObject({ verdict: "INCOMPLETE", stopReason: "provider_error", completed: 1 });
  });

  it("end to end through the real adapter (network mocked): one request, unchanged request body, even on success", async () => {
    const extraction = truthExtraction(stageACases()[0]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: "completed", error: null, model: MODEL, usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } },
      output: [{ type: "function_call", name: "extract_owner_instruction", arguments: JSON.stringify(extraction), status: "completed" }],
    }), { status: 200 }));
    const client = createOpenAIEvidenceClient({ model: MODEL, env: { OPENAI_EVIDENCE_KEY: "sk-test-only-local" }, fetchImpl });
    const s = await runStageA(client, () => {}, { maxCalls: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ stopReason: "call_ceiling", completed: 1, verdict: "INCOMPLETE" });
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const oT1 = buildRequest({ utterance: stageACases()[0].u, people: OWNER_PEOPLE.map(({ name, relationship }) => ({ name, relationship })) });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.openai.com/v1/responses");
    expect(sent).toEqual(buildResponsesBody(MODEL, oT1));
  });
});

describe("Owner single-case selection (A-D1 diagnostic)", () => {
  const frozenAD1 = () => V3_CASES.find((x) => x.id === "A-D1")!;

  it("A-D1 resolves to the existing frozen corpus object, not a copy", () => {
    const c = resolveStageACase("A-D1")!;
    expect(c).toBe(frozenAD1());
    expect(c.u).toBe("Tell Loulya I would like her to call me.");
    expect(resolveStageACase(undefined)).toBeNull();
  });

  it("only the 26 frozen Stage-A ids are selectable", () => {
    for (const id of STAGE_A_IDS) expect(resolveStageACase(id)!.id).toBe(id);
    const outside = V3_CASES.filter((c) => !STAGE_A_IDS.includes(c.id));
    expect(outside.length).toBe(V3_CASES.length - 26);
    for (const c of outside) expect(() => resolveStageACase(c.id), c.id).toThrow(/26 frozen Stage-A ids/);
  });

  it.each([["NOPE"], [""], ["a-d1"], [" A-D1"], ["A-D1 "], ["--owner-authorized"]])("unknown id %j is refused before any call", async (id) => {
    const client = mockClient((c) => ({ extraction: truthExtraction(c) }));
    await expect(runStageA(client, () => {}, { maxCalls: 1, caseId: id })).rejects.toThrow(/26 frozen Stage-A ids/);
    expect(client.calls).toHaveLength(0);
  });

  it("a valid corpus id outside the Stage-A 26 is refused before any call", async () => {
    const outside = V3_CASES.find((c) => !STAGE_A_IDS.includes(c.id))!;
    const client = mockClient((c) => ({ extraction: truthExtraction(c) }));
    await expect(runStageA(client, () => {}, { maxCalls: 1, caseId: outside.id })).rejects.toThrow(/26 frozen Stage-A ids/);
    expect(client.calls).toHaveLength(0);
  });

  it("with case A-D1 and ceiling 1, a successful answer still stops after exactly one call, on A-D1 only", async () => {
    const client = mockClient((c) => ({ extraction: truthExtraction(c) }));
    const records: StageARecord[] = [];
    const s = await runStageA(client, (r) => records.push(r), { maxCalls: 1, caseId: "A-D1" });
    expect(client.calls).toEqual(["A-D1"]);
    expect(records.map((r) => [r.id, r.run])).toEqual([["A-D1", 1]]);
    expect(s).toMatchObject({ stopReason: "call_ceiling", completed: 1, verdict: "INCOMPLETE" });
  });

  it("the ceiling is independent of the selection: without it, only A-D1's own 3 runs could ever be made", async () => {
    const client = mockClient((c) => ({ extraction: truthExtraction(c) }));
    await runStageA(client, () => {}, { caseId: "A-D1" });
    expect(client.calls).toEqual(["A-D1", "A-D1", "A-D1"]);
    await expect(runStageA(mockClient(() => ({})), () => {}, { maxCalls: 79, caseId: "A-D1" })).rejects.toThrow(/call ceiling/);
  });

  it("end to end through the real adapter (network mocked): the one request carries the frozen A-D1 input", async () => {
    const extraction = truthExtraction(frozenAD1());
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: "completed", error: null, model: MODEL, usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } },
      output: [{ type: "function_call", name: "extract_owner_instruction", arguments: JSON.stringify(extraction), status: "completed" }],
    }), { status: 200 }));
    const client = createOpenAIEvidenceClient({ model: MODEL, env: { OPENAI_EVIDENCE_KEY: "sk-test-only-local" }, fetchImpl });
    await runStageA(client, () => {}, { maxCalls: 1, caseId: "A-D1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const ad1 = buildRequest({ utterance: frozenAD1().u, people: OWNER_PEOPLE.map(({ name, relationship }) => ({ name, relationship })) });
    expect(sent).toEqual(buildResponsesBody(MODEL, ad1));
    expect(sent.input[0].content).toContain("Tell Loulya I would like her to call me.");
  });

  it("omitting the case keeps the full 26-case, 78-job order unchanged", async () => {
    const client = mockClient((c) => ({ extraction: truthExtraction(c) }));
    const s = await runStageA(client, () => {});
    expect(client.calls).toEqual(stageAJobs().map((j) => j.c.id));
    expect(s.completed).toBe(78);
    const first = mockClient((c) => ({ extraction: truthExtraction(c) }));
    await runStageA(first, () => {}, { maxCalls: 1 });
    expect(first.calls).toEqual(["O-T1"]);
  });
});
