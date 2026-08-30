/**
 * _carson-reasoning-provider.js
 *
 * C-03 Structural Response Ownership Project — Slice 2.
 *
 * The real reasoning call, isolated behind a small interface so the
 * orchestration handler and its tests never depend on the network. Follows
 * the same raw-fetch pattern already used elsewhere in this repo
 * (api/anthropic.js) rather than adding a new SDK dependency.
 *
 * Non-production only: this module is imported solely by
 * carson-custom-llm-orchestration.js, which is not wired to Production
 * Carson's ElevenLabs agent.
 */

const ANTHROPIC_MODEL = "claude-sonnet-4-6"; // matches the model already used elsewhere in this repo (see CLAUDE.md)
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * @typedef {{type: "tool_use", toolName: string, toolInput: object} | {type: "text", text: string}} ReasoningResult
 */

/**
 * @param {{systemPrompt: string, messages: Array<{role: string, content: string}>, tools: Array<{name:string, description:string, parameters:object}>}} input
 * @returns {Promise<ReasoningResult>}
 */
export async function anthropicReasoningCall({ systemPrompt, messages, tools }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Reasoning provider is not configured.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: toAnthropicMessages(messages),
        tools: toAnthropicTools(tools),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Reasoning provider returned ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    return parseAnthropicResponse(data);
  } finally {
    clearTimeout(timeout);
  }
}

export function toAnthropicMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message?.role === "user" || message?.role === "assistant" || message?.role === "tool")
    .map((message) => {
      if (message.role === "tool") {
        // Anthropic represents a tool result as a user-turn tool_result block.
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id ?? "unknown",
              content: typeof message.content === "string" ? message.content : "",
            },
          ],
        };
      }
      return { role: message.role, content: typeof message.content === "string" ? message.content : "" };
    });
}

export function toAnthropicTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function parseAnthropicResponse(data) {
  const content = Array.isArray(data?.content) ? data.content : [];
  const toolUse = content.find((block) => block?.type === "tool_use");
  if (toolUse) {
    return { type: "tool_use", toolName: toolUse.name, toolInput: toolUse.input ?? {} };
  }
  const textBlock = content.find((block) => block?.type === "text");
  return { type: "text", text: textBlock?.text ?? "" };
}
