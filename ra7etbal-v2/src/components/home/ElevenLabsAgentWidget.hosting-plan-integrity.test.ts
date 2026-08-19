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

/**
 * Confirmed second root cause on the same incident: when a persisted
 * hosting plan DOES execute or get cancelled via the activePlan branch,
 * lastDirectToolSuccessRef was never populated — so EL's own
 * separately-generated spoken reply for that turn was never checked
 * against the real tool outcome and could contradict it. Mirrors the
 * adjacent, already-correct Weekly Planning confirm branch.
 */
describe("ElevenLabsAgentWidget — hosting plan execution truthfulness (Guard D)", () => {
  function activePlanBlock(): string {
    return blockBetween(
      "if (activePlan) {\n          const turn = await handlePendingPlanTurn(",
      "// ── Carson Weekly Planning V1",
    );
  }

  it("populates lastDirectToolSuccessRef with the real turn.summary when a persisted plan executes", () => {
    const block = activePlanBlock();
    const executedBranch = block.slice(
      block.indexOf('if (turn.action === "executed")'),
      block.indexOf('if (turn.action === "cancelled")'),
    );
    expect(executedBranch).toContain("lastDirectToolSuccessRef.current = {");
    expect(executedBranch).toMatch(/resultText:\s*turn\.summary\s*\?\?\s*""/);
    expect(executedBranch).toContain('toolName: "execute_instruction"');
  });

  it("populates lastDirectToolSuccessRef with the real turn.summary when a persisted plan is cancelled", () => {
    const block = activePlanBlock();
    const cancelledBranch = block.slice(
      block.indexOf('if (turn.action === "cancelled")'),
      block.indexOf("// held: plan preserved"),
    );
    expect(cancelledBranch).toContain("lastDirectToolSuccessRef.current = {");
    expect(cancelledBranch).toMatch(/resultText:\s*turn\.summary\s*\?\?\s*""/);
    expect(cancelledBranch).toContain('toolName: "execute_instruction"');
  });

  it("the ref is populated before the summary is returned, in both branches", () => {
    const block = activePlanBlock();
    const executedBranch = block.slice(
      block.indexOf('if (turn.action === "executed")'),
      block.indexOf('if (turn.action === "cancelled")'),
    );
    const cancelledBranch = block.slice(
      block.indexOf('if (turn.action === "cancelled")'),
      block.indexOf("// held: plan preserved"),
    );
    for (const branch of [executedBranch, cancelledBranch]) {
      const refIndex = branch.indexOf("lastDirectToolSuccessRef.current = {");
      const returnIndex = branch.indexOf('return turn.summary ?? "";');
      expect(refIndex).toBeGreaterThan(-1);
      expect(returnIndex).toBeGreaterThan(refIndex);
    }
  });

  it("does not set an explicit failure outcome for a normal execute or cancel — DirectToolSuccessResult defaults to success", () => {
    const block = activePlanBlock();
    expect(block).not.toMatch(/outcome:\s*"failure"/);
  });
});

describe("ElevenLabsAgentWidget — canonical consequential owner result", () => {
  it("uses the captured owner utterance for fresh hosting and clarification turns", () => {
    expect(SOURCE).toContain("const capturedOwnerMessage = activeUserRoutingContextRef.current?.message.trim() || lastUserMessage;");
    expect(SOURCE).toContain("pendingHostingClarificationRef.current || detectHouseholdOutcome(capturedOwnerMessage)");
    expect(SOURCE).toContain("const rawInstruction = resolveConsequentialInstructionSource({");
    expect(SOURCE).toContain("isHostingTurn: capturedHostingTurn");
  });

  it("returns a canonical speech contract for the current hosting tool result", () => {
    const toolBlock = blockBetween(
      "execute_instruction: async (params: ExecuteInstructionParams)",
      "// ── Legacy/simple fallbacks",
    );
    expect(toolBlock).toContain("buildCanonicalConsequentialSpeechPayload(canonicalResult.resultText)");
    expect(toolBlock).toContain('canonicalResult.toolName === "execute_instruction"');
    expect(toolBlock).toContain("canonicalResult.turnOperationId === currentOwnerTurnOperationIdRef.current");
  });

  it("requires ElevenLabs to relay marked hosting results without changing consequential facts", () => {
    expect(SOURCE).toContain(
      "speak only owner_result verbatim; do not paraphrase, preface, summarize, or add any consequential fact",
    );
  });

  it("binds each fresh owner transcript to a new operation and clears the prior result", () => {
    expect(SOURCE).toContain("const turnOperationId = crypto.randomUUID();");
    expect(SOURCE).toContain("currentOwnerTurnOperationIdRef.current = turnOperationId;");
    expect(SOURCE).toContain("canonicalConsequentialResultRef.current = null;");
  });

  it("renders the bound canonical result ahead of the independent agent reply", () => {
    const agentBlock = blockBetween(
      '} else if (role === "agent") {',
      "if (requestedChannel === \"text\") {",
    );
    expect(agentBlock).toContain("resolveConsequentialOwnerMessage(");
    expect(agentBlock).toContain("? consequentialDisplayMessage");
    expect(agentBlock.indexOf("resolveConsequentialOwnerMessage(")).toBeLessThan(
      agentBlock.indexOf("setLastCarsonMessage(finalDisplayMessage)"),
    );
  });

  it("records hosting clarification, proposal, execution, and cancellation with the hosting operation id", () => {
    expect(SOURCE).toContain('kind: "clarification"');
    expect(SOURCE).toContain('kind: "proposal"');
    expect(SOURCE).toContain('kind: "executed"');
    expect(SOURCE).toContain('kind: "cancelled"');
    expect(SOURCE).toContain("domainOperationId: operationTurn.draft.operationId");
    expect(SOURCE).toContain("domainOperationId: plan.dbId ?? null");
    expect(SOURCE).toContain("domainOperationId: activePlan.dbId ?? null");
  });

  it("has no transcript-inferred or shutdown-time dinner execution authority", () => {
    expect(SOURCE).not.toContain("maybeSendImpliedDinnerDelegation");
    expect(SOURCE).not.toContain("extractDinnerPreparationRequest");
    expect(SOURCE).not.toContain("findDinnerOwner");
    expect(SOURCE).not.toContain("hasDinnerPreparationDelegation");
  });
});
