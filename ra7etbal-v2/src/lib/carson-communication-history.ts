/**
 * carson-communication-history.ts
 *
 * Workstream 4, Phase 1 — Unified Communication History (read-only).
 *
 * Given a person's name, reconstructs "what has Carson said to or heard
 * from this person, in chronological order?" by merging evidence already
 * durable across existing tables. This is explicitly NOT immutable — it is
 * a truthful, as-of-now read of tables that remain mutable at the database
 * level (only `whatsapp_inbound_evidence` has a real DB-enforced
 * immutability trigger, and this module deliberately does not read that
 * table, since it stores no message content — see the Phase 2 design
 * review). Workstream 4 is not complete until a separate, forward-only,
 * database-enforced evidence ledger (Phase 2) also exists. Do not describe
 * this module's output as immutable anywhere, in code or in Carson's
 * spoken/typed answers.
 *
 * Sources merged, each read-only, never written to by this module:
 *   - staff_messages                   (inbound staff message + Carson's reply)
 *   - personal_contact_replies         (inbound family/personal-contact reply)
 *   - messages                         (outbound content — delegation/direct/etc.)
 *   - whatsapp_deliveries              (delivery-status lifecycle of an outbound send,
 *                                        joined via messages.id / task_id — never
 *                                        matched by phone/name text)
 *   - staff_escalation_owner_decisions (owner decision tied to this person's
 *                                        staff message or task)
 *
 * Deliberately excluded from this slice: owner_whatsapp_reply_receipts (a
 * different relationship — Carson-to-owner, not to/from the person being
 * asked about) and personal_contact_replies.owner_notification_* fields
 * (same reason — that's Carson notifying the owner, not a communication
 * with the person). carson_typed_messages is out of scope entirely — see
 * the Phase 2 design review's explicit "Clear Chat" coexistence decision.
 *
 * Person resolution reuses the same disambiguation contract Historical
 * Lookup Phase 1/2 already established (zero matches asks the owner to
 * clarify, more than one lists candidates and asks which one, exactly one
 * proceeds — never guesses). It resolves against the `people` table
 * directly rather than `findCommitmentCandidates()`'s task-keyword search,
 * because `person_id` (not free-text `assigned_to`) is the actual foreign
 * key every source table above shares — reusing the proven *contract*, not
 * a function whose return shape (Task rows) doesn't fit this problem.
 *
 * Never infers a missing timestamp, never invents a thread/correlation id
 * (no such concept is authoritative anywhere in this schema today — see
 * the design review), and never treats a delivery-status transition as
 * message content (delivery events carry no text, ever).
 */

import { supabase } from "./supabase";

function bound(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Caps each wave-1 source-table fetch to its most recent rows — see the
 *  call sites in buildCommunicationHistory() for why an unbounded fetch
 *  is unsafe here. */
const WAVE1_ROW_LIMIT = 30;

/** Caps how many events Carson actually reads/types out — a full
 *  multi-year history must never become hundreds of spoken lines. */
const MAX_RENDERED_EVENTS = 20;

// ── Person resolution ───────────────────────────────────────────────────────

export interface PersonCandidate {
  id: string;
  name: string;
}

export type PersonResolutionStatus = "no_match" | "ambiguous" | "resolved" | "error";

export interface PersonResolution {
  status: PersonResolutionStatus;
  matches: PersonCandidate[];
}

/**
 * Resolves a name to a person via the `people` table, RLS-scoped by
 * user_id. Never guesses between multiple plausible people — same
 * disambiguation contract as findCommitmentCandidates()'s callers.
 */
export async function resolvePersonForCommunicationHistory(
  name: string,
  userId: string,
): Promise<PersonResolution> {
  const kw = name.trim();
  if (!kw) return { status: "no_match", matches: [] };

  try {
    const { data, error } = await supabase
      .from("people")
      .select("id, name")
      .eq("user_id", userId)
      .ilike("name", `%${kw}%`)
      .order("name", { ascending: true })
      .limit(6);

    if (error) return { status: "error", matches: [] };
    const matches = (data ?? []) as PersonCandidate[];
    if (matches.length === 0) return { status: "no_match", matches: [] };
    if (matches.length > 1) return { status: "ambiguous", matches };
    return { status: "resolved", matches };
  } catch {
    return { status: "error", matches: [] };
  }
}

// ── Timeline construction ───────────────────────────────────────────────────

export type CommunicationDirection = "inbound" | "outbound" | "system";

export type CommunicationSource =
  | "staff_messages"
  | "personal_contact_replies"
  | "messages"
  | "whatsapp_deliveries"
  | "staff_escalation_owner_decisions";

export interface CommunicationEvent {
  at: string;
  direction: CommunicationDirection;
  eventType: string;
  channel: string;
  label: string;
  source: CommunicationSource;
  taskId: string | null;
  transportMessageId: string | null;
}

export interface CommunicationHistoryResult {
  personId: string;
  personName: string;
  events: CommunicationEvent[];
  /** Sources that failed to query — a non-empty list means this is a
   *  partial result, never to be presented as a complete "no history". */
  failedSources: CommunicationSource[];
}

interface FetchOutcome<T> {
  rows: T[];
  failed: boolean;
}

async function fetchOrFail<T>(
  build: () => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<FetchOutcome<T>> {
  try {
    const { data, error } = await build();
    if (error) return { rows: [], failed: true };
    return { rows: data ?? [], failed: false };
  } catch {
    // A rejected promise (network failure, abort) must be as truthfully
    // "failed" as a resolved {error} shape — never let it escape uncaught
    // and lose the partial-failure answer this module exists to produce.
    return { rows: [], failed: true };
  }
}

/** Dedupes rows by id — guards against the same row matching more than one
 *  OR-branch of a downstream join (e.g. a delivery matching both by
 *  message_id and by task_id) and being counted as two events. */
function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) seen.set(row.id, row);
  return [...seen.values()];
}

interface StaffMessageRow {
  id: string;
  task_id: string | null;
  inbound_text: string;
  carson_response: string | null;
  received_at: string;
  responded_at: string | null;
  external_message_id: string | null;
}

interface ContactReplyRow {
  id: string;
  inbound_text: string;
  created_at: string;
  external_message_id: string | null;
}

interface MessageRow {
  id: string;
  task_id: string | null;
  body: string | null;
  content: string | null;
  created_at: string;
  whatsapp_message_id: string | null;
  channel: string | null;
}

interface DeliveryRow {
  id: string;
  message_id: string | null;
  task_id: string | null;
  delivery_status: string | null;
  failure_reason: string | null;
  accepted_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  meta_message_id: string | null;
}

interface EscalationRow {
  id: string;
  task_id: string | null;
  staff_message_id: string | null;
  status: string;
  owner_reply_text: string | null;
  answered_at: string | null;
  created_at: string;
}

/**
 * Builds the unified, chronologically ordered communication timeline for
 * one resolved person. Read-only against every source table — never an
 * insert/update/delete anywhere in this function.
 */
export async function buildCommunicationHistory(
  personId: string,
  personName: string,
  userId: string,
): Promise<CommunicationHistoryResult> {
  const failedSources: CommunicationSource[] = [];
  const events: CommunicationEvent[] = [];

  // Wave 1: everything filterable by person_id directly, independent of
  // one another — fetched concurrently (same reliability pattern proven
  // for get_operations_summary's own first-call fix). Capped at the most
  // recent WAVE1_ROW_LIMIT rows per table (fetched newest-first, then
  // re-sorted chronologically below along with everything else) — an
  // unbounded history would grow the wave-2 .in(...) filter URLs without
  // bound and force Carson to read an ever-growing transcript aloud.
  const [staffMsgsOutcome, contactRepliesOutcome, messagesOutcome] = await Promise.all([
    fetchOrFail<StaffMessageRow>(() =>
      supabase
        .from("staff_messages")
        .select("id, task_id, inbound_text, carson_response, received_at, responded_at, external_message_id")
        .eq("user_id", userId)
        .eq("person_id", personId)
        .order("received_at", { ascending: false })
        .limit(WAVE1_ROW_LIMIT),
    ),
    fetchOrFail<ContactReplyRow>(() =>
      supabase
        .from("personal_contact_replies")
        .select("id, inbound_text, created_at, external_message_id")
        .eq("user_id", userId)
        .eq("person_id", personId)
        .order("created_at", { ascending: false })
        .limit(WAVE1_ROW_LIMIT),
    ),
    fetchOrFail<MessageRow>(() =>
      supabase
        .from("messages")
        .select("id, task_id, body, content, created_at, whatsapp_message_id, channel")
        .eq("user_id", userId)
        .eq("person_id", personId)
        .order("created_at", { ascending: false })
        .limit(WAVE1_ROW_LIMIT),
    ),
  ]);

  if (staffMsgsOutcome.failed) failedSources.push("staff_messages");
  if (contactRepliesOutcome.failed) failedSources.push("personal_contact_replies");
  if (messagesOutcome.failed) failedSources.push("messages");

  const staffMessages = dedupeById(staffMsgsOutcome.rows);
  const contactReplies = dedupeById(contactRepliesOutcome.rows);
  const messages = dedupeById(messagesOutcome.rows);

  const messageIds = messages.map((m) => m.id);
  const staffMessageIds = staffMessages.map((m) => m.id);
  const taskIds = [
    ...new Set(
      [...staffMessages, ...messages]
        .map((r) => r.task_id)
        .filter((t): t is string => Boolean(t)),
    ),
  ];

  // Wave 2: whatsapp_deliveries and staff_escalation_owner_decisions are
  // joined via the ids resolved in wave 1 — never matched by phone/name
  // text, so they can only surface here if a real FK links them to this
  // person's own staff_messages/messages/task rows. Skipped entirely (no
  // network call, not a failure) when there is nothing to join against.
  const deliveryFilters: string[] = [];
  if (messageIds.length > 0) deliveryFilters.push(`message_id.in.(${messageIds.join(",")})`);
  if (taskIds.length > 0) deliveryFilters.push(`task_id.in.(${taskIds.join(",")})`);

  const escalationFilters: string[] = [];
  if (staffMessageIds.length > 0) escalationFilters.push(`staff_message_id.in.(${staffMessageIds.join(",")})`);
  if (taskIds.length > 0) escalationFilters.push(`task_id.in.(${taskIds.join(",")})`);

  const [deliveriesOutcome, escalationsOutcome] = await Promise.all([
    deliveryFilters.length > 0
      ? fetchOrFail<DeliveryRow>(() =>
          supabase
            .from("whatsapp_deliveries")
            .select(
              "id, message_id, task_id, delivery_status, failure_reason, accepted_at, sent_at, delivered_at, read_at, failed_at, meta_message_id",
            )
            .eq("user_id", userId)
            .or(deliveryFilters.join(",")),
        )
      : Promise.resolve<FetchOutcome<DeliveryRow>>({ rows: [], failed: false }),
    escalationFilters.length > 0
      ? fetchOrFail<EscalationRow>(() =>
          supabase
            .from("staff_escalation_owner_decisions")
            .select("id, task_id, staff_message_id, status, owner_reply_text, answered_at, created_at")
            .eq("user_id", userId)
            .or(escalationFilters.join(",")),
        )
      : Promise.resolve<FetchOutcome<EscalationRow>>({ rows: [], failed: false }),
  ]);

  if (deliveriesOutcome.failed) failedSources.push("whatsapp_deliveries");
  if (escalationsOutcome.failed) failedSources.push("staff_escalation_owner_decisions");

  const deliveries = dedupeById(deliveriesOutcome.rows);
  const escalations = dedupeById(escalationsOutcome.rows);

  // ── Event construction — one event per real, non-null timestamp on a
  // row. Never invents a missing timestamp; never fabricates a thread id.

  for (const m of staffMessages) {
    events.push({
      at: m.received_at,
      direction: "inbound",
      eventType: "staff_message_received",
      channel: "whatsapp",
      label: bound(m.inbound_text, 100),
      source: "staff_messages",
      taskId: m.task_id,
      transportMessageId: m.external_message_id,
    });
    if (m.carson_response && m.responded_at) {
      events.push({
        at: m.responded_at,
        direction: "outbound",
        eventType: "carson_response_sent",
        channel: "whatsapp",
        label: bound(m.carson_response, 100),
        source: "staff_messages",
        taskId: m.task_id,
        transportMessageId: null,
      });
    }
  }

  for (const r of contactReplies) {
    events.push({
      at: r.created_at,
      direction: "inbound",
      eventType: "personal_contact_reply_received",
      channel: "whatsapp",
      label: bound(r.inbound_text, 100),
      source: "personal_contact_replies",
      taskId: null,
      transportMessageId: r.external_message_id,
    });
  }

  for (const m of messages) {
    // content is this table's actively-written/read text column (see
    // src/lib/messages.ts's own canonical COLUMNS list); body is a legacy
    // column with no current write path anywhere in the app — kept as a
    // defensive fallback only, never preferred over content.
    const body = (m.content ?? m.body ?? "").trim();
    if (!body) continue;
    events.push({
      at: m.created_at,
      direction: "outbound",
      eventType: "message_sent",
      channel: m.channel ?? "whatsapp",
      label: bound(body, 100),
      source: "messages",
      taskId: m.task_id,
      transportMessageId: m.whatsapp_message_id,
    });
  }

  // Delivery-status events carry no text — a status transition is never
  // message content, and is labeled distinctly (eventType prefixed
  // delivery_) so it can never be mistaken for one downstream.
  for (const d of deliveries) {
    const base = { source: "whatsapp_deliveries" as const, direction: "outbound" as const, channel: "whatsapp", taskId: d.task_id, transportMessageId: d.meta_message_id };
    if (d.accepted_at) events.push({ ...base, at: d.accepted_at, eventType: "delivery_accepted", label: "Accepted by WhatsApp" });
    if (d.sent_at) events.push({ ...base, at: d.sent_at, eventType: "delivery_sent", label: "Sent" });
    if (d.delivered_at) events.push({ ...base, at: d.delivered_at, eventType: "delivery_delivered", label: "Delivered" });
    if (d.read_at) events.push({ ...base, at: d.read_at, eventType: "delivery_read", label: "Read" });
    if (d.failed_at) {
      events.push({
        ...base,
        at: d.failed_at,
        eventType: "delivery_failed",
        label: `Delivery failed${d.failure_reason ? ` (${d.failure_reason})` : ""}`,
      });
    }
  }

  for (const esc of escalations) {
    events.push({
      at: esc.created_at,
      direction: "system",
      eventType: "escalation_requested",
      channel: "whatsapp",
      label: "Owner decision requested",
      source: "staff_escalation_owner_decisions",
      taskId: esc.task_id,
      transportMessageId: null,
    });
    if (esc.answered_at) {
      const reply = esc.owner_reply_text?.trim();
      events.push({
        at: esc.answered_at,
        direction: "system",
        eventType: "escalation_decided",
        channel: "whatsapp",
        label: reply ? `Owner decided: "${bound(reply, 60)}"` : "Owner decided",
        source: "staff_escalation_owner_decisions",
        taskId: esc.task_id,
        transportMessageId: null,
      });
    }
  }

  // A malformed (non-null but unparseable) timestamp would sort as NaN and
  // render as "Invalid Date" in Carson's answer — dropped rather than risk
  // either. Source columns are typed non-null, but that's a TypeScript
  // contract, not a runtime guarantee against corrupted data.
  const validEvents = events.filter((e) => !Number.isNaN(new Date(e.at).getTime()));
  validEvents.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return { personId, personName, events: validEvents, failedSources };
}

// ── Answer formatting ───────────────────────────────────────────────────────

/**
 * Formats the evidence-based answer for Carson to speak or type. Pure and
 * network-free. Truthfully distinguishes a genuinely empty history from a
 * partial result caused by a query failure — never silently treats a
 * failure as "no history".
 */
export function formatCommunicationHistoryAnswer(result: CommunicationHistoryResult): string {
  const { personName, events, failedSources } = result;

  if (events.length === 0 && failedSources.length > 0) {
    return `I couldn't fully check ${personName}'s communication history right now — some records didn't load. Please try again.`;
  }

  if (events.length === 0) {
    return `I don't have a record of any communication with ${personName}.`;
  }

  const lines: string[] = [];
  const count = events.length;
  lines.push(`${count} communication event${count === 1 ? "" : "s"} with ${personName}, in order:`);

  // Cap what Carson actually reads/types out — the most recent
  // MAX_RENDERED_EVENTS, chronologically ordered, not the oldest.
  const rendered = count > MAX_RENDERED_EVENTS ? events.slice(count - MAX_RENDERED_EVENTS) : events;
  const currentYear = new Date().getFullYear();

  for (const e of rendered) {
    const date = new Date(e.at);
    // Include the year only when the event isn't from the current year —
    // otherwise two same-day-of-year events a year apart would render
    // identically ("Aug 1") and Carson would state an ambiguous date.
    const when = date.toLocaleDateString(
      [],
      date.getFullYear() === currentYear
        ? { month: "short", day: "numeric" }
        : { month: "short", day: "numeric", year: "numeric" },
    );
    const arrow = e.direction === "inbound" ? "from" : e.direction === "outbound" ? "to" : "about";
    lines.push(`${when} — ${e.label} (${arrow} ${personName})`);
  }

  if (count > MAX_RENDERED_EVENTS) {
    lines.push(`Showing the ${MAX_RENDERED_EVENTS} most recent of ${count} total events.`);
  }

  if (failedSources.length > 0) {
    lines.push(
      "Worth noting: this list may be incomplete — some records couldn't be checked right now.",
    );
  }

  return lines.join("\n");
}

// ── Top-level orchestrator (the future client-tool entry point) ────────────

/**
 * Workstream 4, Phase 1 entry point. Resolves the person by name (never
 * guessing between multiple plausible matches), then returns the unified,
 * evidence-based communication timeline. This is a read-only history, not
 * an immutable one — see this file's header.
 */
export async function lookupCommunicationHistory(personName: string): Promise<string> {
  const name = personName?.trim();
  if (!name) {
    return "I need a person's name to look up their communication history. Ask the user whose history they mean.";
  }

  let user: { id: string } | null;
  try {
    const {
      data: { user: resolvedUser },
    } = await supabase.auth.getUser();
    user = resolvedUser;
  } catch {
    return "I couldn't look that up right now — please try again.";
  }
  if (!user) return "I couldn't look that up right now — not signed in.";

  const resolution = await resolvePersonForCommunicationHistory(name, user.id);

  if (resolution.status === "error") {
    return `I couldn't check who "${name}" is right now — please try again.`;
  }
  if (resolution.status === "no_match") {
    return `I don't have anyone matching "${name}" in your people list.`;
  }
  if (resolution.status === "ambiguous") {
    const names = resolution.matches.map((m) => m.name).join(", ");
    return `I found more than one person matching "${name}": ${names}. Ask the user which one they mean.`;
  }

  const person = resolution.matches[0];
  const result = await buildCommunicationHistory(person.id, person.name, user.id);
  return formatCommunicationHistoryAnswer(result);
}
