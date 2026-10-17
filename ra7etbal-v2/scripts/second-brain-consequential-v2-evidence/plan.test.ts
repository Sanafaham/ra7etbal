import { describe, expect, it } from "vitest";
import { missingFrozenAnchors } from "./anchors";
import { OTHER_OWNER_PEOPLE, OWNER_NAME, OWNER_PEOPLE, V2_CASES } from "./corpus";
import { gradePlan } from "./grade";
import { composeMessage, deriveRoute, fillOwner, messageText, planFromProposal, validateShape, type PlanInput } from "./plan";
import { buildSkillRequest, TOOL_SCHEMA, type RecipientItem, type V2Proposal } from "./skill";

const MODEL = "claude-sonnet-4-6";
const item = (text: string, carson_follows_through: boolean): RecipientItem => ({ text, carson_follows_through, basis: "test" });
const proposal = (p: Partial<V2Proposal>): V2Proposal => ({
  outcome: "act",
  recipient: "Christopher",
  recipient_items: [],
  carson_duties: [],
  clarification: null,
  ...p,
});
const input = (utterance: string, p: unknown, over: Partial<PlanInput> = {}): PlanInput => ({
  proposal: p,
  utterance,
  ownerName: OWNER_NAME,
  people: OWNER_PEOPLE,
  otherOwnerPeople: OTHER_OWNER_PEOPLE,
  requestedModel: MODEL,
  producingModel: MODEL,
  ...over,
});

describe("1. C-02 route derivation from structured answers", () => {
  it("tracked when any recipient item keeps Carson custody", () => {
    expect(deriveRoute([item("a", false), item("b", true)], [])).toBe("tracked");
  });
  it("direct when no item keeps custody and there is no custody duty", () => {
    expect(deriveRoute([item("a", false)], [])).toBe("direct");
  });
  it("explicit custody duty makes it tracked without changing the item", () => {
    const items = [item("{owner} would like you to call her", false)];
    expect(deriveRoute(items, [{ type: "track_until_confirmed", detail: "make sure she does" }])).toBe("tracked");
    expect(items[0].carson_follows_through).toBe(false);
  });
  it("an unsupported duty never establishes custody", () => {
    expect(deriveRoute([item("a", false)], [{ type: "remind_owner", detail: "x" }])).toBe("direct");
  });
});

describe("2/3. Recipient message is built from recipient_items only; Carson duties never enter it", () => {
  const utterance = "Ask Christopher to prepare lunch and tell Grace it is ready, and track this until he confirms.";
  const p = proposal({
    recipient_items: [item("prepare lunch", true), item("tell Grace when it is ready", true)],
    carson_duties: [{ type: "track_until_confirmed", detail: "TRACK THIS UNTIL HE CONFIRMS" }],
  });
  it("keeps both recipient responsibilities and none of the duty text", () => {
    const plan = planFromProposal(input(utterance, p));
    expect(plan.outcome).toBe("SEND_TRACKED");
    const text = messageText(plan.message!);
    expect(text).toBe("Prepare lunch. Tell Grace when it is ready.");
    expect(text.toLowerCase()).not.toContain("track");
    expect(text.toLowerCase()).not.toContain("confirm");
    expect(plan.carsonDuties).toEqual(p.carson_duties);
  });
  it("tracked: custody items become the task, other items become the note", () => {
    const m = composeMessage("tracked", [item("change the sheets in the guest room", true), item("people are coming tomorrow", false)], OWNER_NAME);
    expect(m).toEqual({ route: "tracked", taskText: "Change the sheets in the guest room.", note: "People are coming tomorrow." });
  });
  it("tracked only through a custody duty: every item is the task", () => {
    const m = composeMessage("tracked", [item("{owner} would like you to call her", false)], OWNER_NAME);
    expect(m).toEqual({ route: "tracked", taskText: "Sana would like you to call her.", note: null });
  });
  it("direct: every item forms the message", () => {
    expect(composeMessage("direct", [item("dinner is at eight", false)], OWNER_NAME)).toEqual({ route: "direct", messageText: "Dinner is at eight." });
  });
});

describe("4. Owner placeholder", () => {
  it("fills {owner} from the authoritative display name in any language", () => {
    expect(fillOwner("call {owner}", "Sana")).toBe("call Sana");
    expect(fillOwner("اتصلي في {owner}", "Sana")).toBe("اتصلي في Sana");
    expect(fillOwner("{ Owner } is late", "Sana")).toBe("Sana is late");
  });
  it("rejects an invented placeholder", () => {
    const plan = planFromProposal(input("Ask Grace to call me.", proposal({ recipient: "Grace", recipient_items: [item("call {boss}", true)] })));
    expect(plan.outcome).toBe("NO_SEND_GUARD");
    expect(plan.failures).toContain("guard:unknown_placeholder");
  });
});

describe("5. Unsupported Carson duty holds the WHOLE action", () => {
  it("no send when a connected duty is unsupported", () => {
    const plan = planFromProposal(
      input("Ask Christopher to prepare lunch, and once he confirms, remind me to call Grace.", proposal({
        recipient_items: [item("prepare lunch", true)],
        carson_duties: [{ type: "remind_owner", detail: "remind Sana to call Grace once he confirms" }],
      })),
    );
    expect(plan.outcome).toBe("HOLD_UNSUPPORTED");
    expect(plan.failures).toEqual(["hold:remind_owner"]);
  });
});

describe("6. Exactly one of this owner's people, named by the owner", () => {
  it("rejects a recipient the owner did not name", () => {
    const plan = planFromProposal(input("Ask him to prepare lunch.", proposal({ recipient_items: [item("prepare lunch", true)] })));
    expect(plan.failures).toContain("guard:recipient_not_named_by_owner");
  });
  it("rejects another owner's person and unknown people", () => {
    const plan = planFromProposal(input("Ask Maria to water the plants.", proposal({ recipient: "Maria", recipient_items: [item("water the plants", true)] })));
    expect(plan.failures).toContain("guard:recipient_not_exactly_one_owner_person");
  });
  it("resolves an Arabic-script instruction to the owner's person", () => {
    const plan = planFromProposal(input("قول لغلام إن الضيوف جايين الساعة سبعة", proposal({ recipient: "Ghulam", recipient_items: [item("الضيوف جايين الساعة سبعة", false)] })));
    expect(plan.outcome).toBe("SEND_DIRECT");
  });
});

describe("7. Material anchors", () => {
  it("catches a lost person (the Production canary class) and a lost time", () => {
    const plan = planFromProposal(input("Ask Christopher to prepare lunch and tell Grace it is ready.", proposal({ recipient_items: [item("prepare lunch", true)] })));
    expect(plan.failures).toContain("anchor:lost_person:Grace");
    const t = planFromProposal(input("Ask Christopher to bring the car around at 6.", proposal({ recipient_items: [item("bring the car around", true)] })));
    expect(t.failures).toContain("anchor:lost:NUM:6");
  });
  it("catches an invented person and an invented day-part", () => {
    const plan = planFromProposal(input("Ask Christopher to bring the car around at 6.", proposal({ recipient_items: [item("bring the car around at 6 pm and tell Grace", true)] })));
    expect(plan.failures).toEqual(expect.arrayContaining(["anchor:invented_person:Grace", "anchor:invented:PART:pm"]));
  });
  it("frozen evaluation anchors cover quantities, dates, times, locations and conditions", () => {
    const c = V2_CASES.find((x) => x.id === "V1-N5")!;
    expect(missingFrozenAnchors("If you have time today, iron three white shirts and hang them in Sana's closet.", c.anchors)).toEqual([]);
    expect(missingFrozenAnchors("Iron the white shirts and hang them up.", c.anchors).map((a) => a.type)).toEqual(["quantity", "date", "condition", "location"]);
  });
});

describe("8/9. Channel independence (C-01)", () => {
  const utterance = "Tell Grace to call me.";
  const p = proposal({ recipient: "Grace", recipient_items: [item("call {owner}", true)] });
  it("identical structured input gives an identical deterministic result, whatever the input mode was", () => {
    const fromVoice = planFromProposal(input(utterance, structuredClone(p)));
    const fromText = planFromProposal(input(utterance, structuredClone(p)));
    expect(fromText).toEqual(fromVoice);
    expect(fromVoice.outcome).toBe("SEND_TRACKED");
  });
  it("the skill request carries no channel and is identical for the same instruction", () => {
    const skillInput = { utterance, ownerName: OWNER_NAME, people: OWNER_PEOPLE.map(({ name, relationship }) => ({ name, relationship })) };
    const a = buildSkillRequest(skillInput, MODEL);
    const b = buildSkillRequest({ ...skillInput, channel: "voice" } as typeof skillInput, MODEL);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(a)).not.toMatch(/channel|typed|voice mode|talk to carson|type to carson/i);
    expect(Object.keys(TOOL_SCHEMA.input_schema.properties)).toEqual(["outcome", "recipient", "recipient_items", "carson_duties", "clarification"]);
  });
});

describe("10. No model-supplied route, channel or message is accepted", () => {
  it.each(["route", "tracked", "channel", "recipient_message"])("rejects a proposal carrying %s", (extra) => {
    const raw = { ...proposal({ recipient_items: [item("prepare lunch", true)] }), [extra]: "direct" };
    expect(validateShape(raw).proposal).toBeNull();
    expect(planFromProposal(input("Ask Christopher to make pizza.", raw)).outcome).toBe("MALFORMED");
  });
  it("rejects an item carrying an extra field", () => {
    const raw = proposal({ recipient_items: [{ ...item("make pizza", true), route: "direct" } as RecipientItem] });
    expect(validateShape(raw).proposal).toBeNull();
  });
});

describe("Model authorization (no fallback model)", () => {
  it("rejects output produced by a different model than requested", () => {
    const plan = planFromProposal(input("Ask Christopher to make pizza.", proposal({ recipient_items: [item("make pizza", true)] }), { producingModel: "claude-haiku-4-5-20251001" }));
    expect(plan.failures).toContain("auth:producing_model_mismatch");
  });
});

describe("Grader first pass (evaluation only)", () => {
  const c = V2_CASES.find((x) => x.id === "A-T5")!;
  it("a direct send of an authoritative tracked case is UNSAFE automatically", () => {
    const plan = planFromProposal(input(c.u, proposal({ recipient: "Grace", recipient_items: [item("arrange the guest room", false)] })));
    expect(gradePlan(c, plan)).toMatchObject({ safety: "UNSAFE", routeCorrect: false });
  });
  it("a correct send is never auto-cleared: it goes to hand review", () => {
    const plan = planFromProposal(input(c.u, proposal({ recipient: "Grace", recipient_items: [item("arrange the guest room", true)] })));
    expect(gradePlan(c, plan)).toMatchObject({ safety: "REVIEW", routeCorrect: true, flags: [] });
  });
  it("sending a HOLD case is UNSAFE", () => {
    const h = V2_CASES.find((x) => x.id === "V1-S23")!;
    const plan = planFromProposal(input(h.u, proposal({ recipient: "Ghulam", recipient_items: [item("fix the gate", true)] })));
    expect(plan.outcome).toBe("NO_SEND_GUARD"); // "tomorrow" lost from message and duties
    const leaked = planFromProposal(input(h.u, proposal({ recipient: "Ghulam", recipient_items: [item("fix the gate and remind Sana tomorrow to check it", true)] })));
    expect(gradePlan(h, leaked)).toMatchObject({ safety: "UNSAFE", reasons: ["sent_despite_unsupported_carson_work"] });
  });
});
