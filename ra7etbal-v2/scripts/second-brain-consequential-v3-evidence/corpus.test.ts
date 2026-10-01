import { describe, expect, it } from "vitest";
import { V3_CASES, V3_EXCLUSIONS } from "./corpus";

const REQUIRED_TRACKED = [
  "Ask Grace to call me.",
  "Tell Grace to call me.",
  "Ask Grace to call me now.",
  "Ask Grace to call me from the office.",
  "Tell Grace to arrange the guest room.",
  "Ask Christopher to bring the car around at 6.",
  "Ask Christopher to make pizza.",
  "Ask Christopher to clean the kitchen.",
  "Ask Ghulam to bring the car out.",
  "Ask Loulya to pick up the dry cleaning.",
  "Tell Loulya I would like her to call me and make sure she does.",
  "Ask Loulya to call me and make sure she does.",
  "Tell Nasira to wait until 8 and then clean the kitchen.",
  "Ask Christopher to prepare lunch and tell Grace it is ready, and track this until he confirms.",
];
const REQUIRED_DIRECT = [
  "Tell Loulya I would like her to call me.",
  "Ask Loulya to call me.",
  "Tell Christopher dinner is at 8.",
  "Ask Christopher to meet me outside.",
  "Tell Christopher to wait for me in the kitchen.",
  "Tell Nasira to wait until 8.",
];

describe("V3 frozen truth set integrity", () => {
  it("ids and instructions are unique", () => {
    expect(new Set(V3_CASES.map((c) => c.id)).size).toBe(V3_CASES.length);
    expect(new Set(V3_CASES.map((c) => c.u)).size).toBe(V3_CASES.length);
  });

  it.each(REQUIRED_TRACKED.map((u) => [u, "tracked"]).concat(REQUIRED_DIRECT.map((u) => [u, "direct"])))("required case %j → %s, critical", (u, route) => {
    const c = V3_CASES.find((x) => x.u === u);
    expect(c).toBeDefined();
    expect(c!.critical).toBe(true);
    expect(c!.expected.outcome).toBe("SEND");
    expect((c!.expected as { route: string }).route).toBe(route);
  });

  it("the authoritative compound freezes both responsibilities, the explicit track instruction and the forbidden tracking text", () => {
    const c = V3_CASES.find((x) => x.id === "A-C1")!;
    const e = c.expected as Extract<typeof c.expected, { outcome: "SEND" }>;
    expect(e.responsibilities.map((r) => r.nature)).toEqual(["operational_outcome", "operational_outcome"]);
    expect(e.instructions[0]).toContain("track");
    expect(c.forbidden).toContain("track");
  });

  it("every non-clarify case freezes a recipient and at least one responsibility with a nature", () => {
    for (const c of V3_CASES) {
      expect(["en", "ar", "mixed"]).toContain(c.lang);
      if (c.expected.outcome === "CLARIFY") expect(c.expected.reason).toBeTruthy();
      else {
        expect(c.expected.recipient).toBeTruthy();
        expect(c.expected.responsibilities.length).toBeGreaterThan(0);
      }
    }
  });

  it("exclusions are recorded and none is in the acceptance set", () => {
    expect(V3_EXCLUSIONS.map((x) => x.id)).toEqual(["S12", "U2", "A5", "WISH-STAFF"]);
    for (const x of V3_EXCLUSIONS) expect(V3_CASES.some((c) => c.u === x.u)).toBe(false);
    expect(V3_CASES.some((c) => /tomorrow morning, ask|put it in my calendar|christopher and grace|i need her to call me/i.test(c.u))).toBe(false);
  });

  it("frozen corpus counts", () => {
    const n = (f: (c: (typeof V3_CASES)[number]) => boolean) => V3_CASES.filter(f).length;
    expect({
      total: V3_CASES.length,
      en: n((c) => c.lang === "en"), ar: n((c) => c.lang === "ar"), mixed: n((c) => c.lang === "mixed"),
      sendTracked: n((c) => c.expected.outcome === "SEND" && c.expected.route === "tracked"),
      sendDirect: n((c) => c.expected.outcome === "SEND" && c.expected.route === "direct"),
      hold: n((c) => c.expected.outcome === "HOLD"),
      clarify: n((c) => c.expected.outcome === "CLARIFY"),
      sendOrClarify: n((c) => c.expected.outcome === "SEND_OR_CLARIFY"),
      compound: n((c) => c.compound), simple: n((c) => !c.compound),
      critical: n((c) => c.critical),
    }).toEqual(FROZEN_COUNTS);
  });
});

// Frozen numbers — a change here means the truth set changed.
const FROZEN_COUNTS = {
  total: 94, en: 81, ar: 9, mixed: 4, sendTracked: 63, sendDirect: 23, hold: 4, clarify: 2, sendOrClarify: 2, compound: 47, simple: 47, critical: 39,
};
