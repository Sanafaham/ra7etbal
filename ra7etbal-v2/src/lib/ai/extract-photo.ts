import type { Person } from "../../types/person";
import type { ExtractionResult, ExtractedItem, ItemType } from "../../types/extraction";
import { buildExtractionPrompt } from "./extract-prompt";
import { applyRolePrecedence } from "./role-precedence";
import { applyNoteRouting } from "./note-routing";
import { applyTodoRouting } from "./todo-routing";
import { resizeImage } from "../image-upload";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;

const VALID_TYPES = new Set<ItemType>([
  "action", "reminder", "message", "delegation",
  "decision", "followup", "errand", "parked",
]);

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

/**
 * Extracts actionable items from a photo using Anthropic vision.
 * Sends the image alongside the full extraction prompt so the model
 * reads all visible text and returns the standard ExtractedItem[] JSON.
 */
export async function extractItemsFromPhoto(
  file: File,
  people: Person[],
  ownerName?: string,
): Promise<ExtractionResult> {
  // Resize to keep payload reasonable, then convert to base64.
  const blob = await resizeImage(file);
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);

  const prompt = buildExtractionPrompt(
    "(See the attached image — read all visible text, notes, lists, tasks, and items, and extract every actionable item from them.)",
    people,
    ownerName,
  );

  let res: Response;
  try {
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
            { type: "text", text: prompt },
          ],
        }],
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
  if (!raw) throw new Error("The AI returned an empty response. Please try again.");

  return parseAndProcess(raw, people);
}

// ---------------------------------------------------------------------------

function parseAndProcess(raw: string, people: Person[]): ExtractionResult {
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
    const item = normalizeItem(obj.extracted[i], i);
    if (item) items.push(item);
  }

  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : "Here's what I found in the photo.";

  const withRolePrecedence = applyRolePrecedence(items, people, "");
  const withNoteRouting = applyNoteRouting(withRolePrecedence, items.map((item) => item.description).join("\n"));

  return {
    extracted: applyTodoRouting(withNoteRouting),
    summary,
  };
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

  let assignedTo: ExtractedItem["assignedTo"] = null;
  if (typeof v.assignedTo === "string") {
    const trimmed = v.assignedTo.trim();
    if (trimmed && trimmed.toLowerCase() !== "null") assignedTo = trimmed;
  }
  if (type === "reminder" && assignedTo == null) assignedTo = "__me__";

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
    id, type, description, assignedTo, dueAt, dueText,
    suggestedMessage, personalNote,
    needsPerson: v.needsPerson === true,
    needsClarification: v.needsClarification === true,
    clarificationQuestion:
      typeof v.clarificationQuestion === "string" && v.clarificationQuestion.trim()
        ? v.clarificationQuestion.trim()
        : null,
  };
}
