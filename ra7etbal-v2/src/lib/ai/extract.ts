import type { Person } from "../../types/person";
import type {
  ExtractedItem,
  ExtractionResult,
  ItemType,
} from "../../types/extraction";
import { buildExtractionPrompt } from "./extract-prompt";
import { applyRolePrecedence } from "./role-precedence";

/**
 * AI extraction
 *
 * POSTs the v1-proven prompt to /api/anthropic (the Vercel serverless function
 * that proxies Anthropic with the API key), then parses + validates the
 * response. Errors are normalised so the UI can render them directly.
 *
 * Validation is strict: we drop malformed items rather than crashing the
 * whole flow, but if the response is structurally broken we throw so the
 * Review screen never opens with garbage.
 */

// Sonnet 4.6 — needed because Haiku 4.5 was surface-pattern-matching on
// "Tell X" and ignoring the role-precedence rule. Sonnet follows the
// multi-step classification reliably.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

const VALID_TYPES = new Set<ItemType>([
  "action",
  "reminder",
  "message",
  "delegation",
  "decision",
  "followup",
  "errand",
  "parked",
]);

export async function extractItems(
  text: string,
  people: Person[],
  ownerName?: string,
): Promise<ExtractionResult> {
  const prompt = buildExtractionPrompt(text, people, ownerName);

  let res: Response;
  try {
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    throw err instanceof TypeError
      ? new Error("Network issue. Please check your connection.")
      : err;
  }

  let body: AnthropicResponse;
  try {
    body = (await res.json()) as AnthropicResponse;
  } catch {
    throw new Error("Couldn't read the AI response. Please try again.");
  }

  if (!res.ok) {
    const msg = body?.error?.message || `AI request failed (${res.status}).`;
    throw new Error(msg);
  }
  if (body.error) {
    throw new Error(body.error.message || "AI request failed. Please try again.");
  }

  const raw = body.content?.[0]?.text?.trim();
  if (!raw) {
    throw new Error("The AI returned an empty response. Please try again.");
  }

  const result = parseResult(raw);
  const extracted = applyPastReminderDueFallback(result.extracted, text);
  // Deterministic safety net for the role-precedence rule. The prompt asks
  // the model to promote message->delegation when the recipient's role is
  // operational for the topic; this catches the residual misclassifications.
  return {
    ...result,
    extracted: applyRolePrecedence(extracted, people, text),
  };
}

// ---------------------------------------------------------------------------

function parseResult(raw: string): ExtractionResult {
  // Models sometimes wrap JSON in ```json fences despite instructions otherwise.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("The AI returned something Ra7etBal couldn't parse. Please try again.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("The AI returned an unexpected shape. Please try again.");
  }

  const obj = parsed as { extracted?: unknown; summary?: unknown };
  if (!Array.isArray(obj.extracted)) {
    throw new Error("The AI didn't return any items. Please try again.");
  }

  const items: ExtractedItem[] = [];
  for (let i = 0; i < obj.extracted.length; i++) {
    const item = obj.extracted[i];
    const cleanedItem = normalizeItem(item, i);
    if (cleanedItem) items.push(cleanedItem);
  }

  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : "Here's what I picked up.";

  return { extracted: items, summary };
}

function normalizeItem(value: unknown, index: number): ExtractedItem | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  const description =
    typeof v.description === "string" && v.description.trim()
      ? v.description.trim()
      : null;
  if (!description) return null;

  const typeRaw = typeof v.type === "string" ? v.type.trim().toLowerCase() : "";
  const type: ItemType = VALID_TYPES.has(typeRaw as ItemType)
    ? (typeRaw as ItemType)
    : "action";

  const id =
    typeof v.id === "string" && v.id.trim()
      ? v.id.trim()
      : `item_${index}_${Math.random().toString(36).slice(2, 8)}`;

  // assignedTo: string | null. Coerce JSON null/"null"/"" → null.
  let assignedTo: ExtractedItem["assignedTo"] = null;
  if (typeof v.assignedTo === "string") {
    const trimmed = v.assignedTo.trim();
    if (trimmed && trimmed.toLowerCase() !== "null") {
      assignedTo = trimmed;
    }
  }
  if (type === "reminder" && assignedTo == null) {
    assignedTo = "__me__";
  }

  const suggestedMessage =
    typeof v.suggestedMessage === "string" && v.suggestedMessage.trim()
      ? v.suggestedMessage.trim()
      : null;
  const personalNote =
    typeof v.personalNote === "string" && v.personalNote.trim()
      ? v.personalNote.trim()
      : null;
  const dueText =
    typeof v.dueText === "string" && v.dueText.trim()
      ? v.dueText.trim()
      : null;
  const dueAtRaw =
    typeof v.dueAt === "string" && v.dueAt.trim()
      ? v.dueAt.trim()
      : typeof v.due_at === "string" && v.due_at.trim()
        ? v.due_at.trim()
        : null;
  const dueAt =
    dueAtRaw && !Number.isNaN(new Date(dueAtRaw).getTime())
      ? dueAtRaw
      : null;

  return {
    id,
    type,
    description,
    assignedTo,
    dueAt,
    dueText,
    suggestedMessage,
    personalNote,
    needsPerson: v.needsPerson === true,
    needsClarification: v.needsClarification === true,
    clarificationQuestion:
      typeof v.clarificationQuestion === "string" && v.clarificationQuestion.trim()
        ? v.clarificationQuestion.trim()
        : null,
  };
}

function applyPastReminderDueFallback(
  items: ExtractedItem[],
  sourceText: string,
): ExtractedItem[] {
  const missingDueReminders = items.filter(
    (item) => item.type === "reminder" && !item.dueAt,
  );
  if (missingDueReminders.length === 0) return items;

  const inferred = inferPastDue(sourceText);
  if (!inferred) return items;

  return items.map((item) => {
    if (item.type !== "reminder" || item.dueAt) return item;
    return {
      ...item,
      dueAt: inferred.dueAt,
      dueText: item.dueText ?? inferred.dueText,
      needsClarification:
        item.clarificationQuestion === "Due date not specified."
          ? false
          : item.needsClarification,
      clarificationQuestion:
        item.clarificationQuestion === "Due date not specified."
          ? null
          : item.clarificationQuestion,
    };
  });
}

function inferPastDue(text: string): { dueText: string; dueAt: string } | null {
  const yesterday = /\byesterday\b/i.exec(text);
  if (yesterday) {
    return {
      dueText: "Yesterday",
      dueAt: pastDateAtNine(1).toISOString(),
    };
  }

  const daysAgo = /\b(\d{1,3})\s+days?\s+ago\b/i.exec(text);
  if (daysAgo) {
    const days = Number.parseInt(daysAgo[1], 10);
    if (Number.isFinite(days) && days > 0) {
      return {
        dueText: daysAgo[0],
        dueAt: pastDateAtNine(days).toISOString(),
      };
    }
  }

  const lastWeekday =
    /\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(
      text,
    );
  if (lastWeekday) {
    const weekday = weekdayIndex(lastWeekday[1]);
    const date = previousWeekdayAtNine(weekday);
    return {
      dueText: `Last ${capitalize(lastWeekday[1])}`,
      dueAt: date.toISOString(),
    };
  }

  return null;
}

function pastDateAtNine(daysAgo: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(9, 0, 0, 0);
  return date;
}

function previousWeekdayAtNine(targetWeekday: number): Date {
  const date = new Date();
  const current = date.getDay();
  const delta = ((current - targetWeekday + 7) % 7) || 7;
  date.setDate(date.getDate() - delta);
  date.setHours(9, 0, 0, 0);
  return date;
}

function weekdayIndex(value: string): number {
  return [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ].indexOf(value.toLowerCase());
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
