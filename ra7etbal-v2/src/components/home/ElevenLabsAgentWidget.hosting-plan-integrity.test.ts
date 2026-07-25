import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/**
 * Confirmed production incident: Carson verbally proposed a two-person
 * hosting plan without ever persisting one via execute_instruction. When the
 * owner replied "Yes, and please coordinate the table setup...", the leading
 * "Yes," did not match the exact-match confirmation regex, pendingDecision
 * came back "hold", and — with no active plan — the whole compound reply
 * fell through to handleOperationalHostingTurn as a brand new hosting
 * request, producing an orphaned clarification instead of a truthful
 * "no plan to confirm" response.
 */
describe("ElevenLabsAgentWidget — hosting plan integrity guard (Guard C)", () => {
  it("the leading-confirmation guard runs before the fresh-request handleOperationalHostingTurn call", () => {
    // There is an earlier handleOperationalHostingTurn call for continuing an
    // ALREADY-active clarification draft (pendingOperationDraft) — that one
    // legitimately runs before this guard and is untouched by Guard C. The
    // guard must sit before the *next* call, the one that treats rawInstruction
    // as a brand new hosting request when nothing is pending.
    const guardIndex = SOURCE.indexOf("hasLeadingConfirmationLanguage(rawInstruction)");
    const freshRequestHostingTurnCallIndex = SOURCE.indexOf(
      "const operationTurn = await handleOperationalHostingTurn({",
      guardIndex,
    );
    expect(guardIndex).toBeGreaterThan(-1);
    expect(freshRequestHostingTurnCallIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(freshRequestHostingTurnCallIndex);
  });

  it("the guard sits after the existing exact-match confirmation/rejection ack, not before it", () => {
    const existingGuardIndex = SOURCE.indexOf(
      "Guard: a confirmation/rejection with no active plan",
    );
    const newGuardIndex = SOURCE.indexOf("hasLeadingConfirmationLanguage(rawInstruction)");
    expect(existingGuardIndex).toBeGreaterThan(-1);
    expect(newGuardIndex).toBeGreaterThan(existingGuardIndex);
  });

  it("only fires when there is no active plan and no active week plan", () => {
    expect(SOURCE).toContain(
      "if (!activePlan && !activeWeekPlan && hasLeadingConfirmationLanguage(rawInstruction)) {",
    );
  });

  it("returns a truthful restate request instead of a fabricated success or a fresh-request question", () => {
    const block = blockBetween(
      "hasLeadingConfirmationLanguage(rawInstruction)",
      "// ── Operations Intelligence — outcome leg",
    );
    expect(block).toContain("I don't have a saved plan to confirm. Please tell me the hosting plan again.");
    expect(block).not.toContain("handleOperationalHostingTurn(");
  });

  it("does not touch hosting execution, delivery, reminders, calendar, or typed routing", () => {
    const block = blockBetween(
      "// Guard: a compound reply that OPENS with confirmation language",
      "// ── Operations Intelligence — outcome leg",
    );
    expect(block).not.toContain("executeProposedPlan(");
    expect(block).not.toContain("sendWhatsAppTask");
    expect(block).not.toContain("createReminderTask");
    expect(block).not.toContain("TYPED_MODE_IS_ADVISORY_ONLY");
  });
});
