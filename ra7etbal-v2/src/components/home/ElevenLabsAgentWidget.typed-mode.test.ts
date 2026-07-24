import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");
const APP_SOURCE = readFileSync(join(__dirname, "../../App.tsx"), "utf-8");
const TYPED_CHAT_SOURCE = readFileSync(join(__dirname, "CarsonTypedChat.tsx"), "utf-8");
const TYPED_MESSAGES_SOURCE = readFileSync(
  join(__dirname, "../../lib/carson-typed-messages.ts"),
  "utf-8",
);
const MIGRATION = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260713_create_carson_typed_messages.sql"),
  "utf-8",
);

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("ElevenLabsAgentWidget — Type to Carson single-agent architecture", () => {
  it("uses the existing single ElevenLabs session owner and never mounts the discarded TextCarsonPanel", () => {
    expect(SOURCE.split("Conversation.startSession(")).toHaveLength(2);
    expect(SOURCE).not.toContain("TextCarsonPanel");
    expect(APP_SOURCE).not.toContain("TextCarsonPanel");
    expect(SOURCE).not.toContain("askTextCarson");
  });

  it("selects the same session with textOnly and an authenticated user id only for typed mode", () => {
    const startBlock = blockBetween(
      'const startCarsonSession = useCallback(async (requestedChannel: CarsonChannel = "voice") => {',
      "  const startCall = useCallback(",
    );
    expect(startBlock).toContain('requestedChannel === "text"');
    expect(startBlock).toContain("textOnly: true as const");
    expect(startBlock).toContain("userId: authenticatedUserId ?? undefined");
    expect(startBlock).toContain('requestedChannel === "text" && !authenticatedUserId');
    expect(startBlock).toContain("clientTools: {");
    expect(startBlock).toContain("dynamicVariables: {");
  });

  it("keeps the proven voice connection delay and microphone warm-up voice-only", () => {
    expect(SOURCE).toContain('requestedChannel === "voice" &&');
    expect(SOURCE).toContain("navigator.mediaDevices?.getUserMedia");
    expect(SOURCE).toContain("connectionDelay: { default: 0, android: 3_000, ios: 500 }");
    expect(SOURCE).toContain('activeChannelRef.current === "voice"');
  });

  it("authorizes typed tools only during a fresh durable owner turn and retains every voice guard", () => {
    const guardBlock = blockBetween(
      "const guardCurrentToolInvocation = (toolName: string): string | null => {",
      "    try {",
    );
    expect(guardBlock).toContain('requestedChannel === "voice"');
    expect(guardBlock).toContain("guardCurrentVoiceCapture(toolName)");
    expect(guardBlock).toContain("pendingTypedClientMessageIdRef.current");
    expect(guardBlock).toContain("blocked tool without an active owner turn");

    const toolBlock = blockBetween("clientTools: {", "        onModeChange: ({ mode: m }) => {");
    for (const toolName of [
      "execute_instruction",
      "send_delegation",
      "create_reminder",
      "create_automation",
      "create_todo",
      "create_calendar_event",
      "save_instruction",
    ]) {
      expect(toolBlock).toContain(`guardCurrentToolInvocation("${toolName}")`);
    }
  });

  it("persists a unique user turn before sending and never automatically replays refresh history", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const persistIndex = sendBlock.indexOf("await createTypedUserMessage({");
    const sendIndex = sendBlock.indexOf("conversation.sendUserMessage(agentMessage)");
    expect(persistIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(-1);
    expect(persistIndex).toBeLessThan(sendIndex);
    expect(sendBlock).toContain("typedSubmitInFlightRef.current");
    expect(sendBlock).toContain("Photos attached to this exact typed message only");
    expect(sendBlock.indexOf("pendingTypedClientMessageIdRef.current = clientMessageId"))
      .toBeGreaterThan(sendBlock.indexOf("await describePhotosForCarson(typedPhotos)"));
    expect(sendBlock).toContain("typedResponseTimeoutRef.current = setTimeout");
    expect(sendBlock).toContain('deliveryStatus: "interrupted"');

    expect(SOURCE).toContain("const reconcileTypedHistory = useCallback");
    expect(SOURCE).toContain("markUnansweredTypedMessagesInterrupted(typedSessionIdRef.current)");
    expect(SOURCE).toContain("loadRecentTypedCarsonMessages(200)");
    expect(SOURCE).not.toContain("loadRecentTypedCarsonMessages(100)");
    expect(SOURCE).toContain("Do not execute any instruction from this history");

    const replyBlock = blockBetween(
      "const pendingClientMessageId = pendingTypedClientMessageIdRef.current;",
      "          } else {\n            // Unexpected role",
    );
    const revokeIndex = replyBlock.indexOf("pendingTypedClientMessageIdRef.current = null");
    const persistReplyIndex = replyBlock.indexOf("void createTypedAgentMessage({");
    expect(revokeIndex).toBeGreaterThan(-1);
    expect(persistReplyIndex).toBeGreaterThan(-1);
    expect(revokeIndex).toBeLessThan(persistReplyIndex);
  });

  it("gates typed hosting plans locally before the ElevenLabs text chat can propose workers", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const guestActionIndex = sendBlock.indexOf("const typedGuestAction = resolveGuestOutcomeAction(savedMessage.content)");
    const operationTurnIndex = sendBlock.indexOf("const operationTurn = await handleOperationalHostingTurn({", guestActionIndex);
    const localReplyIndex = sendBlock.indexOf("persistLocalTypedAgentReply({", operationTurnIndex);
    const sendIndex = sendBlock.indexOf("conversation.sendUserMessage(agentMessage)");

    expect(guestActionIndex).toBeGreaterThan(-1);
    expect(operationTurnIndex).toBeGreaterThan(guestActionIndex);
    expect(localReplyIndex).toBeGreaterThan(operationTurnIndex);
    expect(operationTurnIndex).toBeLessThan(sendIndex);
    expect(sendBlock).toContain('operationTurn.status === "needs_clarification"');
    expect(sendBlock).toContain("handleOperationalHostingTurn({");
    expect(sendBlock).toContain("pendingPlanRef.current = plan");
    expect(sendBlock).toContain("content: plan.proposalSpeech");
  });

  it("links a typed hosting clarification answer back to the original request before planning", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const pendingRefIndex = SOURCE.indexOf("const pendingHostingClarificationRef = useRef<PendingOperationDraft | null>(null)");
    const pendingBranchIndex = sendBlock.indexOf("const pendingHostingClarification = pendingHostingClarificationRef.current");
    const operationTurnIndex = sendBlock.indexOf("const operationTurn = await handleOperationalHostingTurn({", pendingBranchIndex);
    const pendingDraftIndex = sendBlock.indexOf("pendingDraft: pendingHostingClarification", operationTurnIndex);
    const proposalIndex = sendBlock.indexOf("content: plan.proposalSpeech", operationTurnIndex);
    const setClarificationIndex = sendBlock.indexOf("pendingHostingClarificationRef.current = operationTurn.draft", operationTurnIndex);
    const sendIndex = sendBlock.indexOf("conversation.sendUserMessage(agentMessage)");

    expect(pendingRefIndex).toBeGreaterThan(-1);
    expect(pendingBranchIndex).toBeGreaterThan(-1);
    expect(operationTurnIndex).toBeGreaterThan(pendingBranchIndex);
    expect(pendingDraftIndex).toBeGreaterThan(operationTurnIndex);
    expect(setClarificationIndex).toBeGreaterThan(operationTurnIndex);
    expect(proposalIndex).toBeGreaterThan(operationTurnIndex);
    expect(operationTurnIndex).toBeLessThan(sendIndex);
  });

  it("restores only the canonical active operation and lets a fresh request supersede history", () => {
    expect(SOURCE).not.toContain("restorePendingHostingDraftFromTypedHistory(");

    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const classifyIndex = sendBlock.indexOf("const typedGuestAction = resolveGuestOutcomeAction(savedMessage.content)");
    const restoreIndex = sendBlock.indexOf("await loadActiveHostingDraft().catch(() => null)");
    const pendingBranchIndex = sendBlock.indexOf("const pendingHostingClarification = pendingHostingClarificationRef.current");
    const operationTurnIndex = sendBlock.indexOf("const operationTurn = await handleOperationalHostingTurn({", pendingBranchIndex);
    const sendIndex = sendBlock.indexOf("conversation.sendUserMessage(agentMessage)");

    expect(classifyIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(classifyIndex).toBeLessThan(restoreIndex);
    expect(sendBlock).toContain('if (typedGuestAction === "none" && !pendingHostingClarificationRef.current)');
    expect(pendingBranchIndex).toBeGreaterThan(restoreIndex);
    expect(operationTurnIndex).toBeGreaterThan(pendingBranchIndex);
    expect(operationTurnIndex).toBeLessThan(sendIndex);
  });

  it("restores an active hosting operation before allowing typed session opening behavior", () => {
    const startBlock = blockBetween(
      'const startCarsonSession = useCallback(async (requestedChannel: CarsonChannel = "voice") => {',
      "  const startCall = useCallback(() => {",
    );
    const restoreIndex = startBlock.indexOf("const activeHostingDraft = pendingHostingClarificationRef.current");
    const openingIndex = startBlock.indexOf("const openingLine = activeHostingDraft");

    expect(restoreIndex).toBeGreaterThan(-1);
    expect(openingIndex).toBeGreaterThan(restoreIndex);
    expect(startBlock).toContain('const hasTypedHistory = requestedChannel === "text" && restoredTypedMessages.length > 0');
    expect(startBlock).toContain('const openingLine = activeHostingDraft || hasTypedHistory\n      ? ""');
    expect(startBlock).toContain("An active hosting clarification is in progress. Do not greet or start a new topic");
  });

  it("restores typed history before deciding whether to open with a greeting", () => {
    const startBlock = blockBetween(
      'const startCarsonSession = useCallback(async (requestedChannel: CarsonChannel = "voice") => {',
      "  const startCall = useCallback(() => {",
    );
    const restoreIndex = startBlock.indexOf("let restoredTypedMessages: CarsonTypedMessage[] = [];");
    const openingIndex = startBlock.indexOf("const hasTypedHistory = requestedChannel === \"text\"");
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(openingIndex).toBeGreaterThan(restoreIndex);
    expect(startBlock).toContain("await ensureTypedHistoryLoaded()");
    expect(startBlock).toContain("opening_line: sanitizeForCarsonSpeech(openingLine)");
  });

  it("keeps a cleared transcript eligible for the normal first-chat greeting", () => {
    const clearStart = SOURCE.indexOf("const clearTypedHistory = useCallback(async () => {");
    const clearBlock = SOURCE.slice(clearStart, clearStart + 900);
    expect(clearStart).toBeGreaterThan(-1);
    expect(clearBlock).toContain("await clearTypedCarsonMessages()");
    expect(clearBlock).toContain("setTypedMessages([])");
    expect(SOURCE).toContain("const hasTypedHistory = requestedChannel === \"text\" && restoredTypedMessages.length > 0");
  });

  it("suppresses a delayed typed greeting while hosting clarification is active", () => {
    expect(SOURCE).toContain('requestedChannel === "text"');
    expect(SOURCE).toContain("&& pendingHostingClarificationRef.current");
    expect(SOURCE).toContain("&& pendingTypedClientMessageIdRef.current == null");
    expect(SOURCE).toContain("[hosting-clarification] suppressed typed session greeting");
  });

  it("answers completed-hosting recall before typed text can reach the free-form model", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const recallIndex = sendBlock.indexOf("resolveHostingOperationRecall(savedMessage.content)");
    const sendIndex = sendBlock.indexOf("conversation.sendUserMessage(agentMessage)");
    expect(recallIndex).toBeGreaterThan(-1);
    expect(recallIndex).toBeLessThan(sendIndex);
    expect(sendBlock).toContain("content: typedHostingRecall");
  });

  it("executes typed hosting approval through the stored plan once instead of re-asking ElevenLabs", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const decisionIndex = sendBlock.indexOf("const typedPendingDecision = resolvePendingPlanDecision(savedMessage.content)");
    const pendingPlanIndex = sendBlock.indexOf("let activeTypedPlan = pendingPlanRef.current");
    const handlerIndex = sendBlock.indexOf("handlePendingPlanTurn([savedMessage.content], activeTypedPlan");
    const localReplyIndex = sendBlock.indexOf("persistLocalTypedAgentReply({", handlerIndex);
    const sendIndex = sendBlock.indexOf("conversation.sendUserMessage(agentMessage)");

    expect(decisionIndex).toBeGreaterThan(-1);
    expect(pendingPlanIndex).toBeGreaterThan(decisionIndex);
    expect(handlerIndex).toBeGreaterThan(pendingPlanIndex);
    expect(localReplyIndex).toBeGreaterThan(handlerIndex);
    expect(handlerIndex).toBeLessThan(sendIndex);
    expect(sendBlock).toContain("if (turn.clearPlan) pendingPlanRef.current = null");
    expect(sendBlock).toContain('turn.action === "executed"');
    expect(sendBlock).toContain('turn.action === "cancelled"');
  });

  it("handles typed pending-plan approval before requiring an active ElevenLabs connection", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const createUserIndex = sendBlock.indexOf("savedMessage = await createTypedUserMessage({");
    const pendingPlanIndex = sendBlock.indexOf("let activeTypedPlan = pendingPlanRef.current");
    const loadPlanIndex = sendBlock.indexOf("activeTypedPlan = await loadLatestPendingPlan().catch(() => null)");
    const handlerIndex = sendBlock.indexOf("handlePendingPlanTurn([savedMessage.content], activeTypedPlan");
    const localReplyIndex = sendBlock.indexOf("persistLocalTypedAgentReply({", handlerIndex);
    const connectionGuardIndex = sendBlock.indexOf('throw new Error("The Carson session ended before the message could be sent.")');
    const initialGuardBlock = sendBlock.slice(
      sendBlock.indexOf("if ("),
      sendBlock.indexOf("typedSubmitInFlightRef.current = true;"),
    );

    expect(createUserIndex).toBeGreaterThan(-1);
    expect(pendingPlanIndex).toBeGreaterThan(createUserIndex);
    expect(loadPlanIndex).toBeGreaterThan(pendingPlanIndex);
    expect(handlerIndex).toBeGreaterThan(loadPlanIndex);
    expect(localReplyIndex).toBeGreaterThan(handlerIndex);
    expect(connectionGuardIndex).toBeGreaterThan(localReplyIndex);
    expect(initialGuardBlock).not.toContain('statusRef.current !== "connected"');
    expect(initialGuardBlock).not.toContain("!conversation");
  });

  it("returns after local partial hosting clarification so ElevenLabs cannot duplicate the reply", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    const pendingBranchIndex = sendBlock.indexOf("const pendingHostingClarification = pendingHostingClarificationRef.current");
    const needsClarificationIndex = sendBlock.indexOf('operationTurn.status === "needs_clarification"', pendingBranchIndex);
    const localReplyIndex = sendBlock.indexOf("persistLocalTypedAgentReply({", needsClarificationIndex);
    const localReturnIndex = sendBlock.indexOf("return;", localReplyIndex);
    const sendIndex = sendBlock.indexOf("conversation.sendUserMessage(agentMessage)");

    expect(pendingBranchIndex).toBeGreaterThan(-1);
    expect(needsClarificationIndex).toBeGreaterThan(pendingBranchIndex);
    expect(localReplyIndex).toBeGreaterThan(needsClarificationIndex);
    expect(localReturnIndex).toBeGreaterThan(localReplyIndex);
    expect(localReturnIndex).toBeLessThan(sendIndex);
  });

  it("keeps typed conversation history stable when leaving and returning to Type to Carson", () => {
    expect(SOURCE).toContain('const TYPED_SESSION_STORAGE_KEY = "ra7etbal:typed-carson-session-id"');
    expect(SOURCE).toContain("const typedSessionIdRef = useRef(getOrCreateTypedSessionId())");
    expect(SOURCE).toContain("loadRecentTypedCarsonMessages(200)");
    expect(SOURCE).toContain("setTypedMessages(merged)");
    expect(SOURCE).toContain("markUnansweredTypedMessagesInterrupted(typedSessionIdRef.current)");
  });

  it("loads the newest deterministic history page and restores it chronologically", () => {
    expect(TYPED_MESSAGES_SOURCE).toContain('.order("created_at", { ascending: false })');
    expect(TYPED_MESSAGES_SOURCE).toContain('.order("id", { ascending: false })');
    expect(TYPED_MESSAGES_SOURCE).toContain("Math.max(safeLimit, 200)");
    expect(TYPED_MESSAGES_SOURCE).toContain(".reverse()");
    expect(SOURCE).toContain("typedMessagesRef.current = merged");
  });

  it("reconciles persisted history on focus and visibility changes without losing local optimistic rows", () => {
    expect(SOURCE).toContain("const typedHistoryRequestRef = useRef(0)");
    expect(SOURCE).toContain("const reconcileTypedHistory = useCallback(async (markInterrupted = false)");
    expect(SOURCE).toContain("window.addEventListener(\"focus\", reconcile)");
    expect(SOURCE).toContain("document.addEventListener(\"visibilitychange\", reconcile)");
    expect(SOURCE).toContain("const persistedIds = new Set");
    expect(SOURCE).toContain("const optimistic = typedMessagesRef.current.filter");
    expect(SOURCE).toContain("const merged = [...persisted, ...optimistic].sort");
  });

  it("marks local typed hosting replies responded in the durable user row", () => {
    const helperBlock = blockBetween(
      "const persistLocalTypedAgentReply = useCallback(",
      "  const sendTypedMessage = useCallback(async () => {",
    );
    expect(helperBlock).toContain("updateTypedUserMessage({");
    expect(helperBlock).toContain("clientMessageId: input.replyToClientMessageId");
    expect(helperBlock).toContain('deliveryStatus: "responded"');
    expect(helperBlock).toContain("elevenlabsConversationId: typedConversationIdRef.current");

    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    for (const requiredText of [
      "You are not signed in. Please sign in and try again.",
      'turn.action === "executed"',
      'turn.action === "cancelled"',
      'operationTurn.status === "needs_clarification"',
      "I couldn't put that guest plan together right now. Please try again.",
      "content: plan.proposalSpeech",
    ]) {
      expect(sendBlock).toContain(requiredText);
    }
    expect(sendBlock.split("persistLocalTypedAgentReply({").length - 1).toBeGreaterThanOrEqual(6);
  });

  it("blocks empty Enter submissions while preserving IME and Shift+Enter behavior", () => {
    expect(TYPED_CHAT_SOURCE).toContain("!event.nativeEvent.isComposing &&\n              value.trim()");
    expect(TYPED_CHAT_SOURCE).toContain("!event.shiftKey");
  });

  it("allows the owner to attach photos and permanently clear only their typed transcript", () => {
    expect(TYPED_CHAT_SOURCE).toContain("Attach photo to typed Carson message");
    expect(TYPED_CHAT_SOURCE).toContain("Clear chat");
    expect(TYPED_CHAT_SOURCE).toContain("Delete saved typed messages? Tasks and memory stay.");
    expect(SOURCE).toContain("await clearTypedCarsonMessages()");
    expect(TYPED_MESSAGES_SOURCE).toContain('.from("carson_typed_messages")');
    expect(TYPED_MESSAGES_SOURCE).toContain('.delete()');
    expect(TYPED_MESSAGES_SOURCE).toContain('.eq("user_id", user.id)');
    expect(TYPED_MESSAGES_SOURCE).toContain("supabase.auth.getUser()");
  });
});

describe("typed Carson migration — privacy and idempotency", () => {
  it("enables RLS and scopes all four operations to auth.uid", () => {
    expect(MIGRATION).toContain("alter table public.carson_typed_messages enable row level security;");
    expect(MIGRATION.match(/auth\.uid\(\) = user_id/g)).toHaveLength(5);
    for (const operation of ["select", "insert", "update", "delete"]) {
      expect(MIGRATION).toContain(`for ${operation}`);
    }
  });

  it("enforces one durable client message id per owner", () => {
    expect(MIGRATION).toContain("unique index if not exists carson_typed_messages_user_client_message");
    expect(MIGRATION).toContain("(user_id, client_message_id)");
    expect(MIGRATION).toContain("where client_message_id is not null");
  });

  it("marks the matching user turn responded in the same transaction as Carson's reply", () => {
    expect(MIGRATION).toContain("create trigger mark_typed_carson_turn_responded");
    expect(MIGRATION).toContain("new.reply_to_client_message_id");
    expect(MIGRATION).toContain("and client_message_id = new.reply_to_client_message_id");
  });
});
