/**
 * ops-intelligence.ts
 *
 * Operations Intelligence V1 — Guest Arrival
 *
 * When the user states an outcome ("Guests arrive tomorrow at 12"), Carson
 * infers the required household operation, proposes a task plan, and waits
 * for confirmation before sending anything.
 *
 * Flow:
 *  1. detectHouseholdOutcome(text) → 'guest_arrival' | null
 *  2. buildOperationalPlanFromOutcome(text, people) → ProposedPlan
 *     - Calls Haiku to derive per-person task messages from roles/notes
 *     - Persists the plan to Supabase so it survives session disconnect
 *  3. isConfirmation(text) / isRejection(text) — detect yes/no
 *  4. loadLatestPendingPlan(userId) — recover plan from Supabase after reconnect
 *  5. executeProposedPlan(plan, ...) — builds ExtractedItems directly (no AI
 *     re-extraction), calls savePending + sendWhatsAppTask in parallel
 *  6. markPlanCompleted / markPlanCancelled — update Supabase status
 */

import type { Person } from "../types/person";
import type { ExtractedItem } from "../types/extraction";
import { savePending } from "./save";
import { deliverTaskMessage } from "./delivery";
import { sendDirectMessageRecord } from "./direct-messages";
import { buildDelegationMessage } from "./delegation-message";
import { supabase } from "./supabase";

// ── Types ──────────────────────────────────────────────────────────────────────

export type HouseholdOutcomeType = "guest_arrival";

export interface ProposedTask {
  personId: string;
  personName: string;
  message: string;
}

export interface ProposedPlan {
  /** DB row id — set once persisted */
  dbId?: string;
  outcomeType: HouseholdOutcomeType;
  tasks: ProposedTask[];
  /** Carson's spoken proposal — returned verbatim as executeInstruction result */
  proposalSpeech: string;
  /** Original user utterance */
  sourceText: string;
  /** Unix ms when plan was created — used for 5-minute expiry check */
  createdAt: number;
}

// ── Outcome detection ──────────────────────────────────────────────────────────

const GUEST_ARRIVAL_PATTERNS = [
  /\bguests?\s+(arrive|arriving|coming|will be here|are coming)\b/i,
  /\b(arrival|arrivals)\b.*\bguest/i,
  /\bguest\b.*\b(arrival|arriving|coming|today|tomorrow|tonight|this evening)\b/i,
  /\b(we('re| are) having|expecting)\s+(guests?|visitors?|people over)\b/i,
  /\b(guests?|visitors?)\s+(are|will be)\s+(here|over|visiting)\b/i,
];

export function detectHouseholdOutcome(text: string): HouseholdOutcomeType | null {
  for (const pattern of GUEST_ARRIVAL_PATTERNS) {
    if (pattern.test(text)) return "guest_arrival";
  }
  return null;
}

// ── Confirmation / rejection detection ────────────────────────────────────────

const CONFIRMATION_RE =
  /^\s*(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|send (them|those|it|the messages?)|sounds good|perfect|great|please do|go for it|confirmed?|correct|absolutely|definitely)\s*[.!]?\s*$/i;

const REJECTION_RE =
  /^\s*(no|nope|not yet|cancel|don't send|do not send|hold off|wait|never mind|nevermind|skip it|don't do it)\s*[.!]?\s*$/i;

export function isConfirmation(text: string): boolean {
  return CONFIRMATION_RE.test(text.trim());
}

export function isRejection(text: string): boolean {
  return REJECTION_RE.test(text.trim());
}

// ── Delivery status question detection ───────────────────────────────────────
//
// Detects questions like "Did you send it?", "Did it go through?", "Was it
// delivered?", "Did Christopher get it?". These must NOT fall through to
// executeDelegationFromText — passing a status question to Anthropic
// extraction either creates a duplicate task or returns a failure string,
// which EL's LLM then rephrases as "No, both attempts timed out."
//
// Two broad patterns cover the full range:
//   1. "did/was/has/have/is/can you … send/sent/deliver/reach/go through/receive"
//   2. "did [person] get/receive it"
// Short queries like "sent?" or "go through?" are deliberately excluded since
// they are too vague and could be part of another phrase.

const STATUS_QUESTION_RE =
  /\b(did|was|has|have|is|can)\b.{0,40}\b(sent|send|delivered|deliver|go through|went through|received|receive|get (it|that)|gotten|messaged|reach|reached|confirmed|confirm)\b/i;

export function isStatusQuestion(text: string): boolean {
  return STATUS_QUESTION_RE.test(text.trim());
}

/** Returns true when the plan is older than 5 minutes and should be ignored. */
export function isPlanExpired(plan: ProposedPlan): boolean {
  return Date.now() - plan.createdAt > 5 * 60 * 1000;
}

// ── Supabase persistence ───────────────────────────────────────────────────────

/** Save a newly proposed plan to the DB; returns the row id. */
async function persistPlan(plan: ProposedPlan): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const expiresAt = new Date(plan.createdAt + 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("carson_pending_operations")
    .insert({
      user_id: user.id,
      type: plan.outcomeType,
      summary: plan.proposalSpeech,
      tasks: plan.tasks,
      source_text: plan.sourceText,
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[ops-intelligence] persist failed:", error.message);
    return null;
  }
  return data?.id ?? null;
}

/** Load the latest non-expired pending plan for the user. */
export async function loadLatestPendingPlan(): Promise<ProposedPlan | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("carson_pending_operations")
    .select("*")
    .eq("user_id", user.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  return {
    dbId: data.id as string,
    outcomeType: data.type as HouseholdOutcomeType,
    tasks: (data.tasks ?? []) as ProposedTask[],
    proposalSpeech: data.summary as string,
    sourceText: data.source_text as string,
    createdAt: new Date(data.created_at as string).getTime(),
  };
}

async function markPlanCompleted(dbId: string): Promise<void> {
  await supabase
    .from("carson_pending_operations")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", dbId);
}

async function markPlanCancelled(dbId: string): Promise<void> {
  await supabase
    .from("carson_pending_operations")
    .update({ status: "cancelled" })
    .eq("id", dbId);
}

// ── Plan builder ───────────────────────────────────────────────────────────────

interface AnthropicContent { type: string; text?: string }
interface AnthropicResponse { content?: AnthropicContent[]; error?: { message: string } }

interface PlanAIResponse {
  tasks: Array<{ person_name: string; message: string }>;
  proposal_speech: string;
}

/**
 * Calls Haiku to derive per-person task messages from People roles/notes.
 * Saves the plan to Supabase before returning so it survives disconnect.
 */
export async function buildOperationalPlanFromOutcome(
  text: string,
  people: Person[],
): Promise<ProposedPlan | null> {
  if (people.length === 0) return null;

  const peopleBlock = people
    .map((p) => `- ${p.name} (${p.role || "staff"})${p.notes ? `: ${p.notes}` : ""}`)
    .join("\n");

  const prompt = `You are Carson, the Chief of Staff for a household.

The user said: "${text}"

This indicates guests are arriving. Based on the household team below, generate specific WhatsApp delegation messages for each relevant person. Only include people whose role makes them relevant to guest prep (e.g. housekeeping, cooking, coordination).

Household team:
${peopleBlock}

Rules:
- Write each message as if Carson is sending it directly to that person via WhatsApp
- Be specific and action-oriented, include timing if mentioned
- Skip people with no clear role in guest prep
- 2–3 people maximum

Return ONLY valid JSON, no markdown:
{
  "tasks": [
    { "person_name": "<exact name from team>", "message": "<WhatsApp message text>" }
  ],
  "proposal_speech": "<what Carson speaks aloud proposing the plan — conversational, 1-2 sentences ending with a yes/no question>"
}`;

  let res: Response;
  try {
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch { return null; }

  let body: AnthropicResponse;
  try { body = (await res.json()) as AnthropicResponse; } catch { return null; }

  if (!res.ok || body.error) return null;

  const raw = body.content?.[0]?.text?.trim();
  if (!raw) return null;

  let parsed: PlanAIResponse;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned) as PlanAIResponse;
  } catch { return null; }

  if (!parsed.tasks?.length || !parsed.proposal_speech) return null;

  // Resolve person IDs (case-insensitive match).
  const proposedTasks: ProposedTask[] = [];
  for (const t of parsed.tasks) {
    const person = people.find(
      (p) => p.name.trim().toLowerCase() === t.person_name.trim().toLowerCase(),
    );
    if (!person || !t.message?.trim()) continue;
    proposedTasks.push({ personId: person.id, personName: person.name, message: t.message.trim() });
  }

  if (proposedTasks.length === 0) return null;

  const plan: ProposedPlan = {
    outcomeType: "guest_arrival",
    tasks: proposedTasks,
    proposalSpeech: parsed.proposal_speech,
    sourceText: text,
    createdAt: Date.now(),
  };

  // Persist before returning — survives disconnect.
  const dbId = await persistPlan(plan).catch(() => null);
  if (dbId) plan.dbId = dbId;

  return plan;
}

// ── Plan executor ──────────────────────────────────────────────────────────────

interface ExecutePlanOptions {
  displayName: string | null;
  userId: string;
  people: Person[];
}

/**
 * Executes the confirmed plan without any AI re-extraction.
 *
 * Builds ExtractedItem[] directly from ProposedTask data, saves all items
 * via savePending in one call, then sends WhatsApp messages in parallel.
 * This is much faster than calling executeDelegationFromText per person
 * (which would make N sequential Anthropic API calls).
 */
export async function executeProposedPlan(
  plan: ProposedPlan,
  opts: ExecutePlanOptions,
): Promise<string> {
  const { displayName, userId, people } = opts;

  // Build ExtractedItem[] directly — no AI needed; we already have all info.
  const extractedItems: ExtractedItem[] = plan.tasks.map((task) => ({
    id: crypto.randomUUID(),
    type: "delegation" as const,
    description: task.message,
    assignedTo: task.personName,
    dueAt: null,
    dueText: null,
    // Build suggestedMessage using the deterministic delegation formatter.
    suggestedMessage: (() => {
      const person = people.find(
        (p) => p.name.trim().toLowerCase() === task.personName.toLowerCase(),
      );
      return buildDelegationMessage({
        personName: task.personName,
        taskText: task.message,
        personNotes: person?.notes ?? null,
        ownerName: displayName,
      });
    })(),
    personalNote: null,
    needsPerson: false,
    needsClarification: false,
    clarificationQuestion: null,
  }));

  // savePending creates task rows and message rows in Supabase.
  const saved = await savePending(extractedItems, userId, displayName, people);

  // Build phone lookup map — only for consented recipients.
  const phoneByName = new Map<string, string>();
  const noConsentNames = new Set<string>();
  for (const person of people) {
    const key = person.name?.trim().toLowerCase();
    if (!key) continue;
    if (person.phone && person.whatsapp_opted_in) {
      phoneByName.set(key, person.phone);
    } else if (person.phone && !person.whatsapp_opted_in) {
      noConsentNames.add(key);
    }
  }

  // Send WhatsApp in parallel — skip recipients who have not consented.
  const sendableMessages = saved.messages.filter(
    (m) => !!m.recipient.trim() && !!m.content.trim()
      && !noConsentNames.has(m.recipient.trim().toLowerCase()),
  );

  await Promise.allSettled(
    sendableMessages.map((msg) =>
      !msg.task_id && !msg.confirmation_url
        ? sendDirectMessageRecord({
            source: "ops-intelligence",
            message: msg,
            phone: phoneByName.get(msg.recipient.trim().toLowerCase()) ?? null,
            ownerName: displayName,
          })
        : deliverTaskMessage({
            to: phoneByName.get(msg.recipient.trim().toLowerCase()) ?? null,
            messageText: msg.content,
            confirmationLink: msg.confirmation_url ?? null,
            messageRecordId: msg.id,
            taskId: msg.task_id,
            sendMode: null,
            recipientName: msg.recipient,
            ownerName: displayName,
            imagePath: null,
          }),
    ),
  );

  // Mark the Supabase row as completed (fire-and-forget).
  if (plan.dbId) {
    markPlanCompleted(plan.dbId).catch(() => {});
  }

  const names = plan.tasks.map((t) => t.personName).join(", ");
  return `${names} have the plan. I'll watch for confirmations.`;
}

/** Call when the user rejects a proposed plan. */
export async function rejectProposedPlan(plan: ProposedPlan): Promise<string> {
  if (plan.dbId) {
    markPlanCancelled(plan.dbId).catch(() => {});
  }
  return "Okay, I'll hold off. Just say the word when you're ready.";
}
