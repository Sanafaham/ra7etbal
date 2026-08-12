import { describe, expect, it } from "vitest";
import {
  claimFreshRoutingTurn,
  hasExplicitNonRecurringAutomationIntent,
  routeExplicitOneTimeAutomation,
} from "./one-time-automation-routing";

const CHRISTOPHER = "Christopher";
const GRACE = "Grace";

describe("one-time automation routing", () => {
  it("routes a scheduled delegation without requiring the word automation", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Tomorrow at 7, ask Christopher to confirm the documents.",
        reminder: { description: "Confirm the documents", time_text: "tomorrow at 7" },
        knownPeopleNames: [CHRISTOPHER],
      }),
    ).toMatchObject({ kind: "automation", params: { assignee_name: CHRISTOPHER } });
  });

  it("keeps an explicit remind-me request owner-directed", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Remind me tomorrow at 7 to ask Christopher about the menu.",
        reminder: { description: "Ask Christopher about the menu", time_text: "tomorrow at 7" },
        knownPeopleNames: [CHRISTOPHER],
      }),
    ).toEqual({ kind: "reminder" });
  });

  it("fails closed when a tool callback arrives before the current transcript", () => {
    expect(claimFreshRoutingTurn(null)).toEqual({
      ok: false,
      reasonCode: "fresh_transcript_unavailable",
    });
  });

  it("claims the current transcript once and rejects a later callback from the same turn", () => {
    const first = claimFreshRoutingTurn({
      eventId: 7,
      message: "Ask Christopher tomorrow at 7.",
      claimed: false,
      operationId: "4c438c39-7b8f-43f6-9085-0b4b64905bf8",
    });
    expect(first).toMatchObject({ ok: true, message: "Ask Christopher tomorrow at 7." });
    if (!first.ok) throw new Error("expected a routing turn claim");
    expect(claimFreshRoutingTurn(first.context)).toEqual({ ok: false, reasonCode: "turn_already_claimed" });
  });
  it("routes an explicit one-time Christopher automation to create_automation inputs", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage:
          "Create a one-time automation to send Christopher a task at 6:30 AM.",
        reminder: {
          description: "Confirm the production verification",
          time_text: "today at 6:30 AM",
        },
        knownPeopleNames: [CHRISTOPHER, GRACE],
      }),
    ).toEqual({
      kind: "automation",
      params: {
        title: "Confirm the production verification",
        instruction: "Confirm the production verification",
        cadence_phrase: "once",
        first_run_text: "today at 6:30 AM",
        assignee_name: CHRISTOPHER,
      },
    });
  });

  it("treats explicit automation intent as authoritative without recurrence wording", () => {
    expect(
      hasExplicitNonRecurringAutomationIntent(
        "Set up an automation for tomorrow at 9 AM to ask Grace to confirm delivery.",
      ),
    ).toBe(true);
  });

  it("fails closed when an explicit automation recipient is not an exact household contact", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create an automation to send Unknown Person a task at 6:30 AM.",
        reminder: { description: "Confirm X", time_text: "at 6:30 AM" },
        knownPeopleNames: [CHRISTOPHER, GRACE],
      }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("does not match Ann inside the unrelated word automation", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create an automation to send Unknown a task at 6:30 AM.",
        reminder: { description: "Confirm X", time_text: "at 6:30 AM" },
        knownPeopleNames: ["Ann"],
      }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("does not match Ana inside a larger unrelated token", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create an automation to send Bananas a task at 6:30 AM.",
        reminder: { description: "Confirm X", time_text: "at 6:30 AM" },
        knownPeopleNames: ["Ana"],
      }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("prefers the longest exact household name when mentions overlap", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create an automation to ask Ali Hassan to confirm at 6:30 AM.",
        reminder: { description: "Confirm X", time_text: "at 6:30 AM" },
        knownPeopleNames: ["Ali", "Ali Hassan"],
      }),
    ).toMatchObject({
      kind: "automation",
      params: { assignee_name: "Ali Hassan" },
    });
  });

  it("resolves Christopher as a complete case-insensitive mention", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create an automation to ask cHrIsToPhEr to confirm at 6:30 AM.",
        reminder: { description: "Confirm X", time_text: "at 6:30 AM" },
        knownPeopleNames: [CHRISTOPHER],
      }),
    ).toMatchObject({
      kind: "automation",
      params: { assignee_name: CHRISTOPHER },
    });
  });

  it("allows normal possessive punctuation after Grace", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create an automation to send Grace's task at 6:30 AM.",
        reminder: { description: "Send the task", time_text: "at 6:30 AM" },
        knownPeopleNames: [GRACE],
      }),
    ).toMatchObject({
      kind: "automation",
      params: { assignee_name: GRACE },
    });
  });

  it("supports Unicode names, spaces, apostrophes, and hyphens as exact mentions", () => {
    for (const name of ["نور الهدى", "D'Arcy", "Anne-Marie"]) {
      expect(
        routeExplicitOneTimeAutomation({
          latestUserMessage: `Create an automation to ask ${name} to confirm at 6:30 AM.`,
          reminder: { description: "Confirm X", time_text: "at 6:30 AM" },
          knownPeopleNames: [name],
        }),
      ).toMatchObject({ kind: "automation", params: { assignee_name: name } });
    }
  });

  it("fails closed for a misspelled recipient instead of using fuzzy matching", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create an automation to ask Christofer to confirm at 6:30 AM.",
        reminder: { description: "Confirm X", time_text: "at 6:30 AM" },
        knownPeopleNames: [CHRISTOPHER],
      }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("fails closed instead of creating a reminder when the automation run time is missing", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create a one-time automation to ask Christopher to confirm X.",
        reminder: { description: "Confirm X" },
        knownPeopleNames: [CHRISTOPHER],
      }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("preserves an exact ISO fallback without asking the automation parser to reinterpret it", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create a one-time automation to ask Christopher to confirm X.",
        reminder: { description: "Confirm X", due_at: "2026-08-12T03:30:00.000Z" },
        knownPeopleNames: [CHRISTOPHER],
      }),
    ).toMatchObject({
      kind: "automation",
      params: { first_run_at: "2026-08-12T03:30:00.000Z", cadence_phrase: "once" },
    });
  });

  it("keeps a genuine owner reminder as a reminder even when its text mentions Christopher", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Remind me at 6:30 AM to call Christopher.",
        reminder: { description: "Call Christopher", time_text: "at 6:30 AM" },
        knownPeopleNames: [CHRISTOPHER],
      }),
    ).toEqual({ kind: "reminder" });
  });

  it("does not intercept recurring automation wording from the existing recurring path", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Create an automation to ask Christopher every day at 6:30 AM.",
        reminder: { description: "Confirm X", time_text: "at 6:30 AM" },
        knownPeopleNames: [CHRISTOPHER],
      }),
    ).toEqual({ kind: "reminder" });
  });

  it("keeps immediate delegations outside the automation redirect", () => {
    expect(
      routeExplicitOneTimeAutomation({
        latestUserMessage: "Ask Christopher now to confirm X.",
        reminder: { description: "Confirm X", time_text: "now" },
        knownPeopleNames: [CHRISTOPHER],
      }),
    ).toEqual({ kind: "reminder" });
  });
});
