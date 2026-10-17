import { describe, expect, it } from "vitest";
import { V2_CASES, V2_EXCLUSIONS } from "./corpus";
import { deriveRoute } from "./plan";

const REQUIRED: Array<[string, "tracked" | "direct"]> = [
  ["Ask Grace to call me.", "tracked"],
  ["Tell Grace to call me.", "tracked"],
  ["Ask Grace to call me now.", "tracked"],
  ["Ask Grace to call me from the office.", "tracked"],
  ["Tell Grace to arrange the guest room.", "tracked"],
  ["Ask Christopher to bring the car around at 6.", "tracked"],
  ["Ask Christopher to make pizza.", "tracked"],
  ["Ask Christopher to clean the kitchen.", "tracked"],
  ["Tell Loulya I would like her to call me.", "direct"],
  ["Tell Christopher dinner is at eight.", "direct"],
  ["Ask Christopher to meet me outside.", "direct"],
  ["Tell Christopher to wait for me in the kitchen.", "direct"],
  ["Tell Loulya I would like her to call me, and make sure she does.", "tracked"],
  ["Ask Christopher to prepare lunch and tell Grace it is ready, and track this until he confirms.", "tracked"],
];

describe("V2 frozen truth set integrity", () => {
  it("ids and instructions are unique", () => {
    expect(new Set(V2_CASES.map((c) => c.id)).size).toBe(V2_CASES.length);
    expect(new Set(V2_CASES.map((c) => c.u)).size).toBe(V2_CASES.length);
  });

  it.each(REQUIRED)("contains the authoritative case %j with route %s, marked critical", (u, route) => {
    const c = V2_CASES.find((x) => x.u === u);
    expect(c).toBeDefined();
    expect(c!.critical).toBe(true);
    expect(c!.expected.outcome).toBe("SEND");
    expect((c!.expected as { route: string }).route).toBe(route);
  });

  it("the compound authoritative case freezes both recipient responsibilities and the Carson tracking duty", () => {
    const c = V2_CASES.find((x) => x.id === "A-C1")!;
    const e = c.expected as Extract<typeof c.expected, { outcome: "SEND" }>;
    expect(e.responsibilities.map((r) => r.meaning)).toEqual(["Christopher prepares lunch", "Christopher tells Grace when it is ready"]);
    expect(e.duties).toEqual([["track_until_confirmed"]]);
    expect(c.forbidden).toContain("track");
  });

  it("every frozen route is consistent with the C-02 combination rule applied to the frozen answers", () => {
    for (const c of V2_CASES) {
      const e = c.expected;
      if (e.outcome === "CLARIFY") continue;
      const custodyDuty = e.duties.map((alts) => ({ type: alts[0] }));
      expect(deriveRoute(e.responsibilities.map((r) => ({ carson_follows_through: r.carsonFollowsThrough })), custodyDuty), c.id).toBe(e.route);
    }
  });

  it("every case has a language, a recipient-bearing label or a clarification reason", () => {
    for (const c of V2_CASES) {
      expect(["en", "ar", "mixed"]).toContain(c.lang);
      if (c.expected.outcome === "CLARIFY") expect(c.expected.reason).toBeTruthy();
      else {
        expect(c.expected.recipient).toBeTruthy();
        expect(c.expected.responsibilities.length).toBeGreaterThan(0);
      }
    }
  });

  it("exclusions are recorded and none of them is in the acceptance set", () => {
    expect(V2_EXCLUSIONS.map((x) => x.id)).toEqual(["S12", "U2", "A5", "WISH-STAFF"]);
    for (const x of V2_EXCLUSIONS) expect(V2_CASES.some((c) => c.u === x.u)).toBe(false);
    expect(V2_CASES.some((c) => /tomorrow morning, ask|put it in my calendar|christopher and grace|i need her to call me/i.test(c.u))).toBe(false);
  });

  it("frozen corpus counts", () => {
    const count = (f: (c: (typeof V2_CASES)[number]) => boolean) => V2_CASES.filter(f).length;
    const summary = {
      total: V2_CASES.length,
      en: count((c) => c.lang === "en"),
      ar: count((c) => c.lang === "ar"),
      mixed: count((c) => c.lang === "mixed"),
      sendTracked: count((c) => c.expected.outcome === "SEND" && c.expected.route === "tracked"),
      sendDirect: count((c) => c.expected.outcome === "SEND" && c.expected.route === "direct"),
      hold: count((c) => c.expected.outcome === "HOLD"),
      clarify: count((c) => c.expected.outcome === "CLARIFY"),
      sendOrClarify: count((c) => c.expected.outcome === "SEND_OR_CLARIFY"),
      compound: count((c) => c.compound),
      simple: count((c) => !c.compound),
      critical: count((c) => c.critical),
    };
    // Frozen numbers — a change here means the truth set changed.
    expect(summary).toEqual({
      total: 84, en: 71, ar: 9, mixed: 4,
      sendTracked: 59, sendDirect: 17, hold: 4, clarify: 2, sendOrClarify: 2,
      compound: 35, simple: 49, critical: 29,
    });
  });
});
