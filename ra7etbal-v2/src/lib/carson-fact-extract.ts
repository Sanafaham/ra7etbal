/**
 * carson-fact-extract.ts
 *
 * Extracts structured durable facts from a Carson voice transcript.
 * The result is validated locally before anything can be written.
 */

import type { TranscriptMessage } from "./carson-summarize";

export interface ExtractedCarsonFact {
  category: string;
  key: string;
  value: string;
  confidence: number;
}

const ALLOWED_CATEGORIES = new Set([
  "identity",
  "preference",
  "communication_style",
  "language",
  "pronunciation",
  "routine",
  "relationship",
  "recurring_responsibility",
  "product_direction",
  "notification_preference",
  "correction",
]);

const MIN_CONFIDENCE = 0.75;
const MAX_FACTS = 5;

export async function extractDurableFacts(
  transcript: TranscriptMessage[],
): Promise<ExtractedCarsonFact[]> {
  const userTurns = transcript
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.message.trim())
    .filter(Boolean);

  console.info("[carson-facts:v3] extract userTurns", userTurns.length);

  if (userTurns.length === 0) return [];

  const prompt = `You are extracting durable structured memory for Carson, a voice AI.

Use ONLY the user's words below. Do not save facts invented, inferred, or merely suggested by Carson.

Extract only durable facts likely to still be true in 30 days.

Save stable preferences, corrections, routines, relationships, pronunciation, product direction, notification preferences, and communication style.

Do NOT save one-time tasks, reminders, delegations, confirmations, weather, today/tomorrow logistics, Daily Brief state, or message/task action history.

Allowed categories:
identity
preference
communication_style
language
pronunciation
routine
relationship
recurring_responsibility
product_direction
notification_preference
correction

Return strict JSON only. No markdown. No prose.
Return at most ${MAX_FACTS} facts.
Minimum confidence is ${MIN_CONFIDENCE}.

Shape:
{
  "facts": [
    {
      "category": "communication_style",
      "key": "compact_answers",
      "value": "User prefers compact, direct answers.",
      "confidence": 0.9
    }
  ]
}

If there are no durable facts, return:
{ "facts": [] }

User transcript:
${userTurns.map((message) => `User: ${message}`).join("\n")}`;

  let res: Response;
  try {
    console.info("[carson-facts:v3] extract api request started");
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    console.error("[carson-facts:v3] extract api request failed");
    return [];
  }

  console.info("[carson-facts:v3] extract api response", res.status);
  if (!res.ok) return [];

  let body: { content?: Array<{ type?: string; text?: string }> };
  try {
    body = await res.json();
  } catch {
    console.error("[carson-facts:v3] extract api response json failed");
    return [];
  }

  const raw = body.content?.[0]?.text?.trim();
  if (!raw) return [];

  const facts = validateFactPayload(raw);
  console.info("[carson-facts:v3] extract validated facts", facts.length);
  return facts;
}

function validateFactPayload(raw: string): ExtractedCarsonFact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    console.error("[carson-facts:v3] extract json parse failed");
    return [];
  }
  console.info("[carson-facts:v3] extract json parse success");

  if (!parsed || typeof parsed !== "object") return [];
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];

  const validated: ExtractedCarsonFact[] = [];
  const seen = new Set<string>();

  for (const item of facts) {
    if (validated.length >= MAX_FACTS) break;
    const fact = validateFact(item);
    if (!fact) continue;

    const dedupeKey = `${fact.category}:${fact.key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    validated.push(fact);
  }

  return validated;
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function validateFact(value: unknown): ExtractedCarsonFact | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const category = normalizeKey(readString(raw.category));
  const key = normalizeKey(readString(raw.key));
  const factValue = cleanValue(readString(raw.value));
  const confidence = readConfidence(raw.confidence);

  if (!category || !key || !factValue) return null;
  if (!ALLOWED_CATEGORIES.has(category)) return null;
  if (confidence < MIN_CONFIDENCE) return null;
  if (isLikelyPollutedFact(factValue)) return null;

  return { category, key, value: factValue, confidence };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function cleanValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 500);
}

function isLikelyPollutedFact(value: string): boolean {
  const lower = value.toLowerCase();

  if (
    /\b(today|tonight|tomorrow|yesterday|right now|this morning|this afternoon|this evening)\b/.test(
      lower,
    )
  ) {
    return true;
  }

  if (
    /\b(reminder|delegated|delegation sent|message sent|sent a message|confirmation|confirmed|follow-up|follow up|task created|created reminder)\b/.test(
      lower,
    )
  ) {
    return true;
  }

  return /\b(ask|tell|message|send|remind|confirm)\s+[\w\s]+?\b(by|at|before|when)\b/.test(
    lower,
  );
}
