/**
 * carson-todo-tool-params.ts
 *
 * Defensive parameter parsing for the create_todo / complete_todo voice
 * client tools, mirroring the existing execute_instruction pattern in
 * ElevenLabsAgentWidget.tsx (extractInstructionParam): the ElevenLabs agent
 * may not send exactly {title} or {query} — a bare string, or a
 * differently-named field, are both plausible depending on how the tool is
 * invoked.
 *
 * Root cause of a live P0: when the expected key was missing,
 * createTodoTool/completeTodoTool used to return an internal-sounding
 * string ("I did not receive a to-do title...") with no Supabase call ever
 * made — the model then dramatized that into an unrelated tech-support
 * deflection. Trying every plausible key here means a real to-do
 * title/query is found whenever the agent sent one under any reasonable
 * name, instead of only one exact key.
 */

export type CreateTodoParams =
  | string
  | {
      title?: unknown;
      text?: unknown;
      item?: unknown;
      todo?: unknown;
      name?: unknown;
      description?: unknown;
      details?: unknown;
      note?: unknown;
    }
  | null
  | undefined;

export type CompleteTodoParams =
  | string
  | {
      query?: unknown;
      title?: unknown;
      text?: unknown;
      item?: unknown;
      todo?: unknown;
      name?: unknown;
    }
  | null
  | undefined;

export function extractStringField(params: unknown, keys: readonly string[]): string {
  if (typeof params === "string") return params;
  if (!params || typeof params !== "object") return "";

  for (const key of keys) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function extractTodoTitleParam(params: CreateTodoParams): string {
  return extractStringField(params, ["title", "text", "item", "todo", "name"]);
}

export function extractTodoDescriptionParam(params: CreateTodoParams): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const value = extractStringField(params, ["description", "details", "note"]);
  return value || undefined;
}

export function extractTodoQueryParam(params: CompleteTodoParams): string {
  return extractStringField(params, ["query", "title", "text", "item", "todo", "name"]);
}
