/**
 * EVIDENCE ONLY — the V3 deterministic boundary. Not wired into Production.
 *
 * extraction → strict shape → recipient resolution (exactly one of this
 * owner's people, named by the owner) → C-02 policy (policy.ts) → message
 * built ONLY from responsibilities, in the owner's order → {owner} filled from
 * the authoritative profile → closed-vocabulary anchors → hold on unsupported
 * Carson instructions. No channel input. No language is reinterpreted here.
 */
import { extractConstraints, mentionsPerson, type Person } from "./anchors";
import { decideCustody, type Route } from "./policy";
import { CLARIFICATION_REASONS, INSTRUCTION_TYPES, NATURES, type CarsonInstruction, type Responsibility, type V3Extraction } from "./skill";

export type PlanOutcome = "SEND_TRACKED" | "SEND_DIRECT" | "HOLD_UNSUPPORTED" | "CLARIFY" | "CLARIFY_RECIPIENT" | "NO_SEND_GUARD" | "MALFORMED";

export type ComposedMessage = { route: "tracked"; taskText: string; note: null } | { route: "direct"; messageText: string };

export interface Plan {
  outcome: PlanOutcome;
  route: Route | null;
  recipient: string | null;
  message: ComposedMessage | null;
  carsonInstructions: CarsonInstruction[];
  question: string | null;
  failures: string[];
}

export interface PlanInput {
  extraction: unknown;
  utterance: string;
  ownerName: string;
  people: Person[];
  otherOwnerPeople?: Person[];
  /** Model the runner asked for, and the model the provider says answered. */
  requestedModel: string;
  producingModel: string | undefined;
  /** Models the gate has been told to evaluate. Provider/model choice is a separate owner decision. */
  candidateModels: readonly string[];
}

export const RECIPIENT_QUESTION = "Who should I send this to?";

// ── Strict shape ─────────────────────────────────────────────────────────
const TOP = ["outcome", "recipient", "responsibilities", "carson_instructions", "clarification"];
const RESP = ["text", "nature", "source"];
const INSTR = ["type", "owner_words"];
function exactKeys(o: unknown, keys: string[]): o is Record<string, unknown> {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

export function validateShape(raw: unknown): { extraction: V3Extraction | null; errors: string[] } {
  if (!exactKeys(raw, TOP)) return { extraction: null, errors: ["shape:top_level_keys"] };
  const errors: string[] = [];
  if (raw.outcome !== "act" && raw.outcome !== "clarify") errors.push("shape:outcome");
  if (raw.recipient !== null && typeof raw.recipient !== "string") errors.push("shape:recipient");
  if (!Array.isArray(raw.responsibilities)) errors.push("shape:responsibilities");
  else
    for (const r of raw.responsibilities)
      if (!exactKeys(r, RESP) || typeof r.text !== "string" || !(NATURES as readonly unknown[]).includes(r.nature) || typeof r.source !== "string")
        errors.push("shape:responsibility");
  if (!Array.isArray(raw.carson_instructions)) errors.push("shape:carson_instructions");
  else
    for (const i of raw.carson_instructions)
      if (!exactKeys(i, INSTR) || !(INSTRUCTION_TYPES as readonly unknown[]).includes(i.type) || typeof i.owner_words !== "string")
        errors.push("shape:carson_instruction");
  if (raw.clarification !== null) {
    const c = raw.clarification;
    if (!exactKeys(c, ["reason", "question"]) || !(CLARIFICATION_REASONS as readonly unknown[]).includes(c.reason) || typeof c.question !== "string")
      errors.push("shape:clarification");
  }
  return errors.length ? { extraction: null, errors } : { extraction: raw as unknown as V3Extraction, errors: [] };
}

// ── Owner placeholder ────────────────────────────────────────────────────
const OWNER_PLACEHOLDER = /\{\s*owner\s*\}/gi;
export function fillOwner(text: string, ownerName: string): string {
  return text.replace(OWNER_PLACEHOLDER, ownerName);
}
export function hasUnknownPlaceholder(text: string): boolean {
  return /\{[^}]*\}/.test(text);
}

// ── Message from responsibilities only, in the owner's order ─────────────
function sentence(text: string): string {
  const t = text.trim().replace(/[.。!؟?]+$/u, "");
  return t ? `${t.charAt(0).toLocaleUpperCase()}${t.slice(1)}.` : "";
}
export function composeMessage(route: Route, responsibilities: readonly Responsibility[], ownerName: string): ComposedMessage {
  const text = responsibilities.map((r) => sentence(fillOwner(r.text, ownerName))).filter(Boolean).join(" ");
  return route === "tracked" ? { route, taskText: text, note: null } : { route, messageText: text };
}
export function messageText(m: ComposedMessage): string {
  return m.route === "tracked" ? m.taskText : m.messageText;
}

function resolve(ref: string, people: Person[]): Person[] {
  const n = ref.trim().toLowerCase();
  return people.filter((p) => p.name.toLowerCase() === n || p.aliases.some((a) => a.toLowerCase() === n));
}

// ── Full dry-run plan ────────────────────────────────────────────────────
export function planFromExtraction(input: PlanInput): Plan {
  const base = { route: null, recipient: null, message: null, carsonInstructions: [] as CarsonInstruction[], question: null };
  const auth: string[] = [];
  if (!input.candidateModels.includes(input.requestedModel)) auth.push("auth:model_not_candidate");
  if (!input.producingModel || !input.producingModel.startsWith(input.requestedModel)) auth.push("auth:producing_model_mismatch");
  if (auth.length) return { outcome: "NO_SEND_GUARD", ...base, failures: auth };

  const { extraction, errors } = validateShape(input.extraction);
  if (!extraction) return { outcome: "MALFORMED", ...base, failures: errors };

  if (extraction.outcome === "clarify") {
    if (!extraction.clarification || !extraction.clarification.question.trim()) return { outcome: "MALFORMED", ...base, failures: ["shape:clarify_without_question"] };
    return { outcome: "CLARIFY", ...base, question: extraction.clarification.question, failures: [] };
  }
  if (extraction.clarification !== null) return { outcome: "MALFORMED", ...base, failures: ["shape:act_with_clarification"] };

  // Recipient: exactly one of THIS owner's people, named by the owner — otherwise one standard question.
  const matches = extraction.recipient ? resolve(extraction.recipient, input.people) : [];
  const recipient = matches.length === 1 && mentionsPerson(input.utterance, matches[0]) ? matches[0] : null;
  if (!recipient) return { outcome: "CLARIFY_RECIPIENT", ...base, question: RECIPIENT_QUESTION, failures: ["recipient:not_exactly_one_named_owner_person"] };

  const failures: string[] = [];
  if (!extraction.responsibilities.length) failures.push("guard:no_responsibilities");
  for (const r of extraction.responsibilities) if (!r.text.trim()) failures.push("guard:empty_responsibility");

  const decision = decideCustody(extraction.responsibilities.map((r) => r.nature), extraction.carson_instructions.map((i) => i.type));
  const message = composeMessage(decision.route, extraction.responsibilities, input.ownerName);
  const text = messageText(message);
  if (extraction.responsibilities.some((r) => hasUnknownPlaceholder(fillOwner(r.text, input.ownerName)))) failures.push("guard:unknown_placeholder");

  // Closed-vocabulary anchors (people, numbers, times, days) — never routing.
  const instructionText = extraction.carson_instructions.map((i) => i.owner_words).join(" ");
  for (const person of [...input.people, ...(input.otherOwnerPeople ?? [])]) {
    if (person.name === recipient.name) continue;
    const inOwner = mentionsPerson(input.utterance, person);
    if (mentionsPerson(text, person) && !inOwner) failures.push(`anchor:invented_person:${person.name}`);
    if (inOwner && !mentionsPerson(text, person) && !mentionsPerson(instructionText, person)) failures.push(`anchor:lost_person:${person.name}`);
  }
  const owner = extractConstraints(input.utterance);
  const carried = new Set([...extractConstraints(text), ...extractConstraints(instructionText)]);
  for (const c of owner) if (!carried.has(c)) failures.push(`anchor:lost:${c}`);
  for (const c of extractConstraints(text)) if (!owner.has(c)) failures.push(`anchor:invented:${c}`);

  const result = { route: decision.route, recipient: recipient.name, message, carsonInstructions: extraction.carson_instructions, question: null };
  if (failures.length) return { outcome: "NO_SEND_GUARD", ...result, failures };
  if (decision.hold) return { outcome: "HOLD_UNSUPPORTED", ...result, failures: decision.unsupported.map((t) => `hold:${t}`) };
  return { outcome: decision.route === "tracked" ? "SEND_TRACKED" : "SEND_DIRECT", ...result, failures: [] };
}
