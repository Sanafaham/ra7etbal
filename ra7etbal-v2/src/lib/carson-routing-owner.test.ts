import { describe, expect, it } from "vitest";
import {
  retainCarsonRoutingOwner,
  routingOwnerAllowsPeopleAction,
  selectCarsonRoutingOwner,
} from "./carson-routing-owner";

const PEOPLE = [{ name: "Christopher" }, { name: "Grace" }];

describe("Carson canonical routing owner", () => {
  it("owns the exact production transcript as Hosting", () => {
    const owner = selectCarsonRoutingOwner({
      utterance: "I have dinner at home tomorrow. Handle it.",
      people: PEOPLE,
    });
    expect(owner.intent).toBe("hosting");
    expect(routingOwnerAllowsPeopleAction(owner)).toBe(false);
  });

  it("does not let a delegation transcript become Hosting", () => {
    const owner = selectCarsonRoutingOwner({
      utterance: "Ask Christopher to buy olive oil tomorrow.",
      people: PEOPLE,
    });
    expect(owner.intent).toBe("delegation");
    expect(routingOwnerAllowsPeopleAction(owner)).toBe(true);
  });

  it.each([
    "Tell Christopher the delivery is approved.",
    "Ask Christopher to reply that we will proceed.",
  ])("keeps genuine people-directed request %j in the People capability", (utterance) => {
    const owner = selectCarsonRoutingOwner({ utterance, people: PEOPLE });
    expect(routingOwnerAllowsPeopleAction(owner)).toBe(true);
    expect(owner.intent).not.toBe("hosting");
  });

  it("retains one owner across multiple downstream tool selections", () => {
    const first = selectCarsonRoutingOwner({
      utterance: "I have dinner at home tomorrow. Handle it.",
      people: PEOPLE,
    });
    const second = retainCarsonRoutingOwner(first, {
      utterance: "I have dinner at home tomorrow. Handle it.",
      people: [],
      hasActiveHostingClarification: false,
    });
    expect(second).toBe(first);
    expect(second.intent).toBe("hosting");
  });
});
