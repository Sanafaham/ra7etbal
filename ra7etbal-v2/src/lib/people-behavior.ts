/**
 * people-behavior.ts
 *
 * Automatic behavioral memory for people.
 *
 * Observes completed task history to generate natural-language insights
 * about each person's reliability, speed, and task-type strengths.
 * Insights are written to people.notes via the same path Voice Carson uses.
 *
 * Design constraints:
 * - No new tables. people.notes is the write target.
 * - Minimum 3 completed tasks per person before generating any insight.
 * - Fire-and-forget only — never blocks the UI.
 * - One Haiku call per person, only when they appear in the current input.
 * - Old behavior lines are replaced (not appended) to prevent duplicates.
 */

import type { Task } from "../types/task";
import type { Person } from "../types/person";
import { usePeopleStore } from "../stores/people";

// ── Shared notes helpers (also imported by ElevenLabsAgentWidget) ─────────────

export function mergePersonNotes(
  existing: string | null | undefined,
  addition: string,
): string {
  const existingText = (existing ?? "").trim().replace(/\s+/g, " ");
  const additionText = addition.trim().replace(/\s+/g, " ");
  if (!existingText) return additionText;
  if (existingText.toLowerCase().includes(additionText.toLowerCase())) {
    return existingText;
  }
  return `${existingText}\n${additionText}`.slice(0, 1_000);
}

/**
 * Replace any previously written [Behavior:] line in existing notes with
 * a fresh one. This prevents the same behavioral insight being appended
 * on every session.
 */
export function replaceBehaviorLine(
  existing: string | null | undefined,
  newBehaviorLine: string,
): string {
  const existingText = (existing ?? "").trim();
  // Strip any previously written behavior annotation line(s).
  const stripped = existingText
    .split("\n")
    .filter((line) => !line.trim().startsWith("[Behavior:"))
    .join("\n")
    .trim();
  const final = stripped ? `${stripped}\n${newBehaviorLine}` : newBehaviorLine;
  return final.slice(0, 1_000);
}

// ── Behavior computation ──────────────────────────────────────────────────────

export interface PersonBehaviorSummary {
  personName: string;
  completedCount: number;
  pendingCount: number;
  /** Average hours between task creation and confirmation. null if no completed tasks. */
  avgConfirmHours: number | null;
  /** Fraction of delegations that reached done status. 0–1. */
  confirmRate: number;
  /** Fraction of delegations that needed a follow-up nudge. 0–1. */
  escalationRate: number;
  /** Task type words that appear most in completed task descriptions. */
  reliableTaskKeywords: string[];
}

/** Minimum completed tasks before we generate an insight. */
const MIN_COMPLETED = 3;

/**
 * Pure function — no I/O. Computes behavioral stats from task history.
 * Returns null when there is insufficient data.
 */
export function computePersonBehavior(
  personName: string,
  tasks: Task[],
): PersonBehaviorSummary | null {
  const name = personName.trim().toLowerCase();
  const assigned = tasks.filter(
    (t) =>
      t.assigned_to?.trim().toLowerCase() === name &&
      (t.type === "delegation" || t.type === "followup"),
  );

  if (assigned.length === 0) return null;

  const completed = assigned.filter((t) => t.status === "done");
  if (completed.length < MIN_COMPLETED) return null;

  const pending = assigned.filter((t) => t.status === "pending");

  // Average confirmation time (hours).
  const confirmTimes = completed
    .filter((t) => t.confirmed_at && t.created_at)
    .map((t) => {
      const ms =
        new Date(t.confirmed_at!).getTime() - new Date(t.created_at).getTime();
      return ms / (1000 * 60 * 60); // hours
    })
    .filter((h) => h >= 0 && h < 720); // ignore implausible values (>30 days)

  const avgConfirmHours =
    confirmTimes.length > 0
      ? confirmTimes.reduce((a, b) => a + b, 0) / confirmTimes.length
      : null;

  const confirmRate = assigned.length > 0 ? completed.length / assigned.length : 0;

  const escalated = assigned.filter(
    (t) => t.escalated_at != null || t.followup_sent_at != null,
  );
  const escalationRate =
    assigned.length > 0 ? escalated.length / assigned.length : 0;

  // Extract keyword clusters from completed task descriptions.
  const reliableTaskKeywords = extractReliableKeywords(
    completed.map((t) => t.description),
  );

  return {
    personName: personName.trim(),
    completedCount: completed.length,
    pendingCount: pending.length,
    avgConfirmHours,
    confirmRate,
    escalationRate,
    reliableTaskKeywords,
  };
}

/** Simple keyword extraction — surfaces nouns that appear ≥2 times. */
function extractReliableKeywords(descriptions: string[]): string[] {
  const stopWords = new Set([
    "the", "a", "an", "to", "and", "or", "for", "of", "in", "on", "at",
    "is", "are", "was", "be", "it", "this", "that", "with", "from", "by",
    "make", "get", "do", "please", "need", "check", "send", "tell", "ask",
    "make sure", "ensure",
  ]);
  const freq: Record<string, number> = {};
  for (const desc of descriptions) {
    const words = desc
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));
    for (const w of words) {
      freq[w] = (freq[w] ?? 0) + 1;
    }
  }
  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

// ── Insight generation ────────────────────────────────────────────────────────

/**
 * Calls Haiku to generate a 1–2 sentence natural-language behavioral note
 * about a person, based on observed task history stats.
 *
 * Returns null when data is insufficient or the model finds nothing useful.
 * Never throws — safe to call fire-and-forget.
 */
export async function generateBehaviorInsight(
  summary: PersonBehaviorSummary,
): Promise<string | null> {
  const speedLabel =
    summary.avgConfirmHours === null
      ? "unknown"
      : summary.avgConfirmHours < 2
      ? "very fast (under 2 hours)"
      : summary.avgConfirmHours < 8
      ? "same day"
      : summary.avgConfirmHours < 24
      ? "within a day"
      : "slow (often more than a day)";

  const reliabilityLabel =
    summary.confirmRate >= 0.85
      ? "highly reliable"
      : summary.confirmRate >= 0.6
      ? "generally reliable"
      : "sometimes unreliable";

  const escalationLabel =
    summary.escalationRate >= 0.5
      ? "often needs follow-up"
      : summary.escalationRate >= 0.25
      ? "occasionally needs follow-up"
      : "rarely needs follow-up";

  const keywordsLine =
    summary.reliableTaskKeywords.length > 0
      ? `Strongest task types: ${summary.reliableTaskKeywords.join(", ")}.`
      : "";

  const prompt = `You are writing a private behavioral note about a household staff member for a personal chief-of-staff app.

Based on the data below, write exactly ONE sentence (max 20 words) describing this person's behavioral pattern.
The sentence must start with "[Behavior:" and end with "]".
Write only what is clearly supported by the data.
Do not invent or speculate. Do not repeat numbers. Use natural language only.
If the data does not support a clear pattern, return: NULL

Person: ${summary.personName}
Completed tasks: ${summary.completedCount}
Reliability: ${reliabilityLabel} (${Math.round(summary.confirmRate * 100)}% confirm rate)
Response speed: ${speedLabel}
Follow-up frequency: ${escalationLabel}
${keywordsLine}

Examples of good output:
[Behavior: Grace responds quickly and rarely needs follow-up.]
[Behavior: Christopher often needs reminders before confirming tasks.]
[Behavior: Nasira reliably handles laundry and kitchen tasks.]

Return only the behavior line or NULL:`;

  let res: Response;
  try {
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 80,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let body: { content?: Array<{ type?: string; text?: string }> };
  try {
    body = await res.json();
  } catch {
    return null;
  }

  const text = body.content?.[0]?.text?.trim();
  if (!text || text === "NULL" || !text.startsWith("[Behavior:")) return null;
  return text;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * For each person mentioned in `inputText`, compute behavioral stats from
 * `tasks` and write a [Behavior:] insight line to people.notes.
 *
 * - Only people present in `people` list are checked.
 * - Minimum 3 completed tasks required per person.
 * - Fire-and-forget safe. All errors are caught internally.
 * - Uses people store update() for atomic write + cache refresh.
 */
export async function updatePeopleInsightsFromTasks(
  inputText: string,
  people: Person[],
  tasks: Task[],
): Promise<void> {
  const lower = inputText.toLowerCase();

  // Narrow to people whose names appear in the input text.
  const mentioned = people.filter((p) =>
    p.name.trim() && lower.includes(p.name.trim().toLowerCase()),
  );
  if (mentioned.length === 0) return;

  for (const person of mentioned) {
    try {
      const behaviorSummary = computePersonBehavior(person.name, tasks);
      if (!behaviorSummary) continue; // not enough data

      const insight = await generateBehaviorInsight(behaviorSummary);
      if (!insight) continue;

      const updatedNotes = replaceBehaviorLine(person.notes, insight);
      if (updatedNotes === (person.notes ?? "").trim()) continue; // no change

      await usePeopleStore.getState().update(person.id, { notes: updatedNotes });
    } catch {
      // best effort — never propagate
    }
  }
}
