import { describe, expect, it } from "vitest";
import { extractConstraints, validateProposal } from "./guards";
import type { Proposal } from "./skill";

const MODEL = "claude-sonnet-4-6";
function run(utterance: string, p: Partial<Proposal>, produced = MODEL) {
  const proposal: Proposal = {
    capability: "tracked_delegation",
    recipient: "Christopher",
    recipient_message: "",
    report_back_to_owner: false,
    unsupported_carson_request: null,
    reason: null,
    clarification_question: null,
    ...p,
  };
  return validateProposal({ proposal, utterance, requestedModel: MODEL, producingModel: produced });
}

describe("second-brain consequential dry-run guards", () => {
  it("passes a faithful tracked proposal", () => {
    const g = run("Ask Christopher to prepare lunch and tell Grace it is ready.", {
      recipient_message: "Please prepare lunch and tell Grace when it's ready.",
    });
    expect(g.outcome).toBe("WOULD_SEND");
  });

  it("catches the Production failure: Grace silently lost", () => {
    const g = run("Ask Christopher to prepare lunch and tell Grace it is ready.", { recipient_message: "Prepare lunch." });
    expect(g.outcome).toBe("NO_SEND_GUARD");
    expect(g.failures).toContain("G5_person_lost:Grace");
  });

  it("catches an invented person and an invented time", () => {
    const g = run("Ask Christopher to bring the car around at 6.", { recipient_message: "Bring the car around at 6 PM and tell Grace." });
    expect(g.failures).toEqual(expect.arrayContaining(["G4_invented_person:Grace", "G6_constraint_invented:PART:pm"]));
  });

  it("treats eight, 8 and الثامنة as the same constraint", () => {
    expect(run("Tell Christopher dinner is at eight.", { capability: "direct_communication", recipient_message: "Dinner is at 8." }).outcome).toBe("WOULD_SEND");
    expect([...extractConstraints("العشاء الساعة الثامنة")]).toEqual(["NUM:8"]);
    expect([...extractConstraints("يوم الاثنين")]).toEqual(["DAY:monday"]);
  });

  it("catches a lost time", () => {
    expect(run("Ask Christopher to bring the car around at 6.", { recipient_message: "Bring the car around." }).failures).toContain("G6_constraint_lost:NUM:6");
  });

  it("rejects a recipient the owner did not name, an unknown person, and another owner's person", () => {
    expect(run("Ask him to prepare lunch.", { recipient_message: "Prepare lunch." }).failures).toContain("G3_recipient_not_named_by_owner");
    expect(run("Ask Maria to water the plants.", { recipient: "Maria", recipient_message: "Water the plants." }).failures).toContain("G3_recipient_not_exactly_one_owner_person");
  });

  it("resolves Arabic-script names", () => {
    const g = run("اطلب من كريستوفر أن يحضر الغداء ويخبر غريس أنه جاهز.", { recipient_message: "حضّر الغداء وأخبر غريس أنه جاهز." });
    expect(g.outcome).toBe("WOULD_SEND");
  });

  it("direct communication cannot carry tracked semantics", () => {
    expect(run("Tell Grace I'm running late.", { capability: "direct_communication", recipient: "Grace", recipient_message: "Sana is running late.", report_back_to_owner: true }).failures).toContain("G7_direct_with_tracked_semantics");
  });

  it("materially connected unsupported Carson work holds the whole action", () => {
    const g = run("Ask Christopher to prepare lunch, and once he confirms, remind me to call Grace.", {
      recipient_message: "Please prepare lunch.",
      unsupported_carson_request: "Remind Sana to call Grace once Christopher confirms.",
    });
    expect(g.outcome).toBe("HOLD_UNSUPPORTED");
  });

  it("rejects a run produced by a different model than requested (no silent cascade)", () => {
    expect(run("Ask Christopher to make pizza.", { recipient_message: "Please make pizza." }, "claude-haiku-4-5-20251001").failures).toContain("G1_producing_model_mismatch");
  });

  it("does not treat 'I am', 'the one near' or 'now coming' as constraints", () => {
    expect([...extractConstraints("I am running late, try the one near the mosque, they are now coming")]).toEqual([]);
  });
});
