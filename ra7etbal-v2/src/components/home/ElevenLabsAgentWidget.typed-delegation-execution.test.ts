import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// This component depends on the ElevenLabs SDK and cannot be rendered in a
// unit test. Following the established convention for this file (see
// ElevenLabsAgentWidget.typed-mode.test.ts), these tests scan the raw
// source to prove the deterministic typed-delegation wiring exists, sits in
// the right place, and does not touch voice or WhatsApp template code. The
// underlying executor (executeDelegationFastPath / parseDelegationFastPath)
// already has its own unit coverage in delegation-fast-path.test.ts.
const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");
const WHATSAPP_TASK_SOURCE = readFileSync(
  join(__dirname, "../../../api/send-whatsapp-task.js"),
  "utf-8",
);

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("ElevenLabsAgentWidget — deterministic typed delegation execution", () => {
  it("1. executes a fresh typed simple delegation deterministically, before the turn reaches ElevenLabs", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const guestActionEnd = sendBlock.indexOf(
      "const typedPhotos = [",
      sendBlock.indexOf("const typedGuestAction = resolveGuestOutcomeAction(savedMessage.content)"),
    );
    const fastPathIndex = sendBlock.indexOf("Deterministic typed delegation fast path");
    const executorCallIndex = sendBlock.indexOf("await executeDelegationFastPath(", fastPathIndex);
    const sendIndex = sendBlock.indexOf("conversation.sendUserMessage(agentMessage)");

    expect(fastPathIndex).toBeGreaterThan(-1);
    expect(fastPathIndex).toBeLessThan(guestActionEnd);
    expect(executorCallIndex).toBeGreaterThan(fastPathIndex);
    expect(executorCallIndex).toBeLessThan(sendIndex);
  });

  it("2. calls sendDelegation exactly once via the shared executor — no second delegation implementation", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const occurrences = sendBlock.match(/sendDelegationFn:\s*sendDelegation/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(sendBlock).toContain("const typedDelegationFastPath = await executeDelegationFastPath(");
  });

  it("3. never sends the same instruction to ElevenLabs after a handled typed delegation", () => {
    const fastPathBlock = blockBetween(
      "Deterministic typed delegation fast path",
      "const typedPhotos = [",
    );
    const handledIndex = fastPathBlock.indexOf("if (typedDelegationFastPath.handled) {");
    const replyIndex = fastPathBlock.indexOf("await persistLocalTypedAgentReply({", handledIndex);
    const returnIndex = fastPathBlock.indexOf("return;", replyIndex);

    expect(handledIndex).toBeGreaterThan(-1);
    expect(replyIndex).toBeGreaterThan(handledIndex);
    expect(returnIndex).toBeGreaterThan(replyIndex);
    // No sendUserMessage call anywhere inside the handled branch or the
    // fast-path block as a whole — the fast path never falls through to it.
    expect(fastPathBlock).not.toContain("conversation.sendUserMessage");
  });

  it("4. persists Carson's reply only after the executor call resolves, using its exact response text", () => {
    const fastPathBlock = blockBetween(
      "Deterministic typed delegation fast path",
      "const typedPhotos = [",
    );
    const executorIndex = fastPathBlock.indexOf("await executeDelegationFastPath(");
    const replyIndex = fastPathBlock.indexOf("await persistLocalTypedAgentReply({", executorIndex);

    expect(executorIndex).toBeGreaterThan(-1);
    expect(replyIndex).toBeGreaterThan(executorIndex);
    expect(fastPathBlock).toContain("content: typedDelegationFastPath.response");
  });

  it("5. does not duplicate success bookkeeping — that stays owned by sendDelegation, not the typed caller", () => {
    const fastPathBlock = blockBetween(
      "Deterministic typed delegation fast path",
      "const typedPhotos = [",
    );

    // The caller no longer branches on status === "sent" to push a session
    // action or refresh Tasks itself. executeDelegationFastPath currently
    // treats any normally-resolved sendDelegation response string as
    // "sent" — including a failure-shaped one — so a caller-side check here
    // could misrecord a failed delegation as successful, on top of
    // duplicating bookkeeping sendDelegation already performs.
    expect(fastPathBlock).not.toContain('typedDelegationFastPath.status === "sent"');
    expect(fastPathBlock).not.toContain("sessionActionsRef.current.push(");
    expect(fastPathBlock).not.toContain("useTasksStore.getState().loadFor(");

    // The reply is persisted unconditionally with the executor's own response —
    // never a hardcoded success string — so a blocked/failed status (e.g. no
    // phone, no consent, send error) surfaces its own truthful text instead of
    // a fabricated "<name> has it".
    expect(fastPathBlock).not.toMatch(/content:\s*["'`].*has it/i);

    // sendDelegation (untouched) still owns this bookkeeping after a real
    // WhatsApp send succeeds — it is not simply deleted from the codebase.
    const sendDelegationBlock = blockBetween(
      "const sendDelegation = useCallback(",
      "  const executeInstruction = useCallback(",
    );
    expect(sendDelegationBlock).toContain("useTasksStore.getState().loadFor(userId, { force: true })");
    expect(sendDelegationBlock).toContain("sessionActionsRef.current.push(`Delegated to ${person.name}: ${taskText}`)");
  });

  it("6. excludes instructions that match the protected direct-message grammar before running the delegation executor", () => {
    const fastPathBlock = blockBetween(
      "Deterministic typed delegation fast path",
      "const typedPhotos = [",
    );
    const directCheckIndex = fastPathBlock.indexOf(
      "const typedIsDirectMessage = Boolean(",
    );
    const parseCallIndex = fastPathBlock.indexOf("parseSimpleDirectMessage(savedMessage.content");
    const guardIndex = fastPathBlock.indexOf("!typedIsDirectMessage");
    const executorIndex = fastPathBlock.indexOf("await executeDelegationFastPath(");

    expect(directCheckIndex).toBeGreaterThan(-1);
    expect(parseCallIndex).toBeGreaterThan(directCheckIndex);
    expect(guardIndex).toBeGreaterThan(parseCallIndex);
    expect(guardIndex).toBeLessThan(executorIndex);
  });

  it("7. leaves Talk to Carson / voice code untouched — the new block exists only inside sendTypedMessage", () => {
    // Exactly one occurrence anywhere in the file, and it is inside sendTypedMessage.
    const occurrences = SOURCE.match(/Deterministic typed delegation fast path/g) ?? [];
    expect(occurrences).toHaveLength(1);

    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    expect(sendBlock).toContain("Deterministic typed delegation fast path");

    // The voice tool-call block (executeInstruction) and its own, separate,
    // pre-existing executeDelegationFastPath call are unmodified and distinct
    // from the new typed-only block.
    const executeInstructionBlock = blockBetween(
      "const executeInstruction = useCallback(",
      "const clearCarsonSessionTimers = useCallback(",
    );
    expect(executeInstructionBlock).not.toContain("Deterministic typed delegation fast path");
    expect(executeInstructionBlock).toContain(
      "const delegationFastPath = await executeDelegationFastPath(\n          rawInstruction,",
    );

    // activeChannelRef gating for voice-only behavior is unchanged.
    expect(SOURCE).toContain('activeChannelRef.current === "voice"');
    expect(SOURCE).toContain('normalizeOwnerReference: activeChannelRef.current === "text"');
  });

  it("8. still falls through to the existing shared pipeline for photo, recurring, or ambiguous typed instructions", () => {
    const fastPathBlock = blockBetween(
      "Deterministic typed delegation fast path",
      "const typedPhotos = [",
    );
    expect(fastPathBlock).toContain(
      "pendingPhotosRef.current.length > 0 || sessionPhotosRef.current.length > 0",
    );
    expect(fastPathBlock).toContain("detectAllRecurringSchedules(savedMessage.content).length > 0");
    expect(fastPathBlock).toContain(
      "if (!typedHasPendingPhoto && !typedIsRecurring && !typedIsDirectMessage) {",
    );
    // Multi-person / personal-note / ambiguous wording is excluded by the
    // shared parser itself (parseDelegationFastPath), not reimplemented here.
    expect(fastPathBlock).not.toMatch(/HAS_MULTI_PERSON|HAS_PERSONAL_NOTE/);
  });

  it("9. does not modify any WhatsApp template selection — direct, task, routine, or owner-decision", () => {
    // send-whatsapp-task.js is untouched by this change: the protected
    // direct-message baseline from PR #29 is still present verbatim.
    expect(WHATSAPP_TASK_SOURCE).toContain(
      "const DEFAULT_DIRECT_MESSAGE_TEMPLATE = 'ra7etbal_direct_operational_message';",
    );
    expect(WHATSAPP_TASK_SOURCE).toContain(
      "process.env.WHATSAPP_DIRECT_MESSAGE_TEMPLATE_LANGUAGE || 'en'",
    );
    expect(WHATSAPP_TASK_SOURCE).toContain("export function buildDirectMessagePayload({");
    expect(WHATSAPP_TASK_SOURCE).toContain("const DEFAULT_PLAIN_MESSAGE_TEMPLATE = 'ra7etbal_routine_message';");
    expect(WHATSAPP_TASK_SOURCE).toContain("ra7etbal_task_v3: {");
    expect(WHATSAPP_TASK_SOURCE).toContain("OWNER_DECISION_TEMPLATE_NAME = 'ra7etbal_owner_decision'");

    // The widget file itself carries no template-name literals in the new block.
    const fastPathBlock = blockBetween(
      "Deterministic typed delegation fast path",
      "const typedPhotos = [",
    );
    expect(fastPathBlock).not.toMatch(/ra7etbal_(?:direct_operational|routine|task|owner_decision)_?\w*/);
  });
});
