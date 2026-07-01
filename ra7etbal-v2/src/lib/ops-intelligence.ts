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

const OPERATING_AUTHORITY_RE =
  /\b(handle what you can|handle it|take care of it|run this|coordinate this|make sure everything is ready|make (?:tonight|today|tomorrow|this evening) run smoothly)\b/i;

export function hasOperatingAuthority(text: string): boolean {
  return OPERATING_AUTHORITY_RE.test(text.trim());
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

type GuestPrepDomain = "dinner" | "hospitality" | "coordination" | "transport";

interface GuestPrepOwner {
  domain: GuestPrepDomain;
  person: Person;
}

// Carson (the assistant) must never be treated as a household recipient. If a
// proposal ever names "Carson"/"assistant" — an AI hallucination or a stray
// contact — it is filtered out before any task is created or any WhatsApp is
// attempted, so Carson can never message itself (and never surface a spurious
// "recipient phone number is missing").
const ASSISTANT_RECIPIENT_RE = /^\s*(?:carson|the assistant|assistant)\s*$/i;

export function isAssistantRecipientName(name: string | null | undefined): boolean {
  return ASSISTANT_RECIPIENT_RE.test((name ?? "").trim());
}

const DINNER_ROLE_RE = /\b(cook|chef|kitchen)\b/i;
const DINNER_TOPIC_RE = /\b(dinner|menu|meal|food|cook|kitchen)\b/i;
const HOSPITALITY_ROLE_RE = /\b(housekeeper|house\s*keeper|maid|cleaner|hospitality|host|decor|flower)\b/i;
const HOSPITALITY_TOPIC_RE = /\b(flowers?|hospitality|guest\s*room|setup|table|decor|welcome|hosting)\b/i;
const COORDINATION_ROLE_RE = /\b(coordinator|coordination|house\s*manager|household\s*manager|estate\s*manager|manager|assistant|\bpa\b|\bea\b)\b/i;
const COORDINATION_TOPIC_RE = /\b(coordinate|follow\s*up|manage|supervise|oversee|check\s*in)\b/i;
const TRANSPORT_ROLE_RE = /\b(driver|chauffeur)\b/i;
const TRANSPORT_TOPIC_RE = /\b(transport|car|drive|driving|pick\s*up|drop\s*off|airport|errands?)\b/i;

function personText(person: Person): string {
  return [
    person.role,
    person.responsibilities,
    person.notes,
    person.delegation_guidance,
    person.communication_style,
  ]
    .filter(Boolean)
    .join(" ");
}

function findGuestPrepOwner(
  people: Person[],
  domain: GuestPrepDomain,
  excluded = new Set<string>(),
): GuestPrepOwner | null {
  const candidates = people.filter(
    (person) => !excluded.has(person.id) && !isAssistantRecipientName(person.name),
  );
  const ranked = candidates
    .map((person) => {
      const text = personText(person);
      let score = 0;

      if (domain === "dinner") {
        if (DINNER_ROLE_RE.test(person.role)) score += 6;
        if (DINNER_TOPIC_RE.test(text)) score += 3;
      } else if (domain === "hospitality") {
        if (HOSPITALITY_ROLE_RE.test(person.role)) score += 6;
        if (HOSPITALITY_TOPIC_RE.test(text)) score += 3;
        if (DINNER_ROLE_RE.test(person.role)) score -= 4;
        if (TRANSPORT_ROLE_RE.test(person.role)) score -= 4;
      } else if (domain === "transport") {
        if (TRANSPORT_ROLE_RE.test(person.role)) score += 6;
        if (TRANSPORT_TOPIC_RE.test(text)) score += 3;
      } else {
        if (COORDINATION_ROLE_RE.test(person.role)) score += 6;
        if (COORDINATION_TOPIC_RE.test(text)) score += 3;
        if (TRANSPORT_ROLE_RE.test(person.role)) score -= 4;
      }

      return { person, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0]?.person;
  return best ? { domain, person: best } : null;
}

/**
 * Extracts the shared event context from the user's utterance (e.g. "We have
 * guests coming tomorrow for afternoon tea") by dropping any operating-
 * authority clause ("Handle what you can") and rephrasing first-person
 * pronouns so the sentence reads naturally when sent to someone else.
 */
function extractSharedEventContext(sourceText: string): string {
  const context = sourceText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !OPERATING_AUTHORITY_RE.test(sentence))
    .join(" ")
    .replace(/[.!?]+$/, "")
    .trim();

  if (!context) return "";

  return context
    .replace(/\bI'm\b/gi, "We're")
    .replace(/\bI've\b/gi, "We've")
    .replace(/\bI\b/g, "We")
    .replace(/\bmy\b/gi, "our");
}

export function buildDeterministicGuestPreparationTasks(
  people: Person[],
  sourceText = "",
): ProposedTask[] {
  const used = new Set<string>();
  const owners: GuestPrepOwner[] = [];

  const dinner = findGuestPrepOwner(people, "dinner", used);
  if (dinner) {
    owners.push(dinner);
    used.add(dinner.person.id);
  }

  const hospitality = findGuestPrepOwner(people, "hospitality", used);
  if (hospitality) {
    owners.push(hospitality);
    used.add(hospitality.person.id);
  }

  const coordination = findGuestPrepOwner(people, "coordination", used);
  if (coordination) {
    owners.push(coordination);
    used.add(coordination.person.id);
  }

  // Transport standby — a driver/chauffeur stands by in case guests need a
  // ride. Included last so it never displaces a core prep owner. Do NOT drop
  // this: the deterministic normalizer replaces AI-proposed tasks wholesale,
  // so omitting transport here would silently remove a valid standby role.
  const transport = findGuestPrepOwner(people, "transport", used);
  if (transport) owners.push(transport);

  if (new Set(owners.map((owner) => owner.person.id)).size < 2) return [];

  const dinnerName = dinner?.person.name ?? "the dinner owner";
  const hospitalityName = hospitality?.person.name ?? "the hospitality owner";
  const context = extractSharedEventContext(sourceText);
  const withContext = (instruction: string) =>
    context ? `${context}. ${instruction}` : instruction;

  return owners.map(({ domain, person }) => {
    if (domain === "dinner") {
      return {
        personId: person.id,
        personName: person.name,
        message: withContext("Please confirm the menu and prepare dinner."),
      };
    }

    if (domain === "hospitality") {
      return {
        personId: person.id,
        personName: person.name,
        message: withContext("Please prepare the flowers and hospitality setup."),
      };
    }

    if (domain === "transport") {
      return {
        personId: person.id,
        personName: person.name,
        message: withContext("Please stand by for transport in case the guests need a ride."),
      };
    }

    return {
      personId: person.id,
      personName: person.name,
      message: withContext(
        `Please coordinate with ${dinnerName} and ${hospitalityName} and confirm everything is ready.`,
      ),
    };
  });
}

export function normalizeGuestPreparationPlan(
  plan: ProposedPlan,
  people: Person[],
): ProposedPlan {
  if (plan.outcomeType !== "guest_arrival") return plan;

  const deterministicTasks = buildDeterministicGuestPreparationTasks(people, plan.sourceText);
  if (deterministicTasks.length < 2) return plan;

  const names = deterministicTasks.map((task) => task.personName);
  return {
    ...plan,
    tasks: deterministicTasks,
    proposalSpeech:
      names.length === 1
        ? `I can handle this with ${names[0]}. Should I send it?`
        : `I can split this between ${formatNameList(names)}. Should I send it?`,
  };
}

function formatNameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
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
    // Never let the assistant be proposed as a recipient, even if the model
    // hallucinates "Carson" as a team member.
    if (isAssistantRecipientName(t.person_name)) continue;
    const person = people.find(
      (p) => p.name.trim().toLowerCase() === t.person_name.trim().toLowerCase(),
    );
    if (!person || isAssistantRecipientName(person.name) || !t.message?.trim()) continue;
    proposedTasks.push({ personId: person.id, personName: person.name, message: t.message.trim() });
  }

  if (proposedTasks.length === 0) return null;

  const plan = normalizeGuestPreparationPlan({
    outcomeType: "guest_arrival",
    tasks: proposedTasks,
    proposalSpeech: parsed.proposal_speech,
    sourceText: text,
    createdAt: Date.now(),
  }, people);

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

// Idempotency registry — a given plan may be executed at most once for the life
// of the session. ElevenLabs frequently double-fires the confirmation tool call
// ("Yes" → execute_instruction twice), and a plan can also be re-loaded from the
// DB after a reconnect. Without this guard, a single approval could send the
// same WhatsApps twice. We claim the key synchronously (before any await) so a
// concurrent second call is rejected immediately. The key persists even when a
// send fails: we never auto-retry, so one approval == one send attempt.
const executedPlanKeys = new Set<string>();

function planIdempotencyKey(plan: ProposedPlan): string {
  if (plan.dbId) return `db:${plan.dbId}`;
  const taskSignature = plan.tasks
    .map((task) => `${task.personId}:${task.message}`)
    .join("|");
  return `text:${plan.sourceText}::${taskSignature}`;
}

/** Test-only: clears the idempotency registry between cases. */
export function resetExecutedPlanRegistryForTest(): void {
  executedPlanKeys.clear();
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

  // Idempotency — claim the plan synchronously before any await. A duplicate
  // approval (EL double-fire, DB re-load) is a no-op that sends nothing.
  const idempotencyKey = planIdempotencyKey(plan);
  if (executedPlanKeys.has(idempotencyKey)) {
    return "I already sent that plan. I won't send it again.";
  }
  executedPlanKeys.add(idempotencyKey);

  // Drop any assistant recipient defensively — Carson must never message itself.
  const deliverableTasks = plan.tasks.filter(
    (task) => !isAssistantRecipientName(task.personName),
  );
  if (deliverableTasks.length === 0) {
    return "There's no one to send this to. Tell me who should handle it.";
  }

  // Build ExtractedItem[] directly — no AI needed; we already have all info.
  const extractedItems: ExtractedItem[] = deliverableTasks.map((task) => ({
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
  const noConsentMessages = saved.messages.filter(
    (m) => !!m.recipient.trim() && noConsentNames.has(m.recipient.trim().toLowerCase()),
  );

  const sendResults = await Promise.allSettled(
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

  const sentNames: string[] = [];
  const failedSends: Array<{ recipient: string; reason: string }> = noConsentMessages.map((msg) => ({
    recipient: msg.recipient,
    reason: "WhatsApp consent not recorded",
  }));

  for (let i = 0; i < sendableMessages.length; i++) {
    const msg = sendableMessages[i];
    const result = sendResults[i];
    if (result.status === "fulfilled" && result.value.success) {
      sentNames.push(msg.recipient);
      continue;
    }
    const reason =
      result.status === "rejected"
        ? result.reason instanceof Error ? result.reason.message : "send failed"
        : (result.value.error ?? "delivery failed");
    failedSends.push({ recipient: msg.recipient, reason });
  }

  // Mark the Supabase row as completed (fire-and-forget).
  if (plan.dbId) {
    markPlanCompleted(plan.dbId).catch(() => {});
  }

  if (failedSends.length === 0) {
    const names = sentNames.length > 0 ? sentNames.join(", ") : deliverableTasks.map((t) => t.personName).join(", ");
    return `${names} have the plan. I'll watch for confirmations.`;
  }

  const parts: string[] = [];
  if (sentNames.length > 0) {
    parts.push(`${sentNames.join(", ")} ${sentNames.length === 1 ? "has" : "have"} the plan`);
  }
  for (const failure of failedSends) {
    parts.push(`${failure.recipient} was NOT messaged — ${failure.reason}`);
  }
  return `${parts.join(". ")}.`;
}

/** Call when the user rejects a proposed plan. */
export async function rejectProposedPlan(plan: ProposedPlan): Promise<string> {
  if (plan.dbId) {
    markPlanCancelled(plan.dbId).catch(() => {});
  }
  return "Okay, I'll hold off. Just say the word when you're ready.";
}

// ── Pending-plan approval resolution ─────────────────────────────────────────

export type PendingPlanDecision = "confirm" | "reject" | "hold";

/**
 * Decides how a pending, awaiting-approval plan should be treated, based on the
 * user's VERBATIM reply.
 *
 * Root cause of the P0 "Yes doesn't send" failure: the approval leg used to key
 * off the ElevenLabs-rephrased instruction param. EL frequently rewrites a bare
 * "Yes" into a fuller sentence ("please send them to everyone"), which fails a
 * strict confirmation match — so the stored plan was silently abandoned and the
 * turn fell through to extraction, which failed. Deciding from the verbatim
 * transcript makes approval robust to that rephrasing.
 *
 * Empty or noisy replies return "hold" so the pending plan is preserved — never
 * cleared and never executed on ambiguous input.
 */
export function resolvePendingPlanDecision(
  verbatimReply: string | null | undefined,
): PendingPlanDecision {
  const text = (verbatimReply ?? "").trim();
  if (!text) return "hold";
  if (isRejection(text)) return "reject";
  if (isConfirmation(text)) return "confirm";
  return "hold";
}

export interface PendingPlanTurnResult {
  action: "executed" | "cancelled" | "held";
  /** Spoken summary to return to the caller — null when the turn is held. */
  summary: string | null;
  /** True when the caller should clear its cached pending plan. */
  clearPlan: boolean;
}

/**
 * End-to-end handler for a turn taken while a plan is awaiting approval.
 *
 * - Expired plan → held, and the caller clears its cache.
 * - Verbatim rejection → cancel the plan, clear the cache.
 * - Verbatim confirmation → execute the EXACT stored plan (all sends), clear.
 * - Anything else (empty/noisy) → held, plan preserved for a later turn.
 */
export async function handlePendingPlanTurn(
  verbatimReply: string | null | undefined,
  plan: ProposedPlan,
  opts: ExecutePlanOptions,
): Promise<PendingPlanTurnResult> {
  if (isPlanExpired(plan)) {
    return { action: "held", summary: null, clearPlan: true };
  }

  const decision = resolvePendingPlanDecision(verbatimReply);

  if (decision === "reject") {
    const summary = await rejectProposedPlan(plan);
    return { action: "cancelled", summary, clearPlan: true };
  }

  if (decision === "confirm") {
    const summary = await executeProposedPlan(plan, opts);
    return { action: "executed", summary, clearPlan: true };
  }

  return { action: "held", summary: null, clearPlan: false };
}
