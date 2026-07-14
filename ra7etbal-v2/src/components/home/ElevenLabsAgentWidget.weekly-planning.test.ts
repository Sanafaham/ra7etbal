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
 * Carson Weekly Planning V1 — "Carson, organize my week." Reuses
 * execute_instruction (the same tool both voice and typed Carson already
 * call) rather than a new tool, and reuses the propose → single approval →
 * execute state machine already built for Operations Intelligence
 * (carson_pending_operations, resolvePendingPlanDecision).
 */
describe("ElevenLabsAgentWidget — Carson Weekly Planning V1", () => {
  it("detects weekly-planning intent inside execute_instruction, not a separate tool", () => {
    expect(SOURCE).toContain("if (detectWeeklyPlanningIntent(rawInstruction)) {");
    expect(SOURCE).not.toContain("plan_week:");
    expect(SOURCE).not.toContain("organize_week:");
  });

  it("requires Google Calendar to be connected before proposing a plan", () => {
    const block = blockBetween(
      "if (detectWeeklyPlanningIntent(rawInstruction)) {",
      "const tasksState = useTasksStore.getState();",
    );
    expect(block).toContain("if (!calendarFetchedRef.current)");
    expect(block).toContain("Settings");
  });

  it("the confirmation/rejection/retry check for a pending week plan runs before the guest-arrival no-active-plan guard, so a 'yes' for a week plan is never swallowed", () => {
    const weekBlockIndex = SOURCE.indexOf("let activeWeekPlan = pendingWeekPlanRef.current;");
    const guestGuardIndex = SOURCE.indexOf("Guard: a confirmation/rejection with no active plan");
    expect(weekBlockIndex).toBeGreaterThan(-1);
    expect(guestGuardIndex).toBeGreaterThan(-1);
    expect(weekBlockIndex).toBeLessThan(guestGuardIndex);
  });

  it("no calendar event is created before an explicit approval — execution only happens inside the confirm branch", () => {
    const block = blockBetween(
      "if (activeWeekPlan) {",
      "// A short-window retry re-attempts only the events that failed last",
    );
    expect(block).toMatch(/pendingDecision === "confirm"\)\s*\{[\s\S]*executeWeekPlan\(activeWeekPlan\)/);
    expect(block).not.toMatch(/executeWeekPlan\(activeWeekPlan\)[\s\S]*pendingDecision === "confirm"/);
  });

  it("rejection cancels without creating anything", () => {
    const block = blockBetween(
      "if (activeWeekPlan) {",
      "// A short-window retry re-attempts only the events that failed last",
    );
    expect(block).toContain('pendingDecision === "reject"');
    expect(block).toContain("rejectWeekPlan(activeWeekPlan)");
  });

  it("retry re-attempts only failed events from the last execution, passing prior results so successes are never recreated", () => {
    const block = blockBetween(
      "// A short-window retry re-attempts only the events that failed last",
      "// Guard: a confirmation/rejection with no active plan",
    );
    expect(block).toContain("isWeekPlanRetryRequest(rawInstruction)");
    expect(block).toContain("executeWeekPlan(lastExecution.plan, lastExecution.results)");
  });

  it("gates a retry to only when the last execution actually had a failure", () => {
    const block = blockBetween(
      "// A short-window retry re-attempts only the events that failed last",
      "// Guard: a confirmation/rejection with no active plan",
    );
    expect(block).toMatch(/hasFailure\s*=\s*lastExecution\?\.results\.some\(\(r\) => r\.status !== "created"\)/);
  });

  it("executes via the shared weekly-planning module — post-creation verification and truthful reporting are not duplicated inline", () => {
    expect(SOURCE).toContain('from "../../lib/weekly-planning"');
    // The widget never calls the raw calendar create API directly for a week
    // plan — only executeWeekPlan (which re-reads and verifies internally).
    const proposeBlock = blockBetween(
      "if (detectWeeklyPlanningIntent(rawInstruction)) {",
      "// ── Recurring-language detection ──",
    );
    expect(proposeBlock).not.toContain("callCalendarApi(");
  });

  it("proposal building reads real Ra7etBal state (todos, needs-attention, waiting, automations, household rules, persistent memory), not just the calendar", () => {
    const block = blockBetween(
      "if (detectWeeklyPlanningIntent(rawInstruction)) {",
      "if (result.status === \"clarification_needed\")",
    );
    expect(block).toContain("listActiveTodos(");
    expect(block).toContain("buildDailyBrief(tasks");
    expect(block).toContain("getHouseholdRules()");
    expect(block).toContain("fetchAutomationDigest()");
    expect(block).toContain("loadPersistentMemory()");
    expect(block).toContain('filterCalendarEventsByRange(planningCalendarEventsRef.current, "next_7_days")');
  });

  it("a clarification question is returned as-is, without proposing or creating anything", () => {
    const block = blockBetween(
      "if (result.status === \"clarification_needed\")",
      "if (result.status === \"no_plan\")",
    );
    expect(block).toContain("return result.question;");
  });

  it("the entire flow runs inside execute_instruction, shared unconditionally by voice and typed Carson (not gated on requestedChannel)", () => {
    const start = SOURCE.indexOf("let activeWeekPlan = pendingWeekPlanRef.current;");
    const end = SOURCE.indexOf("if (detectWeeklyPlanningIntent(rawInstruction)) {") + 200;
    const block = SOURCE.slice(start, end);
    expect(block).not.toMatch(/requestedChannel === "text"/);
    expect(block).not.toMatch(/requestedChannel === "voice"/);
  });
});
