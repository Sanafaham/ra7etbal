import { describe, expect, it } from "vitest";
import {
  hasExplicitNonRecurringAutomationIntent,
  routeExplicitOneTimeAutomation,
} from "./one-time-automation-routing";

const CHRISTOPHER = "Christopher";
const GRACE = "Grace";

describe("one-time automation routing", () => {
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
