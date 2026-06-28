/**
 * carson-direct-tool-override.ts
 *
 * The ElevenLabs agent's spoken/displayed reply (onMessage role:"agent") is a
 * separate LLM generation from our client tool's return value — it can
 * contradict a tool that just succeeded (see create_todo P0: tool returned
 * "Added to your to-do list." while the agent said "I wasn't able to save
 * that."). This module decides when to prefer the tool's own success result
 * over a contradictory agent message, for a short window after the tool ran.
 */

import {
  isSocialAcknowledgement,
  sanitizeCarsonReplyText,
  sanitizeSocialAcknowledgementReply,
} from "./carson-social";

export interface DirectToolSuccessResult {
  toolName: string;
  resultText: string;
  at: string;
  inputSummary?: unknown;
}

const OVERRIDABLE_TOOL_NAMES = new Set(["create_todo", "complete_todo"]);

const OVERRIDE_WINDOW_MS = 15_000;

const FAILURE_LANGUAGE_PATTERN =
  /wasn['’]?t able|couldn['’]?t complete|try again|technical issue|\bsupport\b/i;

export function resolveCarsonDisplayMessage(
  agentMessage: string,
  lastSuccess: DirectToolSuccessResult | null,
  now: number = Date.now(),
): string {
  if (!lastSuccess) return agentMessage;
  if (!OVERRIDABLE_TOOL_NAMES.has(lastSuccess.toolName)) return agentMessage;
  if (!FAILURE_LANGUAGE_PATTERN.test(agentMessage)) return agentMessage;

  const successAt = Date.parse(lastSuccess.at);
  if (Number.isNaN(successAt) || now - successAt > OVERRIDE_WINDOW_MS) {
    return agentMessage;
  }

  return lastSuccess.resultText;
}

interface ResolveSanitizedCarsonDisplayMessageInput {
  agentMessage: string;
  previousUserMessage?: string;
  lastSuccess: DirectToolSuccessResult | null;
  now?: number;
}

export function resolveSanitizedCarsonDisplayMessage({
  agentMessage,
  previousUserMessage = "",
  lastSuccess,
  now = Date.now(),
}: ResolveSanitizedCarsonDisplayMessageInput): string {
  const toolAwareMessage = resolveCarsonDisplayMessage(agentMessage, lastSuccess, now);
  return sanitizeCarsonReplyText(
    isSocialAcknowledgement(previousUserMessage)
      ? sanitizeSocialAcknowledgementReply(toolAwareMessage)
      : toolAwareMessage,
  );
}
