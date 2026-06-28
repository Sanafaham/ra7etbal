/**
 * carson-tool-params.ts
 *
 * Defensive parameter extraction for Voice Carson direct client tools,
 * mirroring the pattern that fixed the create_todo P0 (carson-todo-tool-params.ts):
 * the ElevenLabs agent can send the same intent under a different key than the
 * one literal name the code expects (e.g. { description: "..." } instead of
 * { title: "..." }). Each extractor tries the tool's existing exact key FIRST,
 * so current behavior is unchanged, then falls back to plausible synonyms.
 *
 * This module only adds fallback lookup — it does not change what a tool does
 * once it has a value, and it never marks anything successful by itself.
 */

import { extractStringField } from "./carson-todo-tool-params";

export type ToolParams = string | Record<string, unknown> | null | undefined;

/** name/person_name/recipient_name/assignee_name/to — any field identifying a person. */
export function extractPersonNameParam(
  params: ToolParams,
  primaryKey: "name" | "person_name" | "recipient_name" | "assignee_name" = "name",
): string {
  const keys = ["name", "person_name", "recipient_name", "assignee_name", "to"] as const;
  const ordered = [primaryKey, ...keys.filter((k) => k !== primaryKey)];
  return extractStringField(params, ordered);
}

/** message/text/body/content — free-text message content. */
export function extractMessageParam(params: ToolParams): string {
  return extractStringField(params, ["message", "text", "body", "content"]);
}

/** task/instruction/description/text/title — what to do. */
export function extractTaskParam(params: ToolParams): string {
  return extractStringField(params, ["task", "instruction", "description", "text", "title"]);
}

/** note/text/content/description — note body. */
export function extractNoteParam(params: ToolParams): string {
  return extractStringField(params, ["note", "text", "content", "description"]);
}

/** time_text/time/date/when — natural-language or raw time phrase. due_at is
 *  intentionally excluded: it is an ISO-only fallback handled separately by
 *  callers, never as a raw spoken phrase. */
export function extractTimeTextParam(params: ToolParams): string {
  return extractStringField(params, ["time_text", "time", "date", "when"]);
}

/** city/location/place. */
export function extractCityParam(params: ToolParams): string {
  return extractStringField(params, ["city", "location", "place"]);
}

/** query/text/title/note — keyword(s) to match against. */
export function extractQueryParam(params: ToolParams): string {
  return extractStringField(params, ["query", "text", "title", "note"]);
}

/** title/event_title/name/description — calendar event title. */
export function extractCalendarTitleParam(params: ToolParams): string {
  return extractStringField(params, ["title", "event_title", "name", "description"]);
}

/** event_id/id/eventId — the [event_id:xxx] token echoed back by Carson. */
export function extractEventIdParam(params: ToolParams): string {
  return extractStringField(params, ["event_id", "id", "eventId"]);
}

/** instruction/task/message/description/text — what an automation should do. */
export function extractAutomationInstructionParam(params: ToolParams): string {
  return extractStringField(params, ["instruction", "task", "message", "description", "text"]);
}
