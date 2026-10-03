import { describe, expect, it } from "vitest";
import { missingFrozenAnchors } from "./anchors";
import { OTHER_OWNER_PEOPLE, OWNER_NAME, OWNER_PEOPLE, V3_CASES } from "./corpus";
import { gradeRun } from "./grade";
import { composeMessage, fillOwner, messageText, planFromExtraction, RECIPIENT_QUESTION, validateShape, type PlanInput } from "./plan";
import { plannedJobs } from "./run";
import { buildSkillRequest, TOOL_SCHEMA, type CarsonInstruction, type Nature, type Responsibility, type V3Extraction } from "./skill";

const MODEL = "candidate-model-a";
const CANDIDATES = [MODEL];
const r = (text: string, nature: Nature): Responsibility => ({ text, nature, source: "test" });
const ins = (type: CarsonInstruction["type"], owner_words = "test"): CarsonInstruction => ({ type, owner_words });
const ext = (p: Partial<V3Extraction>): V3Extraction => ({ outcome: "act", recipient: "Christopher", responsibilities: [], carson_instructions: [], clarification: null, ...p });
const input = (utterance: string, extraction: unknown, over: Partial<PlanInput> = {}): PlanInput => ({
  extraction, utterance, ownerName: OWNER_NAME, people: OWNER_PEOPLE, otherOwnerPeople: OTHER_OWNER_PEOPLE,
  requestedModel: MODEL, producingModel: MODEL, candidateModels: CANDIDATES, ...over,
});

describe("1/3. Strict schema; the model cannot provide route, channel, custody or a message", () => {
  it.each(["route", "tracked", "carson_follows_through", "carson_duties", "channel", "recipient_message"])("rejects an extraction carrying %s", (field) => {
    const raw = { ...ext({ responsibilities: [r("make pizza", "operational_outcome")] }), [field]: "x" };
    expect(validateShape(raw).extraction).toBeNull();
    expect(planFromExtraction(input("Ask Christopher to make pizza.", raw)).outcome).toBe("MALFORMED");
  });
  it("rejects an unknown nature or instruction type, or an extra item field", () => {
    expect(validateShape(ext({ responsibilities: [{ ...r("x", "operational_outcome"), nature: "tracked" as Nature }] })).extraction).toBeNull();
    expect(validateShape(ext({ carson_instructions: [{ ...ins("track"), type: "should_track" as CarsonInstruction["type"] }] })).extraction).toBeNull();
    expect(validateShape(ext({ responsibilities: [{ ...r("x", "information"), carson_follows_through: true } as Responsibility] })).extraction).toBeNull();
  });
  it("the tool schema exposes only extraction fields", () => {
    expect(Object.keys(TOOL_SCHEMA.input_schema.properties)).toEqual(["outcome", "recipient", "responsibilities", "carson_instructions", "clarification"]);
  });
});

describe("2. Policy applied through the boundary", () => {
  it("operational outcome → tracked; information → direct; explicit custody → tracked", () => {
    expect(planFromExtraction(input("Ask Christopher to make pizza.", ext({ responsibilities: [r("make pizza", "operational_outcome")] }))).outcome).toBe("SEND_TRACKED");
    expect(planFromExtraction(input("Tell Christopher dinner is at eight.", ext({ responsibilities: [r("dinner is at eight", "information")] }))).outcome).toBe("SEND_DIRECT");
    const loulya = planFromExtraction(input("Tell Loulya I would like her to call me and make sure she does.", ext({
      recipient: "Loulya", responsibilities: [r("{owner} would like you to call her", "personal_message")], carson_instructions: [ins("make_sure", "make sure she does")],
    })));
    expect(loulya.outcome).toBe("SEND_TRACKED");
  });
});

describe("4. Exactly one of this owner's people, named by the owner — otherwise one standard question", () => {
  it.each([
    ["Ask him to prepare lunch.", "Christopher"],
    ["Ask Maria to water the plants.", "Maria"],
    ["Ask Christopher to make pizza.", "Nobody"],
  ])("%s (model said %s) → one recipient question, no send", (u, who) => {
    const plan = planFromExtraction(input(u, ext({ recipient: who, responsibilities: [r("do it", "operational_outcome")] })));
    expect(plan).toMatchObject({ outcome: "CLARIFY_RECIPIENT", question: RECIPIENT_QUESTION, message: null });
  });
});

describe("5/6/7. Recipient content from responsibilities only, Carson instructions never rendered, owner's order kept", () => {
  const u = "Ask Christopher to prepare lunch and tell Grace it is ready, and track this until he confirms.";
  it("both responsibilities, in order, and none of the instruction", () => {
    const plan = planFromExtraction(input(u, ext({
      responsibilities: [r("prepare lunch", "operational_outcome"), r("tell Grace when it is ready", "operational_outcome")],
      carson_instructions: [ins("track", "TRACK THIS UNTIL HE CONFIRMS")],
    })));
    expect(plan.outcome).toBe("SEND_TRACKED");
    expect(messageText(plan.message!)).toBe("Prepare lunch. Tell Grace when it is ready.");
    expect(messageText(plan.message!).toLowerCase()).not.toMatch(/track|confirm/);
  });
  it("presence + operational outcome stays in the owner's order inside one tracked task", () => {
    const m = composeMessage("tracked", [r("wait until 8", "presence_coordination"), r("then clean the kitchen", "operational_outcome")], OWNER_NAME);
    expect(m).toEqual({ route: "tracked", taskText: "Wait until 8. Then clean the kitchen.", note: null });
  });
});

describe("8/9. Owner placeholder", () => {
  it("fills {owner} from the authoritative profile in any language", () => {
    expect(fillOwner("اتصلي في {owner}", "Sana")).toBe("اتصلي في Sana");
    expect(fillOwner("call {Owner}", "Sana")).toBe("call Sana");
  });
  it("an unknown placeholder means no send", () => {
    const plan = planFromExtraction(input("Ask Grace to call me.", ext({ recipient: "Grace", responsibilities: [r("call {boss}", "operational_outcome")] })));
    expect(plan.outcome).toBe("NO_SEND_GUARD");
    expect(plan.failures).toContain("guard:unknown_placeholder");
  });
});

describe("10. Material anchors", () => {
  it("lost or invented people and numbers are caught (runtime closed vocabulary)", () => {
    const lost = planFromExtraction(input("Ask Christopher to prepare lunch and tell Grace it is ready.", ext({ responsibilities: [r("prepare lunch", "operational_outcome")] })));
    expect(lost.failures).toContain("anchor:lost_person:Grace");
    const time = planFromExtraction(input("Ask Christopher to bring the car around at 6.", ext({ responsibilities: [r("bring the car around at 6 pm", "operational_outcome")] })));
    expect(time.failures).toContain("anchor:invented:PART:pm");
  });
  it("frozen evaluation anchors cover quantities, dates, locations and conditions", () => {
    const c = V3_CASES.find((x) => x.id === "V-N5")!;
    expect(missingFrozenAnchors("Iron the shirts.", c.anchors).map((a) => a.type)).toEqual(["quantity", "date", "condition", "location"]);
  });
});

describe("11. Unsupported Carson instruction holds the whole action", () => {
  it("no external send, even though a supported part exists", () => {
    const plan = planFromExtraction(input("Ask Christopher to prepare lunch, and once he confirms, remind me to call Grace.", ext({
      responsibilities: [r("prepare lunch", "operational_outcome")], carson_instructions: [ins("remind_owner", "once he confirms, remind me to call Grace")],
    })));
    expect(plan.outcome).toBe("HOLD_UNSUPPORTED");
  });
});

describe("12/13. Channel independence (C-01)", () => {
  it("identical extraction gives an identical deterministic result whatever the input mode", () => {
    const e = ext({ recipient: "Grace", responsibilities: [r("call {owner}", "operational_outcome")] });
    expect(planFromExtraction(input("Tell Grace to call me.", structuredClone(e)))).toEqual(planFromExtraction(input("Tell Grace to call me.", structuredClone(e))));
  });
  it("the skill request carries no channel and ignores any extra field", () => {
    const base = { utterance: "Tell Grace to call me.", people: [{ name: "Grace", relationship: "staff" as const }] };
    const a = buildSkillRequest(base);
    const b = buildSkillRequest({ ...base, channel: "voice" } as typeof base);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(a)).not.toMatch(/channel|typed|talk to carson|type to carson/i);
  });
});

describe("14. No fallback model", () => {
  it("output from a different model than requested, or a non-candidate, is rejected", () => {
    const e = ext({ responsibilities: [r("make pizza", "operational_outcome")] });
    expect(planFromExtraction(input("Ask Christopher to make pizza.", e, { producingModel: "other-model" })).failures).toContain("auth:producing_model_mismatch");
    expect(planFromExtraction(input("Ask Christopher to make pizza.", e, { requestedModel: "other-model", producingModel: "other-model" })).failures).toContain("auth:model_not_candidate");
  });
});

describe("Grader (evaluation only) separates unsafe outcomes from extraction findings", () => {
  const ad1 = V3_CASES.find((x) => x.id === "A-D1")!;
  it("a wrong nature that changes the route is UNSAFE", () => {
    const e = ext({ recipient: "Loulya", responsibilities: [r("{owner} would like you to call her", "operational_outcome")] });
    const g = gradeRun(ad1, planFromExtraction(input(ad1.u, e)), e, null);
    expect(g).toMatchObject({ safety: "UNSAFE", natureFindings: ["nature_error_changes_route"] });
  });
  it("an invented custody instruction is reported and, here, also makes the route wrong", () => {
    const e = ext({ recipient: "Loulya", responsibilities: [r("{owner} would like you to call her", "personal_message")], carson_instructions: [ins("track")] });
    const g = gradeRun(ad1, planFromExtraction(input(ad1.u, e)), e, null);
    expect(g.safety).toBe("UNSAFE");
    expect(g.instructionFindings).toEqual(["invented_instruction:track"]);
  });
  it("a masked nature error is reported even when the final route is right", () => {
    const c = V3_CASES.find((x) => x.id === "V-L3")!;
    const e = ext({ responsibilities: [r("prepare lunch", "personal_message")], carson_instructions: [ins("track")] });
    const g = gradeRun(c, planFromExtraction(input(c.u, e)), e, null);
    expect(g).toMatchObject({ safety: "REVIEW", natureFindings: ["nature_error_masked_by_instruction"], instructionFindings: [] });
  });
  it("a dropped explicit instruction is reported", () => {
    const c = V3_CASES.find((x) => x.id === "O-T3")!;
    const e = ext({ recipient: "Loulya", responsibilities: [r("{owner} asks you to call her", "personal_message")] });
    const g = gradeRun(c, planFromExtraction(input(c.u, e)), e, null);
    expect(g.safety).toBe("UNSAFE"); // direct instead of tracked
    expect(g.instructionFindings[0]).toMatch(/^dropped_instruction:/);
  });
  it("a held run with the wrong derived route is UNSAFE under the strict routing rule", () => {
    const c = V3_CASES.find((x) => x.id === "V-S23")!;
    const e = ext({ recipient: "Ghulam", responsibilities: [r("fix the gate", "information")], carson_instructions: [ins("remind_owner", "remind me tomorrow to check it")] });
    const plan = planFromExtraction(input(c.u, e));
    expect(plan.outcome).toBe("HOLD_UNSUPPORTED");
    expect(gradeRun(c, plan, e, null).safety).toBe("UNSAFE");
  });
});

describe("Frozen run matrix", () => {
  it("3 runs per case and 10 per critical case", () => {
    const critical = V3_CASES.filter((c) => c.critical).length;
    expect(plannedJobs().length).toBe((V3_CASES.length - critical) * 3 + critical * 10);
  });
});
