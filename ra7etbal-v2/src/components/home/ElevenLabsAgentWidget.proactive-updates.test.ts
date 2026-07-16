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

  it("does not present a proactive Updates prompt while Carson is already acting", () => {
    const guardBlockStart = SOURCE.indexOf("const presentProactiveUpdatePrompt = useCallback(");
    const guardBlockEnd = SOURCE.indexOf("const runLocalOutputProbe = useCallback(", guardBlockStart);
    const block = SOURCE.slice(guardBlockStart, guardBlockEnd);

    expect(block).toContain("toolInFlightRef.current");
    expect(block).toContain("typedSubmitInFlightRef.current");
    expect(block).toContain("typedAwaitingResponse");
    expect(block).toContain("markProactiveUpdateDisplayed(prompt)");
    expect(block).not.toContain("[Proactive Updates prompt]");
  });

  it("selects the proactive item before opening_line is computed", () => {
    const startBlock = blockBetween(
      'const startCarsonSession = useCallback(async (requestedChannel: CarsonChannel = "voice") => {',
      "const conv = await Conversation.startSession({",
    );
    const refreshIndex = startBlock.indexOf("const freshVars = onBeforeCallStart ? await onBeforeCallStart() : null;");
    const selectionIndex = startBlock.indexOf("const sessionStartProactivePrompt = await loadNextProactiveUpdate()");
    const openingIndex = startBlock.indexOf("const openingLine = sessionStartProactivePrompt?.prompt");

    expect(refreshIndex).toBeGreaterThan(-1);
    expect(selectionIndex).toBeGreaterThan(-1);
    expect(selectionIndex).toBeGreaterThan(refreshIndex);
    expect(openingIndex).toBeGreaterThan(selectionIndex);
  });

  it("uses the selected proactive prompt as the first session-start opening line", () => {
    const startBlock = blockBetween(
      "const sessionStartProactivePrompt = await loadNextProactiveUpdate()",
      "const channelInstructions = requestedChannel === \"voice\"",
    );

    expect(startBlock).toContain("const openingLine = sessionStartProactivePrompt?.prompt ??");
    expect(startBlock).toContain("buildCarsonOpeningLine({");
    expect(startBlock.indexOf("sessionStartProactivePrompt?.prompt"))
      .toBeLessThan(startBlock.indexOf("buildCarsonOpeningLine({"));
  });

  it("keeps the generic greeting only as the no-proactive fallback", () => {
    const startBlock = blockBetween(
      "const openingLine = sessionStartProactivePrompt?.prompt ??",
      "sessionPhotoContextRef.current = await photoContextPromise",
    );

    expect(startBlock).toContain("buildCarsonOpeningLine({");
    expect(startBlock).not.toContain("What needs attention?");
    expect(startBlock).not.toContain("What can I help with?");
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

  it("uses the selected prompt as the only proactive opening delivery path", () => {
    const proactiveBlock = blockBetween(
      "const presentProactiveUpdatePrompt = useCallback(",
      "const runLocalOutputProbe = useCallback(",
    );

    expect(SOURCE).toContain("sessionStartProactivePrompt?.prompt");
    expect(SOURCE).toContain("presentProactiveUpdatePrompt(sessionStartProactivePrompt, {");
    expect(SOURCE).toContain("channel: requestedChannel");
    expect(proactiveBlock).toContain("markProactiveUpdateDisplayed(prompt)");
    expect(proactiveBlock).toContain("opening_line");
    expect(proactiveBlock).not.toContain("local-proactive");
    expect(proactiveBlock).not.toContain("createTypedAgentMessage({");
    expect(proactiveBlock).not.toContain("setTypedMessages((current) => [...current, optimisticMessage])");
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
      "const presentProactiveUpdatePrompt = useCallback(",
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

    expect(typedBlock).toContain("const continuationMessage = await continueAfterProactiveDismissal()");
    expect(typedBlock).toContain("content: continuationMessage");
    expect(typedBlock).not.toContain("Okay. I'll leave that for now.");
    expect(typedBlock).not.toContain("Noted. It stays open.");
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
});
