/**
 * carson-custom-llm-orchestration.js
 *
 * C-03 Structural Response Ownership Project — Slice 2.
 *
 * NON-PRODUCTION. Not wired to Production Carson's ElevenLabs agent. This
 * endpoint is the real Custom LLM orchestration loop, built on Stage 2A's
 * proven auth/binding/SSE transport (reused, not reimplemented — see
 * carson-custom-llm-stage2a.js).
 *
 * Locked architecture (C-03, owner-approved):
 *   ElevenLabs sends messages[] + tools[] (OpenAI format)
 *     -> if the latest message is NOT a tool result: call the reasoning
 *        provider. It either selects a registered tool (-> stream tool_calls,
 *        ElevenLabs dispatches to the existing client tool, unchanged) or
 *        produces ordinary conversational text (-> stream it directly, this
 *        IS the final response, one generation, nothing after it).
 *     -> if the latest message IS a tool result: NO second reasoning call.
 *        The tool's own text becomes the natural-mode draft (existing tools
 *        already return natural, Carson-voiced sentences — see C-03 skill
 *        review), or the exact-mode text if the tool declared exactness.
 *        Either way it passes through C-03 no-semantic-upgrade validation
 *        before being finalized. This structurally guarantees no
 *        independent second model generation can ever follow a verified
 *        tool result.
 *
 * Only tools in CARSON_TOOL_ALLOWLIST may ever be exposed or accepted —
 * this replaces Stage 2A's original "no tool surface" contract with
 * "only the explicitly registered Carson tool surface."
 */

import {
  providerSecret,
  equalSecret,
  getBearer,
  verifySessionBinding,
  extractStage2ABindingToken,
} from "./carson-custom-llm-stage2a.js";
import {
  CARSON_TOOL_ALLOWLIST,
  isAllowlistedTool,
  toOpenAiToolsPayload,
} from "./_carson-tool-definitions.js";
import { buildToolExecutionResult, finalizeCarsonResponse, finalizeOrdinaryResponse } from "./_carson-tool-execution-result.js";
import { classifyLegacyToolText, LEGACY_ADAPTER_COVERED_TOOLS } from "./_carson-legacy-tool-result-adapter.js";
import { anthropicReasoningCall } from "./_carson-reasoning-provider.js";
import { CARSON_SYSTEM_PROMPT } from "./_carson-system-prompt.js";
import { randomUUID, createHash } from "node:crypto";

function json(res, status, body) {
  res.status(status).json(body);
}

function turnIdFor(messages) {
  const digest = createHash("sha256").update(JSON.stringify(messages ?? [])).digest("hex").slice(0, 16);
  return `turn_${digest}`;
}

/** The most recent message, and whether it's a tool result awaiting finalization. */
function inspectLatestMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { isToolResult: false };
  const last = messages[messages.length - 1];
  if (last?.role !== "tool") return { isToolResult: false };
  return {
    isToolResult: true,
    toolName: last.name ?? last.tool_name ?? findToolNameFromCall(messages, last.tool_call_id),
    toolText: typeof last.content === "string" ? last.content : "",
  };
}

function findToolNameFromCall(messages, toolCallId) {
  if (!toolCallId) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const call = message?.tool_calls?.find((c) => c.id === toolCallId);
    if (call?.function?.name) return call.function.name;
  }
  return undefined;
}

function sseEvent(completionId, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: "carson-orchestration-slice2",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function streamText(res, completionId, text) {
  res.write(sseEvent(completionId, { role: "assistant" }));
  res.write(sseEvent(completionId, { content: text }));
  res.write(sseEvent(completionId, {}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

function streamToolCall(res, completionId, toolName, toolInput) {
  const toolCallId = `call_${randomUUID()}`;
  res.write(sseEvent(completionId, { role: "assistant" }));
  res.write(
    sseEvent(completionId, {
      tool_calls: [
        {
          index: 0,
          id: toolCallId,
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(toolInput ?? {}) },
        },
      ],
    }),
  );
  res.write(sseEvent(completionId, {}, "tool_calls"));
  res.write("data: [DONE]\n\n");
  res.end();
}

function startSse(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

/**
 * Turns a finalized tool result into ToolExecutionResult without a second
 * reasoning call — see module doc comment for why this is safe and
 * intentional, not a shortcut.
 */
function resolveToolExecutionResult(toolName, toolText) {
  const definition = CARSON_TOOL_ALLOWLIST.find((t) => t.name === toolName);
  const canBeExact = Boolean(definition?.canBeExact);

  // Hosting/execute_instruction exact-output detection: the planner's exact
  // strings are recognizable by the deterministic Hosting workflow shape
  // (approval question, "Shall I send the plan?" etc.) — for this slice,
  // exactness must be explicitly signaled by the tool layer, not guessed
  // here. Until execute_instruction's browser-side result threads an
  // explicit `exact: true` flag through (named follow-up, see report),
  // execute_instruction results are treated as natural, non-exact, in this
  // backend boundary — a conservative default, never the reverse.
  const exact = false;

  let deterministicOutcome;
  if (LEGACY_ADAPTER_COVERED_TOOLS.has(toolName)) {
    deterministicOutcome = classifyLegacyToolText(toolName, toolText);
  }

  return buildToolExecutionResult({
    toolName,
    rawText: toolText,
    deterministicOutcome,
    exact: exact && canBeExact,
  });
}

export function createOrchestrationHandler({
  verifyBinding = verifySessionBinding,
  reason = anthropicReasoningCall,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    let expectedProviderSecret;
    try {
      expectedProviderSecret = providerSecret();
    } catch {
      return json(res, 503, { error: "Provider authentication unavailable" });
    }
    if (!equalSecret(getBearer(req), expectedProviderSecret)) {
      return json(res, 401, { error: "Unauthorized provider" });
    }

    const token = extractStage2ABindingToken(req);
    const binding = verifyBinding(token);
    if (!binding) return json(res, 401, { error: "Invalid or expired session binding" });

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (messages.length === 0) return json(res, 400, { error: "No conversation turns supplied" });

    // Fail-closed tool allowlist: only registered Carson tools may ever be
    // offered to or accepted from the reasoning call, regardless of what
    // ElevenLabs' request body includes.
    const offeredTools = Array.isArray(req.body?.tools) ? req.body.tools : [];
    const rejectedTools = offeredTools
      .map((t) => t?.function?.name)
      .filter((name) => name && !isAllowlistedTool(name));
    if (rejectedTools.length > 0) {
      // Do not silently drop — fail closed with a clear signal instead of
      // guessing which subset was intended.
      return json(res, 400, { error: "Unregistered tool offered", tools: rejectedTools });
    }

    const completionId = `orch_${binding.sid}_${randomUUID().slice(0, 8)}`;
    const turnId = turnIdFor(messages);
    const { isToolResult, toolName, toolText } = inspectLatestMessage(messages);

    startSse(res);

    if (isToolResult) {
      if (!toolName || !isAllowlistedTool(toolName)) {
        // Malformed/unrecognized tool result — fail safe, never guess a
        // success/failure narrative for a tool we don't recognize.
        const finalResponse = finalizeOrdinaryResponse({
          text: "I couldn't confirm that completed. Please try again.",
          turnId,
        });
        streamText(res, completionId, finalResponse.text);
        return;
      }
      const toolResult = resolveToolExecutionResult(toolName, toolText);
      const finalResponse = finalizeCarsonResponse({
        toolResult,
        candidateDraft: toolResult.text, // no second generation — see doc comment
        turnId,
      });
      streamText(res, completionId, finalResponse.text);
      return;
    }

    // Ordinary reasoning turn: decide tool selection or produce a direct reply.
    let reasoningResult;
    try {
      reasoningResult = await reason({
        systemPrompt: CARSON_SYSTEM_PROMPT,
        messages,
        tools: toOpenAiToolsPayload(),
      });
    } catch {
      // Provider failure fails safe: no guessed success, no partial answer.
      const finalResponse = finalizeOrdinaryResponse({
        text: "I couldn't process that just now. Please try again.",
        turnId,
      });
      streamText(res, completionId, finalResponse.text);
      return;
    }

    if (reasoningResult.type === "tool_use") {
      if (!isAllowlistedTool(reasoningResult.toolName)) {
        // The model must never be able to invoke anything off-allowlist.
        const finalResponse = finalizeOrdinaryResponse({
          text: "I can't do that from here. Please try again.",
          turnId,
        });
        streamText(res, completionId, finalResponse.text);
        return;
      }
      streamToolCall(res, completionId, reasoningResult.toolName, reasoningResult.toolInput);
      return;
    }

    const finalResponse = finalizeOrdinaryResponse({ text: reasoningResult.text, turnId });
    streamText(res, completionId, finalResponse.text);
  };
}

export default createOrchestrationHandler();
