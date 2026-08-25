import type { ExtractedItem } from "../types/extraction";
import type { Person } from "../types/person";

export const OWNER_AUTHORITY_VERSION = "owner-authority-v1" as const;
export const OWNER_AUTHORITY_DENIAL =
  "I can only do that when your own instruction authorizes the exact action and details. Please tell me exactly what you want me to do.";

export type MutationFamily =
  | "direct_message"
  | "followup"
  | "delegation"
  | "reminder"
  | "automation"
  | "task"
  | "todo"
  | "note_action"
  | "calendar"
  | "persistent_instruction"
  | "profile_configuration"
  | "note_persistence"
  | "compound_instruction";

export interface OwnerMutationGrant {
  readonly grantId: string;
  readonly family: MutationFamily;
  readonly operation: string;
  readonly allowedTools: readonly string[];
  readonly recipientCanonicalName?: string;
  readonly canonicalContent?: string;
  readonly resourceHint?: string;
  readonly exactProposalKey?: string;
  readonly maximumUses: number;
}

export interface PendingOwnerActionProposal {
  readonly version: typeof OWNER_AUTHORITY_VERSION;
  readonly authenticatedUserId: string;
  readonly proposalId: string;
  readonly toolName: string;
  readonly exactProposalKey: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly resourceLabel?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface OwnerAuthorizationEnvelope {
  readonly version: typeof OWNER_AUTHORITY_VERSION;
  readonly authenticatedUserId: string;
  readonly turnOperationId: string;
  readonly ownerTranscript: string;
  readonly ownerTranscriptHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly grants: readonly Readonly<OwnerMutationGrant>[];
}

export interface AuthorizationConsumptionLedger {
  readonly usesByGrantId: Map<string, number>;
}

export interface ToolAuthorizationInput {
  envelope: OwnerAuthorizationEnvelope | null;
  ledger: AuthorizationConsumptionLedger;
  authenticatedUserId: string | null | undefined;
  turnOperationId: string | null | undefined;
  toolName: string;
  params: unknown;
  now?: number;
  resourceLabel?: string | null;
  consume?: boolean;
}

export type ToolAuthorizationDecision =
  | { allowed: true; grantId?: string; family?: MutationFamily }
  | {
      allowed: false;
      reason:
        | "no_envelope"
        | "wrong_user"
        | "wrong_turn"
        | "expired"
        | "no_matching_grant"
        | "parameter_mismatch"
        | "grant_consumed";
    };

const READ_ONLY_TOOLS = new Set([
  "get_calendar_events",
  "search_calendar_history",
  "get_task_delivery_status",
  "get_operations_summary",
  "get_items_needing_attention",
  "get_commitment_history",
  "get_person_history",
  "get_communication_history",
]);

const TOOL_FAMILY: Record<string, MutationFamily> = {
  send_direct_whatsapp_message: "direct_message",
  send_followup: "followup",
  send_delegation: "delegation",
  create_reminder: "reminder",
  create_automation: "automation",
  create_todo: "todo",
  complete_todo: "todo",
  control_task: "task",
  act_on_note: "note_action",
  create_calendar_event: "calendar",
  update_calendar_event: "calendar",
  delete_calendar_event: "calendar",
  save_instruction: "persistent_instruction",
  save_city: "profile_configuration",
  save_note: "note_persistence",
  execute_instruction: "compound_instruction",
};

const RESEARCH_ONLY_RE =
  /^\s*(?:please\s+)?(?:research|look\s+up|search|investigate|review|summarize|analyse|analyze|read|compare|find\s+(?:out|information))\b/i;
const MUTATION_LANGUAGE_RE =
  /\b(?:send|message|tell|text|whatsapp|ask|delegate|assign|follow\s*up|remind|automation|every\s+(?:day|week|month|morning|evening)|create|add|make|complete|finish|mark\s+done|delete|remove|cancel|move|reschedule|update|change|save|remember|set\s+my)\b/i;

const FAMILY_PATTERNS: Array<{
  family: MutationFamily;
  operation: string;
  tools: readonly string[];
  pattern: RegExp;
}> = [
  {
    family: "direct_message",
    operation: "send",
    tools: ["send_direct_whatsapp_message", "execute_instruction"],
    pattern: /\b(?:send|message|tell|text|whatsapp)\b/i,
  },
  {
    family: "delegation",
    operation: "send",
    tools: ["send_delegation", "execute_instruction"],
    pattern: /\b(?:ask|delegate|assign|have|get)\b|\b(?:send|share|forward|show)\b.*\b(?:photo|image|picture)\b.*\bto\b/i,
  },
  {
    family: "followup",
    operation: "send",
    tools: ["send_followup"],
    pattern: /\bfollow\s*up\b/i,
  },
  {
    family: "reminder",
    operation: "create",
    tools: ["create_reminder"],
    pattern: /\bremind\s+me\b/i,
  },
  {
    family: "automation",
    operation: "create",
    tools: ["create_automation"],
    pattern: /\b(?:automation|recurring|daily|weekly|monthly|every\s+(?:day|week|month|morning|afternoon|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
  },
  {
    family: "calendar",
    operation: "create",
    tools: ["create_calendar_event"],
    pattern: /\b(?:add|create|schedule|book|put)\b.*\b(?:calendar|appointment|event)\b|\b(?:calendar|appointment|event)\b.*\b(?:add|create|schedule|book|put)\b/i,
  },
  {
    family: "calendar",
    operation: "update",
    tools: ["update_calendar_event"],
    pattern: /\b(?:move|reschedule|rename|update|change)\b.*\b(?:calendar|appointment|event)\b|\b(?:calendar|appointment|event)\b.*\b(?:move|reschedule|rename|update|change)\b/i,
  },
  {
    family: "calendar",
    operation: "delete",
    tools: ["delete_calendar_event"],
    pattern: /\b(?:delete|remove|cancel)\b.*\b(?:calendar|appointment|event)\b|\b(?:calendar|appointment|event)\b.*\b(?:delete|remove|cancel)\b/i,
  },
  {
    family: "todo",
    operation: "create",
    tools: ["create_todo"],
    pattern: /\b(?:add|create|make|save)\b.*\b(?:to[- ]?do|todo)\b/i,
  },
  {
    family: "todo",
    operation: "complete",
    tools: ["complete_todo"],
    pattern: /\b(?:complete|finish|mark\s+done)\b.*\b(?:to[- ]?do|todo)\b|\b(?:to[- ]?do|todo)\b.*\b(?:complete|finish|mark\s+done)\b/i,
  },
  {
    family: "task",
    operation: "mutate",
    tools: ["control_task"],
    pattern: /\b(?:task|reminder)\b.*\b(?:complete|finish|mark\s+done|delete|remove|cancel)\b|\b(?:complete|finish|mark\s+done|delete|remove|cancel)\b.*\b(?:task|reminder)\b/i,
  },
  {
    family: "note_action",
    operation: "mutate",
    tools: ["act_on_note"],
    pattern: /\b(?:turn|convert|make)\b.*\bnote\b|\bnote\b.*\b(?:task|reminder|delegate|calendar)\b/i,
  },
  {
    family: "persistent_instruction",
    operation: "save",
    tools: ["save_instruction"],
    pattern: /\b(?:remember|save)\b.*\b(?:instruction|rule|preference|from now on|always|never)\b/i,
  },
  {
    family: "profile_configuration",
    operation: "save",
    tools: ["save_city"],
    pattern: /\b(?:my city is|set my city|save my city|i live in)\b/i,
  },
  {
    family: "note_persistence",
    operation: "save",
    tools: ["save_note"],
    pattern: /\b(?:save|remember|note|capture)\b.*\b(?:note|idea|thought|this)\b/i,
  },
];

function normalize(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").toLowerCase().replace(/[“”‘’]/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ").trim()
    : "";
}

function meaningfulTokens(value: unknown): string[] {
  return normalize(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !["the", "and", "that", "with", "from", "this", "please", "here"].includes(token));
}

function contentFits(ownerText: string, proposed: unknown): boolean {
  const proposedText = normalize(proposed);
  if (!proposedText) return true;
  const owner = normalize(ownerText);
  if (owner.includes(proposedText)) return true;
  const tokens = meaningfulTokens(proposedText);
  if (tokens.length === 0) return true;
  return tokens.every((token) => owner.includes(token));
}

function readString(params: unknown, keys: string[]): string {
  if (!params || typeof params !== "object") return "";
  const record = params as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]);
  }
  return "";
}

function grant(
  family: MutationFamily,
  operation: string,
  allowedTools: readonly string[],
  suffix: string,
  extra: Partial<OwnerMutationGrant> = {},
): OwnerMutationGrant {
  return {
    grantId: `${family}:${operation}:${suffix}`,
    family,
    operation,
    allowedTools,
    maximumUses: 1,
    ...extra,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveMentionedPerson(transcript: string, people: readonly Person[]): Person | null {
  return [...people]
    .sort((a, b) => b.name.length - a.name.length)
    .find((person) => {
      const name = person.name.trim();
      return name ? new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}])`, "iu").test(transcript) : false;
    }) ?? null;
}

function parseOwnerDirectMessage(transcript: string, people: readonly Person[]) {
  const person = resolveMentionedPerson(transcript, people);
  if (!person) return null;
  const name = escapeRegExp(person.name.trim());
  const match = transcript.match(
    new RegExp(`^\\s*(?:please\\s+)?(?:send|message|tell|text|whatsapp)\\s+${name}\\s+(?:a\\s+(?:whatsapp\\s+)?message\\s+)?(?:saying\\s+|that\\s+)?(.+)$`, "iu"),
  );
  if (!match?.[1] || /^to\s+(?:call|bring|take|clean|buy|prepare|fix|make)\b/i.test(match[1])) return null;
  return { recipientName: person.name, messageText: match[1].trim() };
}

function parseOwnerDelegation(transcript: string, people: readonly Person[]) {
  const person = resolveMentionedPerson(transcript, people);
  if (!person) return null;
  const name = escapeRegExp(person.name.trim());
  const match = transcript.match(
    new RegExp(`^\\s*(?:please\\s+)?(?:ask|tell|get)\\s+${name}\\s+to\\s+(.+)$|^\\s*(?:please\\s+)?have\\s+${name}\\s+(?:to\\s+)?(.+)$`, "iu"),
  );
  const taskText = match?.[1] ?? match?.[2];
  return taskText?.trim() ? { personName: person.name, taskText: taskText.trim() } : null;
}

function stableTurnHash(value: string): string {
  // This is an identity/checksum, not a credential. The authenticated user
  // and turn id are independently checked; no security decision relies on
  // collision resistance here.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function exactProposalKey(toolName: string, params: unknown, resourceLabel?: string | null): string {
  return JSON.stringify(canonicalize({ toolName, params, resourceLabel: resourceLabel ?? null }));
}

const EXACT_CONFIRMATION_RE =
  /^\s*(?:yes|yes[,]?\s+please|confirm|confirmed|go\s+ahead|do\s+it|proceed)(?:[.!])?\s*$/i;

/**
 * Captures a model-proposed action for an explicit, bounded owner decision.
 * This object is not authority: only a later authenticated owner confirmation
 * can turn this exact proposal into a one-use grant.
 */
export function createPendingOwnerActionProposal(input: {
  authenticatedUserId: string;
  toolName: string;
  params: unknown;
  resourceLabel?: string | null;
  now?: number;
  ttlMs?: number;
  allowCompound?: boolean;
}): PendingOwnerActionProposal | null {
  const family = TOOL_FAMILY[input.toolName];
  // The existing hosting proposal/approval path owns compound hosting. Do not
  // replace or compete with it using this generic confirmation mechanism.
  if (!family || READ_ONLY_TOOLS.has(input.toolName) || (input.toolName === "execute_instruction" && !input.allowCompound)) return null;
  const now = input.now ?? Date.now();
  const params =
    input.params && typeof input.params === "object" && !Array.isArray(input.params)
      ? (canonicalize(input.params) as Record<string, unknown>)
      : {};
  const key = exactProposalKey(input.toolName, params, input.resourceLabel);
  return Object.freeze({
    version: OWNER_AUTHORITY_VERSION,
    authenticatedUserId: input.authenticatedUserId,
    proposalId: stableTurnHash(`${input.authenticatedUserId}:${now}:${key}`),
    toolName: input.toolName,
    exactProposalKey: key,
    params: Object.freeze(params),
    ...(input.resourceLabel ? { resourceLabel: input.resourceLabel } : {}),
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? 2 * 60_000),
  });
}

export function deriveConfirmedProposalEnvelope(input: {
  authenticatedUserId: string;
  turnOperationId: string;
  ownerTranscript: string;
  proposal: PendingOwnerActionProposal | null;
  people?: Person[];
  now?: number;
  ttlMs?: number;
}): OwnerAuthorizationEnvelope | null {
  const now = input.now ?? Date.now();
  const proposal = input.proposal;
  if (
    !proposal ||
    proposal.authenticatedUserId !== input.authenticatedUserId ||
    now > proposal.expiresAt ||
    !EXACT_CONFIRMATION_RE.test(input.ownerTranscript)
  ) {
    return null;
  }
  const family = TOOL_FAMILY[proposal.toolName];
  if (!family) return null;
  const approvedProposalText =
    proposal.toolName === "execute_instruction"
      ? readString(proposal.params, ["instruction", "instructions", "text", "input"])
      : "";
  if (proposal.toolName === "execute_instruction" && !approvedProposalText) return null;
  const ownerTranscript = approvedProposalText || input.ownerTranscript.trim();
  const grantValue = Object.freeze({
    ...grant(family, "confirmed_exact_proposal", [proposal.toolName], proposal.proposalId, {
      exactProposalKey: proposal.exactProposalKey,
    }),
    allowedTools: Object.freeze([proposal.toolName]),
  });
  const derivedGrants = approvedProposalText
    ? deriveOwnerAuthorizationEnvelope({
        authenticatedUserId: input.authenticatedUserId,
        turnOperationId: input.turnOperationId,
        ownerTranscript: approvedProposalText,
        people: input.people,
        now,
        ttlMs: input.ttlMs,
      }).grants.filter((item) => item.family !== "compound_instruction")
    : [];
  return Object.freeze({
    version: OWNER_AUTHORITY_VERSION,
    authenticatedUserId: input.authenticatedUserId,
    turnOperationId: input.turnOperationId,
    ownerTranscript,
    ownerTranscriptHash: stableTurnHash(ownerTranscript),
    createdAt: now,
    expiresAt: Math.min(proposal.expiresAt, now + (input.ttlMs ?? 2 * 60_000)),
    grants: Object.freeze([...derivedGrants, grantValue]),
  });
}

export function describePendingOwnerActionProposal(proposal: PendingOwnerActionProposal): string {
  const recipient = proposedRecipient(proposal.params);
  const content = proposedContent(proposal.toolName, proposal.params, proposal.resourceLabel);
  const details = [recipient ? ` for ${recipient}` : "", content ? `: “${content.slice(0, 180)}”` : ""].join("");
  return `I can only do this with your explicit approval. Confirm ${proposal.toolName}${details}?`;
}

export function deriveOwnerAuthorizationEnvelope(input: {
  authenticatedUserId: string;
  turnOperationId: string;
  ownerTranscript: string;
  people?: Person[];
  now?: number;
  ttlMs?: number;
}): OwnerAuthorizationEnvelope {
  const now = input.now ?? Date.now();
  const transcript = input.ownerTranscript.trim();
  const grants: OwnerMutationGrant[] = [];
  const people = input.people ?? [];

  // A research/retrieval request never acquires mutation authority merely
  // because later tool or MCP output contains action-shaped language.
  const researchOnly = RESEARCH_ONLY_RE.test(transcript) && !MUTATION_LANGUAGE_RE.test(transcript);
  if (!researchOnly) {
    const direct = parseOwnerDirectMessage(transcript, people);
    if (direct) {
      grants.push(
        grant("direct_message", "send", ["send_direct_whatsapp_message", "execute_instruction"], "direct", {
          recipientCanonicalName: direct.recipientName,
          canonicalContent: direct.messageText.replace(/^to\s+/i, "").trim(),
        }),
      );
    }

    const delegation = parseOwnerDelegation(transcript, people);
    if (delegation) {
      grants.push(
        grant("delegation", "send", ["send_delegation", "execute_instruction"], "delegation", {
          recipientCanonicalName: delegation.personName,
          canonicalContent: delegation.taskText,
        }),
      );
    }

    for (const entry of FAMILY_PATTERNS) {
      if (entry.pattern.test(transcript)) {
        grants.push(grant(entry.family, entry.operation, entry.tools, String(grants.length)));
      }
    }

    if (grants.length > 0) {
      grants.push(grant("compound_instruction", "execute", ["execute_instruction"], "compound", { maximumUses: grants.length }));
    }
  }

  const envelope: OwnerAuthorizationEnvelope = {
    version: OWNER_AUTHORITY_VERSION,
    authenticatedUserId: input.authenticatedUserId,
    turnOperationId: input.turnOperationId,
    ownerTranscript: transcript,
    ownerTranscriptHash: stableTurnHash(transcript),
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? 2 * 60_000),
    grants: grants.map((item) => Object.freeze({ ...item, allowedTools: Object.freeze([...item.allowedTools]) })),
  };
  return Object.freeze({ ...envelope, grants: Object.freeze(envelope.grants) });
}

function proposedRecipient(params: unknown): string {
  return readString(params, ["recipient_name", "name", "assignee_name", "person_name"]);
}

function proposedContent(toolName: string, params: unknown, resourceLabel?: string | null): string {
  if (toolName === "execute_instruction") return readString(params, ["instruction", "instructions", "text", "input"]);
  if (toolName === "create_calendar_event") return readString(params, ["title", "description"]);
  if (toolName === "update_calendar_event" || toolName === "delete_calendar_event") {
    return resourceLabel || readString(params, ["title", "event_id"]);
  }
  if (toolName === "control_task") return resourceLabel || readString(params, ["description", "query", "text", "instruction"]);
  if (toolName === "save_city") return readString(params, ["city", "name", "value"]);
  if (toolName === "save_instruction") return readString(params, ["instruction"]);
  return readString(params, ["message", "task", "description", "title", "text", "content", "query", "note"]);
}

function proposalMatches(
  grant: OwnerMutationGrant,
  envelope: OwnerAuthorizationEnvelope,
  toolName: string,
  params: unknown,
  resourceLabel?: string | null,
): boolean {
  if (grant.exactProposalKey) {
    return grant.exactProposalKey === exactProposalKey(toolName, params, resourceLabel);
  }
  const recipient = proposedRecipient(params);
  if (grant.recipientCanonicalName && normalize(recipient) !== normalize(grant.recipientCanonicalName)) return false;
  if (recipient && !grant.recipientCanonicalName && !normalize(envelope.ownerTranscript).includes(normalize(recipient))) return false;

  const content = proposedContent(toolName, params, resourceLabel);
  if (grant.canonicalContent && !contentFits(grant.canonicalContent, content)) return false;
  if (content && !grant.canonicalContent && !contentFits(envelope.ownerTranscript, content)) return false;

  const paramsRecord = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  for (const key of ["date", "time", "time_text", "due_at", "cadence_phrase", "attendee", "attendees"]) {
    const value = paramsRecord[key];
    if (typeof value === "string" && value && !normalize(envelope.ownerTranscript).includes(normalize(value))) return false;
    if (Array.isArray(value) && value.some((item) => typeof item === "string" && !normalize(envelope.ownerTranscript).includes(normalize(item)))) return false;
  }
  if (paramsRecord.override_conflict === true && !/\b(?:despite|override|anyway|still|yes|confirm|go ahead)\b/i.test(envelope.ownerTranscript)) {
    return false;
  }
  const action = normalize(paramsRecord.action);
  if (action && !normalize(envelope.ownerTranscript).includes(action)) return false;
  return true;
}

export function authorizeToolInvocation(input: ToolAuthorizationInput): ToolAuthorizationDecision {
  if (READ_ONLY_TOOLS.has(input.toolName)) return { allowed: true };
  const envelope = input.envelope;
  if (!envelope) return { allowed: false, reason: "no_envelope" };
  if (!input.authenticatedUserId || envelope.authenticatedUserId !== input.authenticatedUserId) {
    return { allowed: false, reason: "wrong_user" };
  }
  if (!input.turnOperationId || envelope.turnOperationId !== input.turnOperationId) {
    return { allowed: false, reason: "wrong_turn" };
  }
  if ((input.now ?? Date.now()) > envelope.expiresAt) return { allowed: false, reason: "expired" };

  const family = TOOL_FAMILY[input.toolName];
  if (!family) return { allowed: false, reason: "no_matching_grant" };
  const candidates = envelope.grants.filter((item) => item.allowedTools.includes(input.toolName));
  if (candidates.length === 0) return { allowed: false, reason: "no_matching_grant" };

  const matching = candidates.find((item) =>
    proposalMatches(item, envelope, input.toolName, input.params, input.resourceLabel),
  );
  if (!matching) return { allowed: false, reason: "parameter_mismatch" };
  const used = input.ledger.usesByGrantId.get(matching.grantId) ?? 0;
  if (used >= matching.maximumUses) return { allowed: false, reason: "grant_consumed" };
  if (input.consume !== false) input.ledger.usesByGrantId.set(matching.grantId, used + 1);
  return { allowed: true, grantId: matching.grantId, family: matching.family };
}

export function authorizeExtractedItems(input: {
  envelope: OwnerAuthorizationEnvelope;
  items: readonly ExtractedItem[];
}): boolean {
  return input.items.every((item) => {
    const family: MutationFamily =
      item.type === "message"
        ? "direct_message"
        : item.type === "delegation"
          ? "delegation"
          : item.type === "followup"
            ? "followup"
          : item.type === "reminder"
            ? "reminder"
            : item.type === "todo"
              ? "todo"
              : item.type === "parked"
                ? "note_persistence"
                : "task";
    return input.envelope.grants.some((grant) => {
      if (grant.family !== family) return false;
      if (item.assignedTo && item.assignedTo !== "__me__") {
        if (!normalize(input.envelope.ownerTranscript).includes(normalize(item.assignedTo))) return false;
      }
      return [item.description, item.dueText, item.suggestedMessage, item.personalNote]
        .filter((value): value is string => Boolean(value))
        .every((value) => contentFits(input.envelope.ownerTranscript, value));
    });
  });
}

export function createAuthorizationConsumptionLedger(): AuthorizationConsumptionLedger {
  return { usesByGrantId: new Map() };
}
