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

export interface HostingEventBrief {
  occasion: string | null;
  date: string | null;
  startTime: string | null;
  location: string | null;
  guestCount: string | null;
  menu: string | null;
  dietaryRequirements: string | null;
  drinks: string | null;
  setupPreferences: string | null;
  china: string | null;
  flowers: string | null;
  unresolvedRequiredFields: string[];
}

export interface HostingPlanningGateResult {
  status: "ready" | "needs_clarification";
  brief: HostingEventBrief;
  question: string | null;
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
  // Hosting events that imply guests without the word "guests". Scoped tightly
  // so ordinary meals/drinks don't trigger — "a cup of tea" / "make dinner"
  // must stay null; only named social events (afternoon tea, a dinner party,
  // a luncheon, hosting, having people over) count.
  /\b(afternoon|high|morning)\s+tea\b/i,
  /\b(tea|dinner|lunch|cocktail|garden|birthday|holiday|christmas|dinner)\s+part(?:y|ies)\b/i,
  /\bluncheon\b/i,
  /\bhosting\b/i,
  /\bhaving\s+(?:people|friends|family|company|guests?|everyone)\s+(?:over|round|around)\b/i,
  // A meal hosted "at home" is an entertaining event ("dinner at home tomorrow"),
  // distinct from a plain cook task ("make dinner" / "cook dinner"), which must
  // stay null.
  /\b(?:dinner|lunch|brunch|breakfast|tea|drinks|cocktails)\s+at\s+home\b/i,
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

/**
 * Guardrail for the direct-delegation path: returns true when a delegation must
 * be diverted to the deterministic guest planner rather than executed directly.
 *
 * A guest/hosting event must NEVER be fanned out into per-person direct
 * delegations (the live failure where the agent itself decomposed "afternoon
 * tea" into Grace/Ghulam/Bahan sends). Whenever the current user context is a
 * detected guest/hosting event, the direct path must hand off to the planner —
 * regardless of whether the user granted operating authority. Ordinary
 * single-person commands ("Tell Christopher to make dinner") are not detected as
 * outcomes and pass straight through.
 */
export function mustRouteGuestEventToPlanner(latestUserMessage: string | null | undefined): boolean {
  return detectHouseholdOutcome((latestUserMessage ?? "").trim()) !== null;
}

export type GuestOutcomeAction = "execute" | "propose" | "none";

/**
 * Decides how a guest/hosting/operations utterance should be handled when it
 * reaches tool routing:
 *
 * - "execute": the user granted OPERATING AUTHORITY ("handle what you can",
 *   "make sure everything is ready", "take care of it", etc.). Carson must run
 *   the deterministic plan immediately and report only tool-confirmed results —
 *   NOT stop at a proposal. This is the fix for the regression where operating
 *   authority was treated as planning instead of execution.
 * - "propose": a detected guest/hosting event WITHOUT operating authority —
 *   confirm-before-send (build the plan, ask "Should I send it?").
 * - "none": not an operations event — leave to normal handling so ordinary
 *   single-person commands still go through direct delegation unchanged.
 *
 * Approval-required sensitive actions (money, bookings, medical, legal,
 * destructive, unclear recipient/cadence) are gated at the prompt/tool layer,
 * not here.
 */
export function resolveGuestOutcomeAction(text: string | null | undefined): GuestOutcomeAction {
  const t = (text ?? "").trim();
  if (!t) return "none";
  if (hasOperatingAuthority(t)) return "execute";
  if (detectHouseholdOutcome(t) !== null) return "propose";
  return "none";
}

// ── Hosting planning gate ─────────────────────────────────────────────────────

const TIME_RE =
  /\b(?:at|by|from|around|about)\s+((?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm|a\.m\.|p\.m\.)?|(?:[01]?\d|2[0-3]):[0-5]\d)\b/i;
const GUEST_COUNT_RE =
  /\b(?:for\s+)?(?:(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)?(?:guests?|people|visitors?|friends|family|company)\b/i;
const HOME_LOCATION_RE = /\b(?:at\s+home|in\s+the\s+(garden|dining\s+room|salon|majlis|kitchen|terrace|patio)|outside|inside|outdoors?|indoors?)\b/i;
const SPECIFIC_LOCATION_RE = /\b(?:in|on|at)\s+(?:the\s+)?(garden|dining\s+room|salon|majlis|terrace|patio|pool\s+area|living\s+room|kitchen)\b/i;
const MENU_RE = /\b(?:serve|serving|with|menu|food|prepare)\s+([^.!?;]+)/i;
const MENU_ITEM_RE =
  /\b(?:sandwiches?|cakes?|scones?|tea|coffee|canap[eé]s?|pastries|biscuits?|cookies?|fruit|juice|water|drinks?|snacks?|desserts?|salad|soup|dinner|lunch|breakfast|brunch)\b/i;
const MENU_ITEM_TOKEN_RE =
  /\b(?:sandwiches?|cakes?|scones?|tea|coffee|canap[eé]s?|pastries|biscuits?|cookies?|fruit|juice|water|drinks?|snacks?|desserts?|salad|soup|dinner|lunch|breakfast|brunch)\b/ig;
const PERMISSION_TO_SUGGEST_MENU_RE =
  /\b(?:you choose|choose (?:the )?menu|suggest (?:a )?menu|carson chooses?|whatever you think|up to you|decide (?:the )?menu)\b/i;
const DIETARY_RE =
  /\b(?:no dietary restrictions|no allergies|dietary restrictions?[:\s]+[^.!?;]+|allerg(?:y|ies)[:\s]+[^.!?;]+|vegetarian|vegan|gluten[-\s]?free|dairy[-\s]?free|nut[-\s]?free|halal)\b/i;
const DRINKS_RE = /\b(?:tea|coffee|water|juice|cold drinks?|mocktails?|cocktails?)\b/ig;
const CHINA_RE = /\b(?:(?:the|selected|blue|white|floral|formal|best|special)\s+)?(?:china|tea set|cups?|plates?|silver|serving pieces?)\b/i;

function cleanMatchedText(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim().replace(/[,.]$/, "");
  return cleaned || null;
}

function inferOccasion(text: string): string | null {
  if (/\bafternoon\s+tea\b/i.test(text)) return "afternoon tea";
  if (/\bhigh\s+tea\b/i.test(text)) return "high tea";
  if (/\bdinner\s+part(?:y|ies)\b/i.test(text)) return "dinner party";
  if (/\blunch(?:eon)?\b/i.test(text)) return /\bluncheon\b/i.test(text) ? "luncheon" : "lunch";
  if (/\bbrunch\b/i.test(text)) return "brunch";
  if (/\bbreakfast\b/i.test(text)) return "breakfast";
  if (/\btea\b/i.test(text)) return "tea";
  if (/\bdinner\b/i.test(text)) return "dinner";
  if (/\bguests?\b/i.test(text)) return "guest hosting";
  return null;
}

function inferDate(text: string): string | null {
  if (/\btoday\b/i.test(text)) return "today";
  if (/\btomorrow\b/i.test(text)) return "tomorrow";
  if (/\btonight\b/i.test(text)) return "tonight";
  if (/\bthis\s+(?:evening|afternoon|morning|weekend)\b/i.test(text)) {
    return cleanMatchedText(text.match(/\bthis\s+(?:evening|afternoon|morning|weekend)\b/i)?.[0]);
  }
  const weekday = text.match(/\b(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0];
  return cleanMatchedText(weekday);
}

function inferLocation(text: string): string | null {
  const specific = text.match(SPECIFIC_LOCATION_RE)?.[1];
  if (specific) return `the ${specific.toLowerCase()}`;
  const home = text.match(HOME_LOCATION_RE);
  if (!home) return null;
  if (home[1]) return `the ${home[1].toLowerCase()}`;
  if (/outside|outdoors?/i.test(home[0])) return "outside";
  if (/inside|indoors?/i.test(home[0])) return "inside";
  return "home";
}

function inferGuestCount(text: string): string | null {
  const match = text.match(GUEST_COUNT_RE);
  if (!match) return null;
  const count = match[1];
  if (count) return `${count.toLowerCase()} ${/people/i.test(match[0]) ? "people" : "guests"}`;
  return null;
}

function inferMenu(text: string): string | null {
  if (PERMISSION_TO_SUGGEST_MENU_RE.test(text)) return "Carson may suggest or choose the menu";
  const menu = text.match(MENU_RE)?.[1];
  if (menu) {
    const cleaned = cleanMatchedText(menu.replace(/\b(?:by|at|in|on)\s+\d.*$/i, ""));
    if (cleaned && cleaned.length >= 4) return cleaned;
  }

  const fallbackText = text.includes("Clarification details:")
    ? text.slice(text.lastIndexOf("Clarification details:") + "Clarification details:".length)
    : text;
  const sentences = fallbackText
    .split(/[.!?;]+/)
    .map((sentence) => cleanMatchedText(sentence))
    .filter((sentence): sentence is string => Boolean(sentence));
  const menuSentence = sentences.find((sentence) => {
    if (!MENU_ITEM_RE.test(sentence)) return false;
    const menuItemCount = Array.from(sentence.matchAll(MENU_ITEM_TOKEN_RE)).length;
    MENU_ITEM_TOKEN_RE.lastIndex = 0;
    if (menuItemCount < 2 && !sentence.includes(",")) return false;
    if (/\b(?:afternoon|high|morning)\s+tea\b/i.test(sentence)) return false;
    if (/^(?:at|by|in|on|use|no dietary|dietary|allerg|with no dietary)\b/i.test(sentence)) return false;
    if (CHINA_RE.test(sentence) && !MENU_ITEM_RE.test(sentence.replace(CHINA_RE, ""))) return false;
    return true;
  });
  const cleaned = cleanMatchedText(menuSentence);
  if (!cleaned || cleaned.length < 4) return null;
  return cleaned;
}

function inferDrinks(text: string): string | null {
  const matches = Array.from(text.matchAll(DRINKS_RE)).map((match) => match[0].toLowerCase());
  const unique = [...new Set(matches)];
  return unique.length > 0 ? unique.join(", ") : null;
}

function inferFlowers(text: string): string | null {
  const explicitFlowers = text.match(/\b(?:(?:simple|white|fresh|seasonal|small|large)\s+)*flowers?\b/i)?.[0];
  if (explicitFlowers) return cleanMatchedText(explicitFlowers);
  const arrangement = text.match(/\b(?:(?:simple|white|fresh|seasonal|small|large)\s+)*arrangement\b/i)?.[0];
  if (arrangement) return cleanMatchedText(arrangement);
  if (/\bfloral\b(?!\s+china\b)/i.test(text)) return "floral";
  return null;
}

export function buildHostingEventBrief(text: string): HostingEventBrief {
  const source = text.trim();
  const startTime = cleanMatchedText(source.match(TIME_RE)?.[1]);
  const menu = inferMenu(source);
  const location = inferLocation(source);
  const occasion = inferOccasion(source);
  const brief: HostingEventBrief = {
    occasion,
    date: inferDate(source),
    startTime,
    location,
    guestCount: inferGuestCount(source),
    menu,
    dietaryRequirements: cleanMatchedText(source.match(DIETARY_RE)?.[0]),
    drinks: inferDrinks(source),
    setupPreferences: /\b(?:formal|casual|simple|elegant|garden|inside|outside|buffet|seated)\b/i.test(source)
      ? cleanMatchedText(source.match(/\b(?:formal|casual|simple|elegant|garden|inside|outside|buffet|seated)\b/i)?.[0])
      : null,
    china: cleanMatchedText(source.match(CHINA_RE)?.[0]),
    flowers: inferFlowers(source),
    unresolvedRequiredFields: [],
  };

  const missing: string[] = [];
  if (!brief.startTime) missing.push("start_time");
  if (!brief.menu) missing.push("menu");
  if (/\b(?:tea|dinner|lunch|brunch|breakfast|hosting|guests?)\b/i.test(source) && (!brief.location || brief.location === "home")) {
    missing.push("location");
  }
  brief.unresolvedRequiredFields = missing;
  return brief;
}

export function evaluateHostingPlanningGate(text: string): HostingPlanningGateResult {
  const brief = buildHostingEventBrief(text);
  if (brief.unresolvedRequiredFields.length === 0) {
    return { status: "ready", brief, question: null };
  }

  const asks: string[] = [];
  if (brief.unresolvedRequiredFields.includes("start_time")) asks.push("what time it should begin");
  if (brief.unresolvedRequiredFields.includes("location")) asks.push("where at home we should host it");
  if (brief.unresolvedRequiredFields.includes("menu")) asks.push("what you would like served");

  const question =
    `For ${brief.occasion ?? "this"}, ${asks.join(", and ")}? ` +
    "I can suggest a menu if you prefer. Are there any dietary restrictions, and do you want particular china or flowers used?";

  return { status: "needs_clarification", brief, question };
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

/**
 * Load the latest non-expired pending guest_arrival plan for the user.
 *
 * Scoped to type "guest_arrival" (Carson Weekly Planning V1 reuses this same
 * table with type "weekly_plan" for a different pending-operation shape) —
 * without this filter, a pending weekly plan could be loaded here and
 * mis-parsed as a ProposedPlan.
 */
export async function loadLatestPendingPlan(): Promise<ProposedPlan | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("carson_pending_operations")
    .select("*")
    .eq("user_id", user.id)
    .eq("type", "guest_arrival")
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

const DINNER_ROLE_RE = /\b(cook|chef|kitchen)\b/i;
const DINNER_TOPIC_RE = /\b(dinner|menu|meal|food|cook|kitchen|tea)\b/i;
const HOSPITALITY_ROLE_RE = /\b(housekeeper|house\s*keeper|maid|cleaner|hospitality|host|decor|flower)\b/i;
const HOSPITALITY_TOPIC_RE = /\b(flowers?|hospitality|guest\s*room|setup|table|decor|welcome|hosting)\b/i;
const TRANSPORT_ROLE_RE = /\b(driver|chauffeur)\b/i;

// Coordination owner is chosen by explicit role priority: a dedicated
// Coordinator first, then a house/estate manager, then an assistant. If none
// of those exist, fall back to a person named Grace. This is a household rule,
// not a scoring heuristic — first match in this order wins.
const COORDINATION_ROLE_PRIORITY: RegExp[] = [
  /\b(coordinator|coordination)\b/i,
  /\b(house\s*manager|household\s*manager|estate\s*manager|manager)\b/i,
  /\b(assistant|\bpa\b|\bea\b)\b/i,
];
const COORDINATION_GRACE_FALLBACK_RE = /^grace$/i;

// Transport standby is NEVER auto-included. It is added only when the request
// names a REAL transport ACTION (a pickup, dropoff, airport/station run, a ride).
// Deliberately does NOT match the bare word "transport", a role ("driver"), or a
// name ("Ghulam") — the ElevenLabs agent injects boilerplate like "Ghulam should
// be on standby for transport", which must NOT pull a driver into a quiet home
// event (e.g. afternoon tea). Only a concrete action counts as "explicitly named".
const TRANSPORT_TRIGGER_RE =
  /\b(pick(?:ing|ed)?\s*up|pickup|drop(?:ping|ped)?\s*(?:off|them|everyone)|dropoff|airport|train\s*station|collect(?:ing|ed)?\s+(?:them|everyone|the guests)|drive(?:s|n|\s+them|\s+everyone|\s+the guests)|give(?:s)?\s+(?:them|everyone|the guests)\s+a\s+(?:ride|lift)|needs?\s+a\s+(?:ride|lift|car)|from\s+the\s+(?:airport|station))\b/i;

// Carson (the assistant) must never be a household recipient. Filter by name so
// a stray "Carson"/"assistant" contact — or one that happens to hold a matching
// role — can never be selected for any domain.
const ASSISTANT_RECIPIENT_RE = /^\s*(?:carson|the assistant|assistant)\s*$/i;

export function isAssistantRecipientName(name: string | null | undefined): boolean {
  return ASSISTANT_RECIPIENT_RE.test((name ?? "").trim());
}

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

/** Score-based selection for the domains that map to a skill (dinner, hospitality, transport). */
function findScoredOwner(
  people: Person[],
  domain: "dinner" | "hospitality" | "transport",
  excluded: Set<string>,
): Person | null {
  const ranked = people
    .filter((person) => !excluded.has(person.id))
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
      } else {
        if (TRANSPORT_ROLE_RE.test(person.role)) score += 6;
      }

      return { person, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.person ?? null;
}

/** Coordination owner by explicit role priority, with a Grace fallback. */
function findCoordinationOwner(people: Person[], excluded: Set<string>): Person | null {
  const candidates = people.filter((person) => !excluded.has(person.id));
  for (const roleRe of COORDINATION_ROLE_PRIORITY) {
    const match = candidates.find((person) => roleRe.test(person.role));
    if (match) return match;
  }
  return candidates.find((person) => COORDINATION_GRACE_FALLBACK_RE.test(person.name.trim())) ?? null;
}

export function buildDeterministicGuestPreparationTasks(
  people: Person[],
  sourceText = "",
): ProposedTask[] {
  const brief = buildHostingEventBrief(sourceText);
  // Carson can never be a recipient — filter before any selection.
  const usable = people.filter((person) => !isAssistantRecipientName(person.name));
  const used = new Set<string>();
  const owners: GuestPrepOwner[] = [];

  const dinner = findScoredOwner(usable, "dinner", used);
  if (dinner) {
    owners.push({ domain: "dinner", person: dinner });
    used.add(dinner.id);
  }

  const hospitality = findScoredOwner(usable, "hospitality", used);
  if (hospitality) {
    owners.push({ domain: "hospitality", person: hospitality });
    used.add(hospitality.id);
  }

  const coordination = findCoordinationOwner(usable, used);
  if (coordination) {
    owners.push({ domain: "coordination", person: coordination });
    used.add(coordination.id);
  }

  // Transport standby only when the request explicitly calls for it.
  if (TRANSPORT_TRIGGER_RE.test(sourceText)) {
    const transport = findScoredOwner(usable, "transport", used);
    if (transport) {
      owners.push({ domain: "transport", person: transport });
      used.add(transport.id);
    }
  }

  // Never let one person carry the whole plan — require at least two distinct owners.
  if (new Set(owners.map((owner) => owner.person.id)).size < 2) return [];

  const dinnerName = dinner?.name ?? "the food owner";
  const hospitalityName = hospitality?.name ?? "the hospitality owner";

  return owners.map(({ domain, person }) => {
    if (domain === "dinner") {
      return {
        personId: person.id,
        personName: person.name,
        message: buildHostingWorkerMessage("dinner", brief, dinnerName, hospitalityName),
      };
    }

    if (domain === "hospitality") {
      return {
        personId: person.id,
        personName: person.name,
        message: buildHostingWorkerMessage("hospitality", brief, dinnerName, hospitalityName),
      };
    }

    if (domain === "transport") {
      return {
        personId: person.id,
        personName: person.name,
        message: buildHostingWorkerMessage("transport", brief, dinnerName, hospitalityName),
      };
    }

    return {
      personId: person.id,
      personName: person.name,
      message: buildHostingWorkerMessage("coordination", brief, dinnerName, hospitalityName),
    };
  });
}

function briefContextSentence(brief: HostingEventBrief): string {
  const occasion = brief.occasion ?? "a household event";
  const guestPart = brief.guestCount ? ` for ${brief.guestCount}` : "";
  const datePart = brief.date ? ` ${brief.date}` : "";
  const timePart = brief.startTime ? ` at ${brief.startTime}` : "";
  const locationPart = brief.location ? ` in ${brief.location}` : "";
  return `Sana is hosting ${occasion}${guestPart}${datePart}${timePart}${locationPart}.`;
}

function readyDeadline(brief: HostingEventBrief, domain: GuestPrepDomain): string {
  if (!brief.startTime) return "before guests arrive";
  if (domain === "hospitality" || domain === "coordination") return `30 minutes before ${brief.startTime}`;
  if (domain === "transport") return `before ${brief.startTime}`;
  return `15 minutes before ${brief.startTime}`;
}

function buildHostingWorkerMessage(
  domain: GuestPrepDomain,
  brief: HostingEventBrief,
  dinnerName: string,
  hospitalityName: string,
): string {
  const context = briefContextSentence(brief);
  const date = brief.date ?? "the event date";
  const time = brief.startTime ?? "the event time";
  const location = brief.location ?? "the event location";
  const menu = brief.menu ?? "the agreed menu";
  const dietary = brief.dietaryRequirements ?? "any dietary restrictions Sana confirms";
  const china = brief.china ?? "appropriate china, cups, plates, napkins, and serving pieces";
  const flowers = brief.flowers ?? "simple flowers if available";
  const deadline = readyDeadline(brief, domain);

  if (domain === "dinner") {
    return [
      context,
      `Please prepare the food and drinks for ${brief.occasion ?? "the event"} on ${date} at ${time} in ${location}.`,
      `Menu/service: ${menu}. Drinks: ${brief.drinks ?? "tea, coffee, water, and suitable cold drinks"}. Dietary requirements: ${dietary}.`,
      `Required result: everything is ready for service by ${deadline}. Tell Carson immediately if an ingredient or service item is unavailable.`,
    ].join(" ");
  }

  if (domain === "hospitality") {
    return [
      context,
      `Please prepare the setup for ${brief.occasion ?? "the event"} on ${date} at ${time} in ${location}.`,
      `Use ${china}, clean linens, seating, water glasses, serving pieces, and ${flowers}.`,
      `Required result: the full table and guest area are ready by ${deadline}. Tell Carson immediately if anything is missing.`,
    ].join(" ");
  }

  if (domain === "transport") {
    return [
      context,
      `Please handle the transport support connected to this event on ${date} at ${time} in ${location}.`,
      `Required result: the car and timing are ready by ${deadline}. Tell Carson immediately if there is any delay or blocker.`,
    ].join(" ");
  }

  return [
    context,
    `Please coordinate ${brief.occasion ?? "the event"} on ${date} at ${time} in ${location}.`,
    `Checkpoints: confirm with ${dinnerName} on menu, drinks, and service timing; confirm with ${hospitalityName} on table setup, china, linens, flowers, seating, and readiness.`,
    `Required result: all checkpoints are verified by ${deadline}. Report any missing item, delay, or blocker to Carson immediately.`,
  ].join(" ");
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
    const person = people.find(
      (p) => p.name.trim().toLowerCase() === t.person_name.trim().toLowerCase(),
    );
    if (!person || !t.message?.trim()) continue;
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

// Idempotency registry — a given plan executes at most once per session.
// ElevenLabs can double-fire the confirmation tool call, and a plan can be
// re-loaded from the DB after a reconnect; without this a single approval could
// send the same WhatsApps twice. The key is claimed synchronously (before any
// await) so a concurrent second call is rejected immediately, and it persists
// even on send failure — we never auto-retry.
const executedPlanKeys = new Set<string>();

function planIdempotencyKey(plan: ProposedPlan): string {
  if (plan.dbId) return `db:${plan.dbId}`;
  const taskSignature = plan.tasks.map((t) => `${t.personId}:${t.message}`).join("|");
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

  // Idempotency — claim the plan synchronously before any await.
  const idempotencyKey = planIdempotencyKey(plan);
  if (executedPlanKeys.has(idempotencyKey)) {
    return "I already sent that plan. I won't send it again.";
  }
  executedPlanKeys.add(idempotencyKey);

  // Carson can never be a recipient at execution time either.
  const deliverableTasks = plan.tasks.filter((task) => !isAssistantRecipientName(task.personName));
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

// ── Confirm-before-send resolution ───────────────────────────────────────────

export type PendingPlanDecision = "confirm" | "reject" | "hold";

/**
 * Decides how a pending plan should be treated, from the user's reply.
 *
 * Accepts multiple candidate strings (e.g. the verbatim transcript AND the
 * ElevenLabs instruction param) because EL routes a bare "Yes" inconsistently —
 * sometimes only the transcript carries it, sometimes only the tool arg. A
 * decision is reached if ANY source strictly reads as confirmation/rejection.
 * Rejection wins over confirmation. Empty/noisy input holds the plan (never
 * sends, never clears).
 */
export function resolvePendingPlanDecision(...replies: Array<string | null | undefined>): PendingPlanDecision {
  const texts = replies.map((r) => (r ?? "").trim()).filter(Boolean);
  if (texts.length === 0) return "hold";
  if (texts.some((t) => isRejection(t))) return "reject";
  if (texts.some((t) => isConfirmation(t))) return "confirm";
  return "hold";
}

export interface PendingPlanTurnResult {
  action: "executed" | "cancelled" | "held";
  summary: string | null;
  clearPlan: boolean;
}

/**
 * End-to-end handler for a turn taken while a plan awaits approval.
 * - Expired plan → held, caller clears its cache.
 * - Rejection → cancel, clear.
 * - Confirmation → execute the EXACT stored plan (idempotent), clear.
 * - Anything else → held, plan preserved.
 */
export async function handlePendingPlanTurn(
  replies: Array<string | null | undefined>,
  plan: ProposedPlan,
  opts: ExecutePlanOptions,
): Promise<PendingPlanTurnResult> {
  if (isPlanExpired(plan)) {
    return { action: "held", summary: null, clearPlan: true };
  }

  const decision = resolvePendingPlanDecision(...replies);

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
