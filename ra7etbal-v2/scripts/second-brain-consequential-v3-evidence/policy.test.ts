import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { V3_CASES } from "./corpus";
import { decideCustody, POLICY_VERSION } from "./policy";
import type { InstructionType, Nature } from "./skill";

// Owner-approved authoritative examples as FROZEN FACT TUPLES (no model).
const OWNER_EXAMPLES: Array<[string, Nature[], InstructionType[], "tracked" | "direct"]> = [
  ["Ask Grace to call me.", ["operational_outcome"], [], "tracked"],
  ["Tell Grace to call me.", ["operational_outcome"], [], "tracked"],
  ["Ask Grace to call me now.", ["operational_outcome"], [], "tracked"],
  ["Ask Grace to call me from the office.", ["operational_outcome"], [], "tracked"],
  ["Tell Grace to arrange the guest room.", ["operational_outcome"], [], "tracked"],
  ["Ask Christopher to bring the car around at 6.", ["operational_outcome"], [], "tracked"],
  ["Ask Christopher to make pizza.", ["operational_outcome"], [], "tracked"],
  ["Ask Christopher to clean the kitchen.", ["operational_outcome"], [], "tracked"],
  ["Ask Ghulam to bring the car out.", ["operational_outcome"], [], "tracked"],
  ["Ask Loulya to pick up the dry cleaning.", ["operational_outcome"], [], "tracked"],
  ["Tell Loulya I would like her to call me and make sure she does.", ["personal_message"], ["make_sure"], "tracked"],
  ["Ask Loulya to call me and make sure she does.", ["personal_message"], ["make_sure"], "tracked"],
  ["Tell Nasira to wait until 8 and then clean the kitchen.", ["presence_coordination", "operational_outcome"], [], "tracked"],
  ["Ask Christopher to prepare lunch and tell Grace it is ready, and track this until he confirms.", ["operational_outcome", "operational_outcome"], ["track"], "tracked"],
  ["Tell Loulya I would like her to call me.", ["personal_message"], [], "direct"],
  ["Ask Loulya to call me.", ["personal_message"], [], "direct"],
  ["Tell Christopher dinner is at 8.", ["information"], [], "direct"],
  ["Ask Christopher to meet me outside.", ["presence_coordination"], [], "direct"],
  ["Tell Christopher to wait for me in the kitchen.", ["presence_coordination"], [], "direct"],
  ["Tell Nasira to wait until 8.", ["presence_coordination"], [], "direct"],
  ["Tell Ghulam to wait by the car for me.", ["presence_coordination"], [], "direct"],
  ["Christopher, come to the kitchen now.", ["presence_coordination"], [], "direct"],
  ["Tell Grace I'm running late.", ["information"], [], "direct"],
];

describe(`C-02 policy proof (${POLICY_VERSION}) — no model`, () => {
  it.each(OWNER_EXAMPLES)("%s -> %s", (_u, natures, instructions, route) => {
    const d = decideCustody(natures, instructions);
    expect(d.route).toBe(route);
    expect(d.hold).toBe(false);
  });

  it("every owner example above is also frozen in the corpus with the same route", () => {
    for (const [u, , , route] of OWNER_EXAMPLES) {
      const c = V3_CASES.find((x) => x.u === u);
      expect(c, u).toBeDefined();
      expect((c!.expected as { route: string }).route, u).toBe(route);
    }
  });

  it("reproduces the frozen route and hold status for EVERY corpus case, under every acceptable instruction alternative (100%)", () => {
    let checked = 0;
    for (const c of V3_CASES) {
      const e = c.expected;
      if (e.outcome === "CLARIFY") continue;
      const natures = e.responsibilities.map((r) => r.nature);
      const alternatives = e.instructions.length ? e.instructions.flatMap((group) => group.map((t) => [t])) : [[]];
      for (const instructions of alternatives) {
        const d = decideCustody(natures, instructions as InstructionType[]);
        expect(d.route, `${c.id} ${instructions}`).toBe(e.route);
        expect(d.hold, `${c.id} ${instructions}`).toBe(e.outcome === "HOLD");
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it("unsupported instructions hold the whole action; supported custody instructions never do", () => {
    for (const t of ["remind_owner", "act_on_condition", "contact_other_person", "change_calendar", "other"] as InstructionType[])
      expect(decideCustody(["operational_outcome"], [t])).toMatchObject({ hold: true, unsupported: [t] });
    for (const t of ["track", "follow_up", "make_sure", "confirm", "report_back"] as InstructionType[])
      expect(decideCustody(["information"], [t])).toMatchObject({ route: "tracked", hold: false });
  });
});

describe("Policy reads only extracted facts (protections 15/16)", () => {
  const source = readFileSync(join(__dirname, "policy.ts"), "utf-8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("takes exactly two inputs: natures and instruction types", () => {
    expect(decideCustody.length).toBe(2);
  });
  it("contains no relationship, wording, regex or phrase logic", () => {
    expect(code).not.toMatch(/relationship|staff|family|utterance|\.text\b|RegExp|\.test\(|\.match\(|includes\("(ask|tell)/i);
    expect(code).not.toMatch(/\/[^/\n]+\/[gimsuy]*\.test/);
    expect([...code.matchAll(/^import .*$/gm)].map((m) => m[0])).toEqual(['import type { InstructionType, Nature } from "./skill";']);
  });
});
