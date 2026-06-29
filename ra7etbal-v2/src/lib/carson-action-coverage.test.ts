import { describe, expect, it } from "vitest";
import {
  checkDelegationCoverage,
  extractExpectedDelegationCandidates,
  findMissingDelegationCandidates,
  type ExecutedDelegationRecord,
} from "./carson-action-coverage";
import type { Person } from "../types/person";

const people = [
  person("Grace"),
  person("Ghulam"),
  person("Christopher"),
  person("Loulya"),
];

describe("carson-action-coverage delegation candidate extraction", () => {
  it("extracts a Ghulam delegation candidate", () => {
    const result = extractExpectedDelegationCandidates(
      "Ask Ghulam to have the cars clean and ready by 8 AM.",
      people,
    );

    expect(result).toEqual([
      {
        personName: "Ghulam",
        actionText: "have the cars clean and ready by 8 AM",
        sourceSpan: "Ask Ghulam to have the cars clean and ready by 8 AM",
        confidence: "high",
      },
    ]);
  });

  it("extracts Grace and Ghulam from one transcript", () => {
    const result = extractExpectedDelegationCandidates(
      "Ask Grace to send the flowers and ask Ghulam to have the cars clean and ready by 8 AM.",
      people,
    );

    expect(result.map((candidate) => candidate.personName)).toEqual(["Grace", "Ghulam"]);
    expect(result.map((candidate) => candidate.actionText)).toEqual([
      "send the flowers",
      "have the cars clean and ready by 8 AM",
    ]);
  });

  it("ignores non-delegation mentions of people", () => {
    const result = extractExpectedDelegationCandidates(
      "Tell Ghulam dinner is at 9 and Grace is already aware.",
      people,
    );

    expect(result).toEqual([]);
  });

  it("handles practical English command variants and leaves Arabic-only phrasing out of scope", () => {
    const result = extractExpectedDelegationCandidates(
      "Please make sure Ghulam cleans the cars. خليه يجهز السيارة.",
      people,
    );

    expect(result).toEqual([
      {
        personName: "Ghulam",
        actionText: "cleans the cars",
        sourceSpan: "make sure Ghulam cleans the cars",
        confidence: "medium",
      },
    ]);
  });
});

describe("carson-action-coverage missing delegation detection", () => {
  it("detects missing Ghulam when executed records omit him", () => {
    const expected = extractExpectedDelegationCandidates(
      "Ask Grace to send the flowers and ask Ghulam to have the cars clean and ready by 8 AM.",
      people,
    );
    const executed: ExecutedDelegationRecord[] = [
      { type: "delegation", personName: "Grace", actionText: "send the flowers", status: "sent" },
    ];

    const missing = findMissingDelegationCandidates(expected, executed);

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      personName: "Ghulam",
      actionText: "have the cars clean and ready by 8 AM",
    });
  });

  it("does not flag Ghulam when an executed record exists", () => {
    const result = checkDelegationCoverage(
      "Ask Ghulam to have the cars clean and ready by 8 AM.",
      people,
      [
        {
          type: "delegation",
          personName: "Ghulam",
          actionText: "cars clean and ready by 8 AM",
          status: "sent",
        },
      ],
    );

    expect(result.missing).toEqual([]);
  });

  it("does not create duplicates or mutate inputs", () => {
    const expected = extractExpectedDelegationCandidates(
      "Ask Ghulam to clean the cars.",
      people,
    );
    const executed: ExecutedDelegationRecord[] = [];
    const beforeExpected = structuredClone(expected);
    const beforeExecuted = structuredClone(executed);

    const first = findMissingDelegationCandidates(expected, executed);
    const second = findMissingDelegationCandidates(expected, executed);

    expect(first).toEqual(second);
    expect(expected).toEqual(beforeExpected);
    expect(executed).toEqual(beforeExecuted);
  });
});

function person(name: string): Pick<Person, "name"> {
  return { name };
}
