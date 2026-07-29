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
      "const guardCurrentToolInvocation = (toolName: string, toolArguments?: unknown): string | null => {",
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
      expect(toolBlock).toContain(`guardCurrentToolInvocation("${toolName}",`);
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

  // ── Typed-history reconciliation lock-in (RA7ETBAL_STATE.md verified loop) ──
  // Protects the exact architecture verified in production: one shared in-flight
  // promise, one request-generation guard so a stale response can never overwrite
  // newer history, deterministic persisted-over-optimistic merge, and a stable
  // sort tie-breaker so repeated reopen produces the same newest transcript.
  it("shares one in-flight promise so concurrent reconcile callers never race", () => {
    const reconcileBlock = blockBetween(
      "const reconcileTypedHistory = useCallback(async (markInterrupted = false)",
      "  useEffect(() => {\n    if (!authenticatedUserId) {",
    );
    expect(reconcileBlock).toContain("if (!authenticatedUserId) return [];");
    expect(reconcileBlock).toContain(
      "if (typedHistoryLoadPromiseRef.current) return typedHistoryLoadPromiseRef.current;",
    );
    expect(reconcileBlock).toContain("typedHistoryLoadPromiseRef.current = promise;");
    expect(reconcileBlock).toContain("if (typedHistoryLoadPromiseRef.current === promise) typedHistoryLoadPromiseRef.current = null;");
  });

  it("guards every reconcile call with a monotonic request id so a stale response cannot overwrite newer history", () => {
    const reconcileBlock = blockBetween(
      "const reconcileTypedHistory = useCallback(async (markInterrupted = false)",
      "  useEffect(() => {\n    if (!authenticatedUserId) {",
    );
    const requestIdIndex = reconcileBlock.indexOf("const requestId = ++typedHistoryRequestRef.current;");
    const loadIndex = reconcileBlock.indexOf("const persisted = await loadRecentTypedCarsonMessages(200);");
    const staleGuardIndex = reconcileBlock.indexOf(
      "if (requestId !== typedHistoryRequestRef.current) return typedMessagesRef.current;",
    );
    expect(requestIdIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeGreaterThan(requestIdIndex);
    expect(staleGuardIndex).toBeGreaterThan(loadIndex);
  });

  it("matches optimistic rows to persisted rows by both server id and client message id before merging", () => {
    const reconcileBlock = blockBetween(
      "const reconcileTypedHistory = useCallback(async (markInterrupted = false)",
      "  useEffect(() => {\n    if (!authenticatedUserId) {",
    );
    expect(reconcileBlock).toContain('const persistedIds = new Set(persisted.map((message) => message.id));');
    expect(reconcileBlock).toContain("const persistedClientIds = new Set(");
    expect(reconcileBlock).toContain("persisted.map((message) => message.client_message_id).filter(Boolean)");
    expect(reconcileBlock).toContain('message.id.startsWith("local-") || message.id.startsWith("optimistic-")');
    expect(reconcileBlock).toContain("!persistedIds.has(message.id)");
    expect(reconcileBlock).toContain("!persistedClientIds.has(message.client_message_id)");
  });

  it("orders the merged transcript deterministically by created_at with a stable id tie-breaker", () => {
    const reconcileBlock = blockBetween(
      "const reconcileTypedHistory = useCallback(async (markInterrupted = false)",
      "  useEffect(() => {\n    if (!authenticatedUserId) {",
    );
    expect(reconcileBlock).toContain(
      "const merged = [...persisted, ...optimistic].sort((a, b) => {",
    );
    expect(reconcileBlock).toContain('const created = a.created_at.localeCompare(b.created_at);');
    expect(reconcileBlock).toContain("return created || a.id.localeCompare(b.id);");
  });

  it("resets and reconciles typed history on authentication restoration, marking unanswered turns interrupted", () => {
    const authBlock = blockBetween(
      "  useEffect(() => {\n    if (!authenticatedUserId) {",
      "  useEffect(() => {\n    const opened = isOpen && !previousTypedOpenRef.current;",
    );
    expect(authBlock).toContain("typedHistoryLoadPromiseRef.current = null;");
    expect(authBlock).toContain("setTypedMessages([]);");
    expect(authBlock).toContain("typedMessagesRef.current = [];");
    expect(authBlock).toContain("setTypedError(null);");
    expect(authBlock).toContain("void reconcileTypedHistory(true);");
  });

  it("reconciles typed history exactly once when the Carson sheet transitions from closed to open", () => {
    const openBlock = blockBetween(
      "  useEffect(() => {\n    const opened = isOpen && !previousTypedOpenRef.current;",
      "  const ensureTypedHistoryLoaded = useCallback(",
    );
    expect(openBlock).toContain("const opened = isOpen && !previousTypedOpenRef.current;");
    expect(openBlock).toContain("previousTypedOpenRef.current = isOpen;");
    expect(openBlock).toContain("if (opened) void reconcileTypedHistory();");
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

// ── Type to Carson — advisory-only (product decision 2026-07-25) ──────────────
// Talk to Carson remains the only execution channel. These tests protect the
// code-level boundary (never prompt wording alone) that stops a typed request
// from reaching any state-changing tool or deterministic send path, while
// leaving Talk to Carson's own tool registration, routing, and execution
// completely untouched.
describe("Type to Carson — advisory-only, Talk to Carson unchanged", () => {
  const TOOL_GUARD_BLOCK_MARKER =
    "if (TYPED_MODE_IS_ADVISORY_ONLY && TYPED_BLOCKED_TOOL_MESSAGES[toolName]) {";

  it("blocks every state-changing client tool for typed mode via one shared, unconditional guard", () => {
    const guardBlock = blockBetween(
      "const guardCurrentToolInvocation = (toolName: string, toolArguments?: unknown): string | null => {",
      "    try {",
    );
    // Voice capture validation remains first, before typed authority checks.
    expect(guardBlock.indexOf("const captureBlock = guardCurrentVoiceCapture(toolName);"))
      .toBeLessThan(guardBlock.indexOf(TOOL_GUARD_BLOCK_MARKER));
    expect(guardBlock).toContain(TOOL_GUARD_BLOCK_MARKER);
    expect(guardBlock).toContain("return TYPED_BLOCKED_TOOL_MESSAGES[toolName];");
    // The typed-advisory check runs before the existing "no active owner
    // turn" fallback, so it applies unconditionally — a matched tool name is
    // blocked whether or not a typed owner turn is currently open.
    expect(guardBlock.indexOf(TOOL_GUARD_BLOCK_MARKER))
      .toBeLessThan(guardBlock.indexOf('requestedChannel === "text" && !pendingTypedClientMessageIdRef.current'));

    const blockedToolMap = blockBetween(
      "const TYPED_BLOCKED_TOOL_MESSAGES: Record<string, string> = {",
      "};",
    );
    for (const toolName of [
      "execute_instruction",
      "send_followup",
      "send_delegation",
      "send_direct_whatsapp_message",
      "create_reminder",
      "create_automation",
      "create_calendar_event",
      "update_calendar_event",
      "delete_calendar_event",
      "create_todo",
      "complete_todo",
      "control_task",
      "act_on_note",
      "save_city",
      "save_instruction",
      "save_note",
    ]) {
      expect(blockedToolMap).toContain(`${toolName}:`);
    }
    // Read-only research/planning stays available to typed mode.
    expect(blockedToolMap).not.toContain("get_calendar_events:");
    expect(blockedToolMap).toContain("save_note:");
  });

  it("blocks both typed note persistence and turning a note into a tracked action", () => {
    const saveNoteBlock = blockBetween(
      "save_note: (params: Parameters<typeof saveNote>[0]) => {",
      "  },",
    );
    const saveNoteGuardIndex = saveNoteBlock.indexOf('guardCurrentToolInvocation("save_note", params)');
    const saveNoteExecutorIndex = saveNoteBlock.indexOf("saveNote(params)");
    expect(saveNoteGuardIndex).toBeGreaterThan(-1);
    expect(saveNoteExecutorIndex).toBeGreaterThan(saveNoteGuardIndex);

    const actOnNoteBlock = blockBetween(
      "act_on_note: (params: Parameters<typeof actOnNote>[0]) => {",
      "  },",
    );
    const guardIndex = actOnNoteBlock.indexOf('guardCurrentToolInvocation("act_on_note", params)');
    const executorIndex = actOnNoteBlock.indexOf("actOnNote(params)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(executorIndex).toBeGreaterThan(guardIndex);
  });

  it("blocks a typed reminder request from creating a reminder or triggering push scheduling", () => {
    const toolBlock = blockBetween('create_reminder: (params: Parameters<typeof createReminder>[0]) => {', "  },");
    const guardIndex = toolBlock.indexOf('guardCurrentToolInvocation("create_reminder", params)');
    const executorIndex = toolBlock.indexOf("createReminder(params)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(executorIndex).toBeGreaterThan(guardIndex);
    expect(toolBlock).toContain("if (captureBlock) return captureBlock;");
    // createReminder — the function that owns all push/automation scheduling
    // for a one-time reminder — is only reached after the guard clears, so a
    // blocked typed call never runs any of that scheduling logic.
    expect(SOURCE).toContain('create_reminder: TYPED_ADVISORY_REMINDER,');
    expect(TYPED_ADVISORY_STRINGS_ARE_TRUTHFUL(sourceConstant("TYPED_ADVISORY_REMINDER"))).toBe(true);
  });

  it("blocks a typed recurring-reminder request from scheduling anything", () => {
    const toolBlock = blockBetween(
      'create_automation: (params: Parameters<typeof createAutomation>[0]) => {',
      "  },",
    );
    const guardIndex = toolBlock.indexOf('guardCurrentToolInvocation("create_automation", params)');
    const executorIndex = toolBlock.indexOf("createAutomation(params)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(executorIndex).toBeGreaterThan(guardIndex);
    expect(SOURCE).toContain('create_automation: TYPED_ADVISORY_RECURRING_REMINDER,');
  });

  it("blocks a typed calendar request from creating, updating, or deleting an event", () => {
    for (const [toolName, executorCall] of [
      ["create_calendar_event", "createCalendarEvent(params)"],
      ["update_calendar_event", "updateCalendarEventTool(params)"],
      ["delete_calendar_event", "deleteCalendarEventTool(params)"],
    ] as const) {
      const toolBlock = blockBetween(`${toolName}: (params: Parameters<typeof `, "  },");
      const guardIndex = toolBlock.indexOf(`guardCurrentToolInvocation("${toolName}", params)`);
      const executorIndex = toolBlock.indexOf(executorCall);
      expect(guardIndex, toolName).toBeGreaterThan(-1);
      expect(executorIndex, toolName).toBeGreaterThan(guardIndex);
      expect(SOURCE, toolName).toContain(`${toolName}: TYPED_ADVISORY_CALENDAR,`);
    }
    // Research/planning calendar reads remain available.
    const readBlock = blockBetween(
      'get_calendar_events: (params: Parameters<typeof getCalendarEvents>[0]) => {',
      "  },",
    );
    expect(readBlock).not.toContain("TYPED_BLOCKED_TOOL_MESSAGES");
  });

  it("blocks a typed staff-message request at both the model tool boundary and the deterministic fast paths", () => {
    for (const toolName of ["send_delegation", "send_followup", "send_direct_whatsapp_message"]) {
      expect(SOURCE).toContain(`${toolName}: TYPED_ADVISORY_STAFF_MESSAGE,`);
    }

    // Deterministic typed direct-message dispatch: the real WhatsApp send
    // (executeDirectMessageFastPath) is never called when advisory-only.
    const directMessageBlock = blockBetween(
      "if (typedDirectMessageParsed && !typedHasPendingPhoto && !typedIsRecurring) {",
      "// Duplicate guard (CodeRabbit finding on PR #53)",
    );
    expect(directMessageBlock).toContain("if (TYPED_MODE_IS_ADVISORY_ONLY) {");
    expect(directMessageBlock).toContain("content: TYPED_ADVISORY_STAFF_MESSAGE,");
    expect(directMessageBlock.indexOf("if (TYPED_MODE_IS_ADVISORY_ONLY)"))
      .toBeLessThan(directMessageBlock.indexOf("return;"));
    expect(directMessageBlock).not.toContain("executeDirectMessageFastPath(");

    // Deterministic typed delegation dispatch: only the pure parser runs;
    // executeDelegationFastPath (the real create-task-and-send) is gated
    // behind the non-advisory else-branch, unreachable while advisory-only.
    const delegationBlock = blockBetween(
      "if (!typedHasPendingPhoto && !typedIsRecurring && !typedIsDirectMessage) {",
      "\n      const typedPhotos = [",
    );
    expect(delegationBlock).toContain("if (TYPED_MODE_IS_ADVISORY_ONLY) {");
    expect(delegationBlock).toContain("if (parseDelegationFastPath(savedMessage.content, people)) {");
    expect(delegationBlock).toContain("content: TYPED_ADVISORY_STAFF_MESSAGE,");
    expect(delegationBlock).toContain("} else {");
    expect(delegationBlock).toContain("const typedDelegationFastPath = await executeDelegationFastPath(");
    const advisoryIndex = delegationBlock.indexOf("if (TYPED_MODE_IS_ADVISORY_ONLY) {");
    const parseIndex = delegationBlock.indexOf("if (parseDelegationFastPath(savedMessage.content, people)) {");
    const executeIndex = delegationBlock.indexOf("const typedDelegationFastPath = await executeDelegationFastPath(");
    expect(advisoryIndex).toBeLessThan(parseIndex);
    expect(parseIndex).toBeLessThan(executeIndex);
  });

  // Superseded 2026-07-25 (Priority 2, confirmed production regression: typed
  // "I have a dinner for 4 people at home tomorrow. Handle it." asked for the
  // time, asked about dietary restrictions, generated a full proposal, asked
  // for approval, and only THEN said to use Talk to Carson). Type to Carson
  // must now redirect immediately, before any hosting clarification question
  // or proposal is generated — see "redirects a typed hosting execution
  // request immediately, before any clarification or proposal" below.
  it("blocks hosting clarification/proposal generation entirely while advisory-only, but keeps the old planning-allowed path reachable behind TYPED_MODE_IS_ADVISORY_ONLY for reversibility", () => {
    const redirectBlock = blockBetween(
      "const pendingHostingClarification = pendingHostingClarificationRef.current;",
      "if (pendingHostingClarification) {",
    );
    expect(redirectBlock).toContain(
      'if (TYPED_MODE_IS_ADVISORY_ONLY && (pendingHostingClarification || typedGuestAction !== "none")) {',
    );
    expect(redirectBlock).toContain("content: TYPED_ADVISORY_HOSTING_REQUEST,");
    expect(redirectBlock).toContain("return;");
    expect(redirectBlock).not.toContain("handleOperationalHostingTurn");

    // The old "planning allowed" flow (both continuing a clarification and a
    // fresh request) still exists, reachable only when the redirect above
    // does not return — i.e. only when TYPED_MODE_IS_ADVISORY_ONLY is false.
    const clarificationBlock = blockBetween(
      "if (pendingHostingClarification) {",
      "if (typedGuestAction !== \"none\") {",
    );
    expect(clarificationBlock).toContain("const operationTurn = await handleOperationalHostingTurn({");

    const freshRequestBlock = blockBetween(
      "if (typedGuestAction !== \"none\") {",
      "// ── Deterministic typed delegation fast path",
    );
    expect(freshRequestBlock).toContain("const operationTurn = await handleOperationalHostingTurn({");

    // Pending-plan approval/execution remains blocked exactly as before —
    // handlePendingPlanTurn (the only call site that can invoke
    // executeProposedPlan) is never reached on "confirm", and the pending
    // plan is left untouched so Talk to Carson can still execute it.
    const pendingPlanBlock = blockBetween(
      "if (activeTypedPlan) {",
      "const turn = await handlePendingPlanTurn([savedMessage.content], activeTypedPlan, {",
    );
    expect(pendingPlanBlock).toContain('if (TYPED_MODE_IS_ADVISORY_ONLY && typedPendingDecision === "confirm") {');
    expect(pendingPlanBlock).toContain("content: TYPED_ADVISORY_HOSTING_EXECUTION,");
    expect(pendingPlanBlock).not.toContain("pendingPlanRef.current = null");
    expect(pendingPlanBlock).not.toContain("clearPlan");
  });

  it("never lets a typed advisory message claim an action was completed", () => {
    const advisoryStrings = [
      "TYPED_ADVISORY_REMINDER",
      "TYPED_ADVISORY_RECURRING_REMINDER",
      "TYPED_ADVISORY_CALENDAR",
      "TYPED_ADVISORY_STAFF_MESSAGE",
      "TYPED_ADVISORY_HOSTING_EXECUTION",
      "TYPED_ADVISORY_TASK_STATE",
      "TYPED_ADVISORY_GENERIC",
    ].map((name) => sourceConstant(name));

    for (const text of advisoryStrings) {
      expect(text.toLowerCase()).not.toMatch(/\b(done|sent|created|scheduled|confirmed|have the plan|i (?:sent|created|scheduled|confirmed))\b/);
      expect(text).toMatch(/Talk to Carson/);
    }
  });

  it("still reaches the free-form model for ordinary typed questions, planning, and drafting", () => {
    // No advisory-only branch short-circuits the general typed flow: the
    // final free-form send remains a single, unconditional call.
    expect(SOURCE.split("conversation.sendUserMessage(agentMessage)")).toHaveLength(2);
    // The advisory-only pending-plan/direct-message/delegation branches all
    // `return` only on their own specific match — a non-matching typed
    // message (a question, a planning request, a draft) falls through
    // unchanged to that same free-form call, guided by the new typed policy
    // (added below) rather than being blocked outright.
    expect(SOURCE).toContain("CARSON_TYPED_ADVISORY_POLICY");
    expect(SOURCE).toContain(
      "...(TYPED_MODE_IS_ADVISORY_ONLY ? [CARSON_TYPED_ADVISORY_POLICY] : []),",
    );
  });

  it("leaves typed-history persistence and reconciliation completely untouched by the advisory-only change", () => {
    const reconcileBlock = blockBetween(
      "const reconcileTypedHistory = useCallback(async (markInterrupted = false)",
      "  useEffect(() => {\n    if (!authenticatedUserId) {",
    );
    expect(reconcileBlock).not.toContain("TYPED_MODE_IS_ADVISORY_ONLY");
    expect(reconcileBlock).not.toContain("TYPED_BLOCKED_TOOL_MESSAGES");
  });

  it("never lets Talk to Carson reach the typed-advisory guard — voice returns before it is checked", () => {
    const guardBlock = blockBetween(
      "const guardCurrentToolInvocation = (toolName: string, toolArguments?: unknown): string | null => {",
      "    try {",
    );
    const voiceBranchIndex = guardBlock.indexOf('if (requestedChannel === "voice") {');
    const voiceReturnIndex = guardBlock.indexOf("const captureBlock = guardCurrentVoiceCapture(toolName);");
    const advisoryIndex = guardBlock.indexOf(TOOL_GUARD_BLOCK_MARKER);
    expect(voiceBranchIndex).toBeGreaterThan(-1);
    expect(voiceReturnIndex).toBeGreaterThan(voiceBranchIndex);
    expect(voiceReturnIndex).toBeLessThan(advisoryIndex);
  });

  it("keeps Talk to Carson's reminder, calendar, and delegation tools calling their real executors unconditionally", () => {
    for (const [toolName, executorCall] of [
      ["create_reminder", "createReminder(params)"],
      ["create_automation", "createAutomation(params)"],
      ["create_calendar_event", "createCalendarEvent(params)"],
      ["update_calendar_event", "updateCalendarEventTool(params)"],
      ["delete_calendar_event", "deleteCalendarEventTool(params)"],
      ["send_delegation", "sendDelegation(params)"],
      ["send_followup", "sendFollowup(params)"],
    ] as const) {
      expect(SOURCE, toolName).toContain(executorCall);
    }
    // guardCurrentVoiceCapture — the pre-existing, untouched voice guard —
    // still gates every voice tool call exactly as before this change.
    expect(SOURCE).toContain("const guardCurrentVoiceCapture = useCallback((toolName: string): string | null => {");
  });

  it("updates the typed entry copy to communicate the advisory-only role without listing actions it can no longer take", () => {
    expect(TYPED_CHAT_SOURCE).toContain("Type for questions and planning.");
    expect(TYPED_CHAT_SOURCE).not.toContain("create a reminder, delegate, or manage a To-do");
    expect(TYPED_CHAT_SOURCE).toContain("Talk to Carson");
  });
});

/** Extracts a single-line `const NAME = "...";` string literal from SOURCE. */
function sourceConstant(name: string): string {
  const match = SOURCE.match(new RegExp(`const ${name} = "([^"]*)";`));
  expect(match, name).not.toBeNull();
  return match![1];
}

function TYPED_ADVISORY_STRINGS_ARE_TRUTHFUL(text: string): boolean {
  return /Talk to Carson/.test(text) && !/\b(done|sent|created)\b/i.test(text);
}

// ── Type to Carson — immediate execution-request redirect (2026-07-25) ────────
// Confirmed production regressions: (1) a typed hosting execution request
// ("I have a dinner for 4 people at home tomorrow. Handle it.") asked for the
// time, asked about dietary restrictions, built a full proposal, asked for
// approval, and only THEN said to use Talk to Carson; (2) a typed mixed
// request ("...pay the electricity bill.") got the false reply "I'll have
// Grace handle it." with no delegation ever created. These tests lock the
// fix: a deterministic redirect before any clarification/proposal/dispatch,
// and a truthfulness guard on the free-form model's own reply text.
describe("Type to Carson — immediate execution-request redirect, Talk to Carson unchanged", () => {
  function sendBlock(): string {
    return blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
  }

  it("redirects a typed hosting execution request immediately, before any clarification question or proposal", () => {
    const block = sendBlock();
    const guestActionIndex = block.indexOf('const typedGuestAction = resolveGuestOutcomeAction(savedMessage.content)');
    const redirectIndex = block.indexOf(
      'if (TYPED_MODE_IS_ADVISORY_ONLY && (pendingHostingClarification || typedGuestAction !== "none")) {',
      guestActionIndex,
    );
    const redirectContentIndex = block.indexOf("content: TYPED_ADVISORY_HOSTING_REQUEST,", redirectIndex);
    const redirectReturnIndex = block.indexOf("return;", redirectContentIndex);
    const firstHostingTurnIndex = block.indexOf("await handleOperationalHostingTurn({", redirectIndex);

    expect(guestActionIndex).toBeGreaterThan(-1);
    expect(redirectIndex).toBeGreaterThan(guestActionIndex);
    expect(redirectContentIndex).toBeGreaterThan(redirectIndex);
    expect(redirectReturnIndex).toBeGreaterThan(redirectContentIndex);
    // No question is asked and no proposal is built before the redirect
    // returns — the only handleOperationalHostingTurn call (proposal/
    // clarification generation) in the block comes strictly after the
    // redirect's own return.
    expect(firstHostingTurnIndex).toBeGreaterThan(redirectReturnIndex);
    expect(TYPED_ADVISORY_HOSTING_REQUEST_VALUE()).toMatch(/Talk to Carson/);
    expect(TYPED_ADVISORY_HOSTING_REQUEST_VALUE()).not.toMatch(/\?/);
  });

  it("does not ask for approval before redirecting a fresh hosting request — no plan is ever stored first", () => {
    const block = sendBlock();
    const redirectIndex = block.indexOf(
      'if (TYPED_MODE_IS_ADVISORY_ONLY && (pendingHostingClarification || typedGuestAction !== "none")) {',
    );
    const redirectReturnIndex = block.indexOf("return;", redirectIndex);
    const firstPendingPlanAssignment = block.indexOf("pendingPlanRef.current = plan;", redirectIndex);
    // pendingPlanRef is only ever populated by the dormant reversibility
    // path, strictly after the redirect's own return — never before it.
    expect(firstPendingPlanAssignment).toBeGreaterThan(redirectReturnIndex);
  });

  it("redirects a typed reminder, calendar, staff-message, or generic-action request via one final classifier gate before the free-form model", () => {
    const block = sendBlock();
    const classifierIndex = block.indexOf(
      "const typedExecutionRedirect = TYPED_MODE_IS_ADVISORY_ONLY",
    );
    const classifyCallIndex = block.indexOf(
      "classifyTypedExecutionRequest(savedMessage.content, usePeopleStore.getState().items)",
      classifierIndex,
    );
    const redirectContentIndex = block.indexOf("content: typedExecutionRedirect.message,", classifyCallIndex);
    const redirectReturnIndex = block.indexOf("return;", redirectContentIndex);
    const modelSendIndex = block.indexOf("conversation.sendUserMessage(agentMessage)");

    expect(classifierIndex).toBeGreaterThan(-1);
    expect(classifyCallIndex).toBeGreaterThan(classifierIndex);
    expect(redirectContentIndex).toBeGreaterThan(classifyCallIndex);
    expect(redirectReturnIndex).toBeGreaterThan(redirectContentIndex);
    expect(modelSendIndex).toBeGreaterThan(redirectReturnIndex);
  });

  it("gates the new classifier redirect on TYPED_MODE_IS_ADVISORY_ONLY for reversibility, same as every other typed-only block", () => {
    expect(SOURCE).toContain(
      "const typedExecutionRedirect = TYPED_MODE_IS_ADVISORY_ONLY\n        ? classifyTypedExecutionRequest(savedMessage.content, usePeopleStore.getState().items)\n        : null;",
    );
  });

  it("imports classifyTypedExecutionRequest from the dedicated typed-advisory-redirect module — no duplicated pattern logic", () => {
    expect(SOURCE).toContain('import { classifyTypedExecutionRequest } from "../../lib/typed-advisory-redirect";');
  });

  it("applies the typed-only truthfulness guard exclusively to the text channel, never voice", () => {
    const onMessageBlock = blockBetween(
      "onMessage: ({ role, message, event_id }) => {",
      "onDisconnect: (details?: {",
    );
    const sanitizedIndex = onMessageBlock.indexOf("const displayMessage = resolveSanitizedCarsonDisplayMessage({");
    const guardIndex = onMessageBlock.indexOf('requestedChannel === "text"', sanitizedIndex);
    const scrubberCallIndex = onMessageBlock.indexOf("sanitizeTypedAdvisoryReply(displayMessage)", guardIndex);
    expect(sanitizedIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(sanitizedIndex);
    expect(scrubberCallIndex).toBeGreaterThan(guardIndex);
    // resolveSanitizedCarsonDisplayMessage itself — the shared, voice-and-typed
    // display-override call — is completely unchanged: same arguments, same
    // call site, still runs for both channels exactly as before.
    expect(onMessageBlock).toContain(
      "resolveSanitizedCarsonDisplayMessage({\n              agentMessage: message,\n              previousUserMessage,\n              lastSuccess: lastDirectToolSuccessRef.current,\n              noteSaveOutcome: noteSaveOutcomeRef.current,\n              messageSendOutcome: messageSendOutcomeRef.current,\n            });",
    );
  });

  it("imports sanitizeTypedAdvisoryReply alongside the existing, unmodified resolveSanitizedCarsonDisplayMessage import", () => {
    expect(SOURCE).toContain(
      'import { resolveSanitizedCarsonDisplayMessage, sanitizeTypedAdvisoryReply, type DirectToolSuccessResult, type NoteSaveOutcome, type DirectMessageSendOutcome } from "../../lib/carson-direct-tool-override";',
    );
  });

  it("keeps get_calendar_events reachable for typed read-only research/planning — never touched by any redirect", () => {
    expect(SOURCE).not.toContain('get_calendar_events: TYPED_ADVISORY');
    const readBlock = blockBetween(
      'get_calendar_events: (params: Parameters<typeof getCalendarEvents>[0]) => {',
      "  },",
    );
    expect(readBlock).toContain("getCalendarEvents(params)");
  });

  it("leaves typed-history persistence, reconciliation, and Clear Chat completely untouched by this fix", () => {
    const reconcileBlock = blockBetween(
      "const reconcileTypedHistory = useCallback(async (markInterrupted = false)",
      "  useEffect(() => {\n    if (!authenticatedUserId) {",
    );
    expect(reconcileBlock).not.toContain("classifyTypedExecutionRequest");
    expect(reconcileBlock).not.toContain("sanitizeTypedAdvisoryReply");
    expect(reconcileBlock).not.toContain("TYPED_ADVISORY_HOSTING_REQUEST");
    expect(SOURCE).toContain("const clearTypedHistory = useCallback(async () => {");
  });

  it("never touches Talk to Carson's tool registration, routing, or execution — voice guard still returns before any typed-only check", () => {
    const guardBlock = blockBetween(
      "const guardCurrentToolInvocation = (toolName: string, toolArguments?: unknown): string | null => {",
      "    try {",
    );
    const voiceReturnIndex = guardBlock.indexOf("const captureBlock = guardCurrentVoiceCapture(toolName);");
    const typedBlockIndex = guardBlock.indexOf("TYPED_BLOCKED_TOOL_MESSAGES[toolName]");
    expect(voiceReturnIndex).toBeGreaterThan(-1);
    expect(voiceReturnIndex).toBeLessThan(typedBlockIndex);
    // Every real executor call for reminders/calendar/delegation/followup is
    // still present, unconditionally reachable for voice.
    for (const executorCall of [
      "createReminder(params)",
      "createCalendarEvent(params)",
      "sendDelegation(params)",
      "sendFollowup(params)",
    ]) {
      expect(SOURCE).toContain(executorCall);
    }
  });
});

function TYPED_ADVISORY_HOSTING_REQUEST_VALUE(): string {
  return sourceConstant("TYPED_ADVISORY_HOSTING_REQUEST");
}

/**
 * "Send to Carson" (Note cards, 2026-07-26): the widget accepts a queued
 * pendingTypedDraft prop and inserts it into the typed input once a text
 * session is connected — never auto-submitted, so it goes through the exact
 * same sendTypedMessage() path (and the same advisory-only boundary) as
 * anything the owner types directly. See stores/carson.test.ts for the
 * store field itself and routes/Inbox.test.ts for the Note-card handler
 * that queues it.
 */
describe("ElevenLabsAgentWidget — pendingTypedDraft insertion (Send to Carson)", () => {
  function insertionEffectSource(): string {
    return blockBetween(
      "// \"Send to Carson\" (Note cards) queues note text here;",
      "  const ensureTypedHistoryLoaded",
    );
  }

  it("accepts pendingTypedDraft and onPendingTypedDraftConsumed as props", () => {
    expect(SOURCE).toContain("pendingTypedDraft = null,");
    expect(SOURCE).toContain("onPendingTypedDraftConsumed,");
    expect(SOURCE).toMatch(/pendingTypedDraft\?: string \| null;/);
    expect(SOURCE).toMatch(/onPendingTypedDraftConsumed\?: \(\) => void;/);
  });

  it("only inserts once a text session is connected, and never overwrites text the owner already typed", () => {
    const block = insertionEffectSource();
    expect(block).toContain('if (!pendingTypedDraft) return;');
    expect(block).toContain('if (status !== "connected" || channel !== "text") return;');
    expect(block).toContain("if (typedInput.trim()) return;");
    expect(block).toContain("setTypedInput(pendingTypedDraft);");
  });

  it("consumes (reports back) the draft after inserting it, so it cannot re-apply to a later, unrelated typed session", () => {
    const block = insertionEffectSource();
    const setIndex = block.indexOf("setTypedInput(pendingTypedDraft);");
    const consumeIndex = block.indexOf("onPendingTypedDraftConsumed?.();");
    expect(setIndex).toBeGreaterThan(-1);
    expect(consumeIndex).toBeGreaterThan(setIndex);
  });

  it("never auto-submits the draft — inserting it into typedInput does not call sendTypedMessage", () => {
    const block = insertionEffectSource();
    expect(block).not.toContain("sendTypedMessage(");
  });

  it("App.tsx threads pendingTypedDraft from useCarsonStore into the widget, and clears it via setPendingTypedDraft(null) once consumed", () => {
    expect(APP_SOURCE).toMatch(/pendingTypedDraft,\s*\n\s*setPendingTypedDraft,/);
    expect(APP_SOURCE).toContain("pendingTypedDraft={pendingTypedDraft}");
    expect(APP_SOURCE).toContain("onPendingTypedDraftConsumed={() => setPendingTypedDraft(null)}");
  });
});
