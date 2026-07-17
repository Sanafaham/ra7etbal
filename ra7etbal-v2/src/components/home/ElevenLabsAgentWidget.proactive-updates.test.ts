import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

describe("ElevenLabsAgentWidget — proactive Updates prompt guard", () => {
  function blockBetween(startNeedle: string, endNeedle: string): string {
    const start = SOURCE.indexOf(startNeedle);
    const end = SOURCE.indexOf(endNeedle, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it("does not select or inject any proactive Updates item when a Carson session starts", () => {
    const startBlock = blockBetween(
      'const startCarsonSession = useCallback(async (requestedChannel: CarsonChannel = "voice") => {',
      "const conv = await Conversation.startSession({",
    );

    expect(startBlock).not.toContain("loadNextProactiveUpdate");
    expect(startBlock).not.toContain("sessionStartProactivePrompt");
    expect(startBlock).not.toContain("chooseProactiveCarsonUpdate");
    expect(startBlock).toContain("const openingLine = buildCarsonOpeningLine({");
  });

  it("removed the session-start proactive opener functions entirely", () => {
    expect(SOURCE).not.toContain("const loadNextProactiveUpdate = useCallback(");
    expect(SOURCE).not.toContain("const presentProactiveUpdatePrompt = useCallback(");
    expect(SOURCE).not.toContain("const markProactiveUpdateDisplayed = useCallback(");
    expect(SOURCE).not.toContain("[Proactive Updates prompt]");
    expect(SOURCE).not.toContain("presentProactiveUpdatePrompt(");
  });

  it("keeps the generic greeting as the only session-start opening line", () => {
    const startBlock = blockBetween(
      "const openingLine = buildCarsonOpeningLine({",
      "sessionPhotoContextRef.current = await photoContextPromise",
    );

    expect(startBlock).toContain("isFirstSessionToday");
    expect(startBlock).toContain("spokenBrief: liveSpokenBrief");
    expect(startBlock).not.toContain("What needs attention?");
    expect(startBlock).not.toContain("What can I help with?");
    expect(startBlock).not.toContain("sessionStartProactivePrompt");
  });

  it("clears proactive suppression at the start of every real Carson session", () => {
    const resetBlock = blockBetween(
      "// Reset session state for this new session.",
      "// Load structured user memory",
    );

    expect(resetBlock).toContain("proactiveSuppressedUpdateKeysRef.current = new Set()");
    expect(SOURCE).not.toContain("ra7etbal:carson-proactive-updates-suppressed");
    expect(SOURCE).not.toContain("readProactiveSuppressedKeys");
    expect(SOURCE).not.toContain("writeProactiveSuppressedKeys");
  });

  it("suppresses generic agent greetings after a proactive prompt is active", () => {
    const messageBlock = blockBetween(
      "const activeProactivePrompt = activeProactiveUpdateRef.current;",
      "// \"agent\" is the ElevenLabs SDK role for Carson's spoken turns.",
    );

    expect(messageBlock).toContain("!hasOwnerTurn");
    expect(messageBlock).toContain("normalizeMemoryText(message) !== normalizeMemoryText(activeProactivePrompt.prompt)");
    expect(messageBlock).toContain("suppressed generic session greeting");
  });

  it("continues to the next proactive Updates item after a not-now dismissal", () => {
    const continuationBlock = blockBetween(
      "const continueAfterProactiveDismissal = useCallback(",
      "const runLocalOutputProbe = useCallback(",
    );

    expect(continuationBlock).toContain("buildProactiveDismissalContinuation({");
    expect(continuationBlock).toContain("proactiveSuppressedUpdateKeysRef.current.add(continuation.suppressedItemKey)");
    expect(continuationBlock).toContain("activeProactiveUpdateRef.current = continuation.nextPrompt");
    expect(continuationBlock).toContain("proactiveSuppressedUpdateKeysRef.current.add(continuation.nextPrompt.itemKey)");
    expect(continuationBlock).not.toContain("actOnCarsonUpdate(");
    expect(continuationBlock).not.toContain("markDone");
    expect(continuationBlock).not.toContain("remove(");
  });

  it("typed not-now persists the continuation prompt instead of stopping at an acknowledgement", () => {
    const typedBlock = blockBetween(
      "if (activeProactiveUpdateRef.current && isCarsonProactiveUpdateDismissal(savedMessage.content))",
      "const authUserId = useAuthStore.getState().user?.id;",
    );

    expect(typedBlock).toContain("const continuation = await continueAfterProactiveDismissal()");
    expect(typedBlock).toContain("content: continuation.message");
    expect(typedBlock).not.toContain("Okay. I'll leave that for now.");
    expect(typedBlock).not.toContain("Noted. It stays open.");
  });

  it("typed not-now sends exactly one silent contextual update to ElevenLabs, never a user message", () => {
    const typedBlock = blockBetween(
      "if (activeProactiveUpdateRef.current && isCarsonProactiveUpdateDismissal(savedMessage.content))",
      "const authUserId = useAuthStore.getState().user?.id;",
    );

    const contextualUpdateCalls = typedBlock.match(/sendContextualUpdate\(/g) ?? [];
    expect(contextualUpdateCalls).toHaveLength(1);
    expect(typedBlock).toContain("conversationRef.current?.sendContextualUpdate(");
    expect(typedBlock).not.toContain("sendUserMessage(");
    expect(typedBlock).not.toContain("createTypedAgentMessage(");
  });

  it("typed not-now's contextual update excludes the dismissed item and includes only the next one", () => {
    const typedBlock = blockBetween(
      "if (activeProactiveUpdateRef.current && isCarsonProactiveUpdateDismissal(savedMessage.content))",
      "const authUserId = useAuthStore.getState().user?.id;",
    );

    expect(typedBlock).toContain("continuation.nextPrompt");
    expect(typedBlock).toContain("continuation.nextPrompt.prompt");
    expect(typedBlock).not.toContain("active.prompt");
    expect(typedBlock).not.toContain("activeProactiveUpdateRef.current.prompt");
    expect(typedBlock).toContain("dismissed for this session");
    expect(typedBlock).toContain("do not mention or re-present it");
  });

  it("typed not-now's contextual update is explicitly silent and handles the no-next-item case", () => {
    const typedBlock = blockBetween(
      "if (activeProactiveUpdateRef.current && isCarsonProactiveUpdateDismissal(savedMessage.content))",
      "const authUserId = useAuthStore.getState().user?.id;",
    );

    expect(typedBlock).toContain("This is a silent context update");
    expect(typedBlock).toContain("do not reply to it");
    expect(typedBlock).toContain("No proactive Updates item is currently active.");
  });

  it("voice not-now sends the same continuation prompt into the active conversation", () => {
    const voiceBlock = blockBetween(
      "if (activeProactiveUpdateRef.current && isCarsonProactiveUpdateDismissal(message))",
      "if (userTranscriptTimerRef.current)",
    );

    expect(voiceBlock).toContain("continueAfterProactiveDismissal()");
    expect(voiceBlock).toContain("activeChannelRef.current !== \"voice\"");
    expect(voiceBlock).toContain("conversationRef.current.sendContextualUpdate(");
    expect(voiceBlock).toContain("Leave that database record unchanged");
    expect(voiceBlock).toContain("without adding a greeting or asking what needs attention");
  });

  it("typed and voice resolve a staff instruction through the same shared operational function", () => {
    // Voice: the send_delegation client tool is a direct call to sendDelegation.
    const voiceToolBlock = blockBetween(
      "send_delegation: async (params: Parameters<typeof sendDelegation>[0]) => {",
      "send_direct_whatsapp_message:",
    );
    expect(voiceToolBlock).toContain("sendDelegation(params)");

    // Typed: a plain (non-dismissal) staff instruction routes through
    // executeInstruction, never a separate local delegation handler.
    const typedFallthroughBlock = blockBetween(
      "const typedDelegationCandidate = parseDelegationFastPath(",
      "const typedPhotos = [",
    );
    expect(typedFallthroughBlock).toContain("await executeInstruction({ instruction: savedMessage.content })");
    expect(typedFallthroughBlock).not.toContain("sendDelegation(");

    // executeInstruction itself — the function both entry points ultimately
    // reach — calls the identical sendDelegation callback via the delegation
    // fast path, so classification, persistence, and delivery path are the
    // same function call in both channels.
    const executeInstructionBlock = blockBetween(
      "const executeInstruction = useCallback(",
      "const clearCarsonSessionTimers = useCallback(",
    );
    expect(executeInstructionBlock).toContain("executeDelegationFastPath(");
    expect(executeInstructionBlock).toContain("{ sendDelegationFn: sendDelegation }");
  });

  it("typed dismisses first, then routes the remaining instruction through executeInstruction", () => {
    const typedBlock = blockBetween(
      "if (activeProactiveUpdateRef.current && isCarsonProactiveUpdateDismissal(savedMessage.content))",
      "const authUserId = useAuthStore.getState().user?.id;",
    );

    expect(typedBlock).toContain("extractInstructionAfterLeadingDismissal(savedMessage.content)");
    expect(typedBlock).toContain("if (!remainingInstruction) {\n          return;\n        }");
    expect(typedBlock).toContain("await executeInstruction({ instruction: remainingInstruction })");

    // Ordering: the dismissal continuation is computed and persisted, and the
    // early-return guard for a pure dismissal, all appear before the
    // executeInstruction call for the remainder.
    const dismissalIndex = typedBlock.indexOf("const continuation = await continueAfterProactiveDismissal()");
    const guardIndex = typedBlock.indexOf("if (!remainingInstruction)");
    const executeIndex = typedBlock.indexOf("await executeInstruction({ instruction: remainingInstruction })");
    expect(dismissalIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(dismissalIndex);
    expect(executeIndex).toBeGreaterThan(guardIndex);
  });

  it("typed does not persist a success message before executeInstruction confirms the remainder", () => {
    const typedBlock = blockBetween(
      "if (activeProactiveUpdateRef.current && isCarsonProactiveUpdateDismissal(savedMessage.content))",
      "const authUserId = useAuthStore.getState().user?.id;",
    );

    const executeIndex = typedBlock.indexOf("const remainderSummary = remainderAuthUserId\n          ? await executeInstruction({ instruction: remainingInstruction })");
    const finalReplyIndex = typedBlock.indexOf("content: remainderSummary");
    expect(executeIndex).toBeGreaterThan(-1);
    expect(finalReplyIndex).toBeGreaterThan(executeIndex);
    // The dismissal-only reply persisted before the remainder exists only
    // acknowledges the proactive item, never a result for the new instruction.
    const firstReplyBlock = typedBlock.slice(0, executeIndex);
    expect(firstReplyBlock).not.toContain("content: remainderSummary");
  });
});
