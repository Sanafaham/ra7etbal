/**
 * EVIDENCE ONLY — the V2 deterministic boundary. Not wired into Production.
 *
 * Turns one model proposal into a dry-run plan. It never reinterprets the
 * owner's language: it validates shape, resolves the recipient, applies the
 * C-02 combination rule to the model's per-item accountability answers,
 * holds on unsupported Carson work, composes the recipient message ONLY from
 * recipient_items, fills {owner} from the authoritative display name, and
 * checks closed-vocabulary anchors. It has no channel input.
 */
import { extractConstraints, mentionsPerson, type Person } from "./anchors";
import {
  CARSON_DUTY_TYPES,
  CLARIFICATION_REASONS,
  type CarsonDuty,
  type CarsonDutyType,
  type RecipientItem,
  type V2Proposal,
} from "./skill";

/** Ra7etBal's capability registry for Carson duties in this action (existing lifecycle only). */
export const SUPPORTED_CARSON_DUTIES: ReadonlySet<CarsonDutyType> = new Set(["track_until_confirmed", "report_outcome_to_owner"]);
/** Supported duties that establish Carson custody after delivery. */
export const CUSTODY_DUTIES: ReadonlySet<CarsonDutyType> = new Set(["track_until_confirmed", "report_outcome_to_owner"]);

export const EVIDENCE_CANDIDATE_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"] as const;

export type Route = "tracked" | "direct";
export type PlanOutcome = "SEND_TRACKED" | "SEND_DIRECT" | "HOLD_UNSUPPORTED" | "CLARIFY" | "NO_SEND_GUARD" | "MALFORMED";

export type ComposedMessage =
  | { route: "tracked"; taskText: string; note: string | null }
  | { route: "direct"; messageText: string };

export interface Plan {
  outcome: PlanOutcome;
  route: Route | null;
  recipient: string | null;
  message: ComposedMessage | null;
  carsonDuties: CarsonDuty[];
  failures: string[];
}

export interface PlanInput {
  proposal: unknown;
  utterance: string;
  ownerName: string;
  people: Person[];
  otherOwnerPeople?: Person[];
  requestedModel: string;
  producingModel: string | undefined;
}

// ── 1. Strict shape: unknown fields (a route, a channel, a message) are malformed ──
const TOP_KEYS = ["outcome", "recipient", "recipient_items", "carson_duties", "clarification"];
const ITEM_KEYS = ["text", "carson_follows_through", "basis"];
const DUTY_KEYS = ["type", "detail"];

function exactKeys(obj: unknown, keys: string[]): obj is Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

export function validateShape(raw: unknown): { proposal: V2Proposal | null; errors: string[] } {
  const errors: string[] = [];
  if (!exactKeys(raw, TOP_KEYS)) return { proposal: null, errors: ["shape:top_level_keys"] };
  const p = raw as Record<string, unknown>;
  if (p.outcome !== "act" && p.outcome !== "clarify") errors.push("shape:outcome");
  if (p.recipient !== null && typeof p.recipient !== "string") errors.push("shape:recipient");
  if (!Array.isArray(p.recipient_items)) errors.push("shape:recipient_items");
  else
    for (const item of p.recipient_items)
      if (!exactKeys(item, ITEM_KEYS) || typeof item.text !== "string" || typeof item.carson_follows_through !== "boolean" || typeof item.basis !== "string")
        errors.push("shape:recipient_item");
  if (!Array.isArray(p.carson_duties)) errors.push("shape:carson_duties");
  else
    for (const d of p.carson_duties)
      if (!exactKeys(d, DUTY_KEYS) || !(CARSON_DUTY_TYPES as readonly unknown[]).includes(d.type) || typeof d.detail !== "string")
        errors.push("shape:carson_duty");
  if (p.clarification !== null) {
    const c = p.clarification as Record<string, unknown>;
    if (!exactKeys(c, ["reason", "question"]) || !(CLARIFICATION_REASONS as readonly unknown[]).includes(c.reason) || typeof c.question !== "string")
      errors.push("shape:clarification");
  }
  return errors.length ? { proposal: null, errors } : { proposal: raw as unknown as V2Proposal, errors: [] };
}

// ── 2. C-02 combination rule (no language is read here) ──────────────────
export function deriveRoute(items: ReadonlyArray<Pick<RecipientItem, "carson_follows_through">>, duties: ReadonlyArray<Pick<CarsonDuty, "type"> & Partial<CarsonDuty>>): Route {
  const itemCustody = items.some((i) => i.carson_follows_through === true);
  const explicitCustody = duties.some((d) => CUSTODY_DUTIES.has(d.type));
  return itemCustody || explicitCustody ? "tracked" : "direct";
}

// ── 3. Owner placeholder ──────────────────────────────────────────────────
const OWNER_PLACEHOLDER = /\{\s*owner\s*\}/gi;
export function fillOwner(text: string, ownerName: string): string {
  return text.replace(OWNER_PLACEHOLDER, ownerName);
}
/** Any brace token left after filling means the model invented a placeholder. */
export function hasUnknownPlaceholder(text: string): boolean {
  return /\{[^}]*\}/.test(text);
}

// ── 4. Message composition from recipient_items ONLY ─────────────────────
function sentence(text: string): string {
  const t = text.trim().replace(/[.。!؟?]+$/u, "");
  if (!t) return "";
  const first = t.charAt(0);
  return `${first.toLocaleUpperCase()}${t.slice(1)}.`;
}
function joinSentences(items: RecipientItem[], ownerName: string): string {
  return items.map((i) => sentence(fillOwner(i.text, ownerName))).filter(Boolean).join(" ");
}

export function composeMessage(route: Route, items: RecipientItem[], ownerName: string): ComposedMessage {
  if (route === "direct") return { route, messageText: joinSentences(items, ownerName) };
  const custody = items.filter((i) => i.carson_follows_through);
  // Tracked only through an explicit Carson custody duty: every item is the task.
  const taskItems = custody.length ? custody : items;
  const noteItems = custody.length ? items.filter((i) => !i.carson_follows_through) : [];
  const note = joinSentences(noteItems, ownerName);
  return { route, taskText: joinSentences(taskItems, ownerName), note: note || null };
}

export function messageText(m: ComposedMessage): string {
  return m.route === "direct" ? m.messageText : [m.taskText, m.note].filter(Boolean).join(" ");
}

// ── 5. Full dry-run plan ─────────────────────────────────────────────────
function resolve(ref: string, people: Person[]): Person[] {
  const n = ref.trim().toLowerCase();
  return people.filter((p) => p.name.toLowerCase() === n || p.aliases.some((a) => a.toLowerCase() === n));
}

export function planFromProposal(input: PlanInput): Plan {
  const empty = (outcome: PlanOutcome, failures: string[]): Plan => ({ outcome, route: null, recipient: null, message: null, carsonDuties: [], failures });

  // Model authorization: only an evidence candidate, and exactly the model requested (no fallback).
  const auth: string[] = [];
  if (!(EVIDENCE_CANDIDATE_MODELS as readonly string[]).includes(input.requestedModel)) auth.push("auth:model_not_candidate");
  if (!input.producingModel || !input.producingModel.startsWith(input.requestedModel)) auth.push("auth:producing_model_mismatch");
  if (auth.length) return empty("NO_SEND_GUARD", auth);

  const { proposal, errors } = validateShape(input.proposal);
  if (!proposal) return empty("MALFORMED", errors);

  if (proposal.outcome === "clarify") {
    return proposal.clarification && proposal.clarification.question.trim()
      ? { ...empty("CLARIFY", []), carsonDuties: proposal.carson_duties }
      : empty("MALFORMED", ["shape:clarify_without_question"]);
  }

  const failures: string[] = [];
  if (proposal.clarification !== null) failures.push("shape:act_with_clarification");
  if (!proposal.recipient_items.length) failures.push("guard:no_recipient_items");
  for (const i of proposal.recipient_items) if (!i.text.trim()) failures.push("guard:empty_item");

  // Exactly one of THIS owner's people, named by the owner.
  let recipient: Person | null = null;
  const matches = proposal.recipient ? resolve(proposal.recipient, input.people) : [];
  if (matches.length !== 1) failures.push("guard:recipient_not_exactly_one_owner_person");
  else {
    recipient = matches[0];
    if (!mentionsPerson(input.utterance, recipient)) failures.push("guard:recipient_not_named_by_owner");
  }

  const route = deriveRoute(proposal.recipient_items, proposal.carson_duties);
  const message = composeMessage(route, proposal.recipient_items, input.ownerName);
  const text = messageText(message);
  const dutyText = proposal.carson_duties.map((d) => d.detail).join(" ");
  if (proposal.recipient_items.some((i) => hasUnknownPlaceholder(fillOwner(i.text, input.ownerName)))) failures.push("guard:unknown_placeholder");

  // Closed-vocabulary anchors: named people and numbers/times/days not lost or invented.
  for (const person of [...input.people, ...(input.otherOwnerPeople ?? [])]) {
    if (recipient && person.name === recipient.name) continue;
    const inOwner = mentionsPerson(input.utterance, person);
    if (mentionsPerson(text, person) && !inOwner) failures.push(`anchor:invented_person:${person.name}`);
    if (inOwner && !mentionsPerson(text, person) && !mentionsPerson(dutyText, person)) failures.push(`anchor:lost_person:${person.name}`);
  }
  const owner = extractConstraints(input.utterance);
  const carried = new Set([...extractConstraints(text), ...extractConstraints(dutyText)]);
  for (const c of owner) if (!carried.has(c)) failures.push(`anchor:lost:${c}`);
  for (const c of extractConstraints(text)) if (!owner.has(c)) failures.push(`anchor:invented:${c}`);

  const base = { route, recipient: recipient?.name ?? null, message, carsonDuties: proposal.carson_duties };
  if (failures.length) return { outcome: "NO_SEND_GUARD", ...base, failures };

  // Materially connected unsupported Carson work holds the WHOLE action.
  const unsupported = proposal.carson_duties.filter((d) => !SUPPORTED_CARSON_DUTIES.has(d.type));
  if (unsupported.length) return { outcome: "HOLD_UNSUPPORTED", ...base, failures: unsupported.map((d) => `hold:${d.type}`) };

  return { outcome: route === "tracked" ? "SEND_TRACKED" : "SEND_DIRECT", ...base, failures: [] };
}
