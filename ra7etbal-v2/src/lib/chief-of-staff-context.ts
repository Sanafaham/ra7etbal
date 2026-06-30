import type { CalendarEvent } from "./calendar";
import { supabase } from "./supabase";

export type ChiefOfStaffFreshness = "live" | "fresh" | "recent" | "stale" | "unknown";

export interface ChiefOfStaffContextOptions {
  now?: Date;
  limits?: Partial<ChiefOfStaffContextLimits>;
  calendarEvents?: CalendarEvent[];
  calendarFetched?: boolean;
  calendarStatus?: string;
}

export interface ChiefOfStaffContextLimits {
  tasks: number;
  todos: number;
  notes: number;
  memory: number;
  facts: number;
  instructions: number;
  people: number;
  automations: number;
  automationRuns: number;
  whatsappDeliveries: number;
  calendarEvents: number;
}

export interface ChiefOfStaffProvenance {
  table?: string;
  system: string;
  source: string;
  fetched_at: string;
}

export interface ChiefOfStaffBaseItem {
  id: string;
  type: string;
  title: string;
  status: string | null;
  source: string;
  created_at: string | null;
  updated_at: string | null;
  due_at: string | null;
  person: string | null;
  confidence: number | null;
  freshness: ChiefOfStaffFreshness;
  provenance: ChiefOfStaffProvenance;
}

export interface ChiefOfStaffTaskItem extends ChiefOfStaffBaseItem {
  type: "task" | "reminder" | "delegation" | "followup" | "action" | "decision" | "errand" | "parked";
  needs_follow_up: boolean;
  confirmed_at: string | null;
  followup_sent_at: string | null;
  escalated_at: string | null;
  quality_review_status: string | null;
}

export interface ChiefOfStaffTodoItem extends ChiefOfStaffBaseItem {
  type: "todo";
  description: string | null;
  completed_at: string | null;
}

export interface ChiefOfStaffNoteItem extends ChiefOfStaffBaseItem {
  type: "note";
  category: string;
  text: string;
}

export interface ChiefOfStaffMemoryItem extends ChiefOfStaffBaseItem {
  type: "memory" | "fact";
  category: string | null;
  key: string | null;
  value: string;
}

export interface ChiefOfStaffInstructionItem extends ChiefOfStaffBaseItem {
  type: "instruction" | "household_rule";
  category: string | null;
  text: string;
}

export interface ChiefOfStaffPersonItem extends ChiefOfStaffBaseItem {
  type: "person";
  role: string | null;
  relationship: string | null;
  is_family: boolean;
  responsibilities: string | null;
  reliability_level: string | null;
  follow_up_level: string | null;
  whatsapp_opted_in: boolean | null;
}

export interface ChiefOfStaffAutomationItem extends ChiefOfStaffBaseItem {
  type: "automation" | "automation_run";
  cadence_type?: string | null;
  cadence_value?: unknown;
  next_run_at?: string | null;
  automation_id?: string | null;
  task_id?: string | null;
  failure_reason?: string | null;
}

export interface ChiefOfStaffCalendarItem extends ChiefOfStaffBaseItem {
  type: "calendar_event";
  end_at: string | null;
  location: string | null;
  all_day: boolean;
}

export interface ChiefOfStaffWhatsappItem extends ChiefOfStaffBaseItem {
  type: "whatsapp_delivery";
  delivery_status: string;
  source_type: string;
  failure_reason: string | null;
  failed_at: string | null;
}

export interface ChiefOfStaffRiskItem extends ChiefOfStaffBaseItem {
  type: "risk";
  severity: "low" | "medium" | "high";
  reason: string;
}

export interface ChiefOfStaffSectionStatus {
  ok: boolean;
  count: number;
  error?: string;
}

export interface ChiefOfStaffContext {
  user: {
    id: string | null;
    email: string;
    authenticated: boolean;
  };
  memory: ChiefOfStaffMemoryItem[];
  instructions: ChiefOfStaffInstructionItem[];
  people: ChiefOfStaffPersonItem[];
  openLoops: ChiefOfStaffBaseItem[];
  tasks: ChiefOfStaffTaskItem[];
  todos: ChiefOfStaffTodoItem[];
  notes: ChiefOfStaffNoteItem[];
  reminders: ChiefOfStaffTaskItem[];
  delegations: ChiefOfStaffTaskItem[];
  calendar: {
    status: string;
    fetched: boolean;
    events: ChiefOfStaffCalendarItem[];
  };
  automations: ChiefOfStaffAutomationItem[];
  whatsappHealth: {
    deliveries: ChiefOfStaffWhatsappItem[];
    failed: ChiefOfStaffWhatsappItem[];
  };
  risks: ChiefOfStaffRiskItem[];
  metadata: {
    generated_at: string;
    source: "chief-of-staff-context";
    read_only: true;
    section_status: Record<string, ChiefOfStaffSectionStatus>;
  };
}

interface CarsonMemoryRow {
  id?: string;
  summary: string;
  created_at: string;
}

interface CarsonFactRow {
  id: string;
  category: string;
  key: string;
  value: string;
  confidence: number | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

interface PersistentInstructionRow {
  id: string;
  category: string | null;
  instruction: string;
  created_at: string;
  updated_at: string;
}

interface HouseholdRuleRow {
  id: string;
  rules: string;
  created_at: string;
  updated_at: string;
}

interface PersonRow {
  id: string;
  name: string;
  role: string | null;
  notes: string | null;
  created_at: string;
  relationship: string | null;
  is_family: boolean | null;
  responsibilities: string | null;
  reliability_level: string | null;
  follow_up_level: string | null;
  delegation_guidance: string | null;
  communication_style: string | null;
  whatsapp_opted_in: boolean | null;
}

interface TaskRow {
  id: string;
  description: string;
  type: ChiefOfStaffTaskItem["type"];
  assigned_to: string | null;
  status: string;
  needs_follow_up: boolean | null;
  confirmed_at: string | null;
  due_at: string | null;
  archived_at: string | null;
  created_at: string;
  followup_sent_at: string | null;
  escalated_at: string | null;
  quality_review_status: string | null;
}

interface TodoRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  source: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface NoteRow {
  id: string;
  note: string;
  category: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

interface AutomationRow {
  id: string;
  title: string;
  instruction: string;
  cadence_type: string;
  cadence_value: unknown;
  timezone: string;
  next_run_at: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  people?: { name?: string | null } | null;
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  task_id: string | null;
  run_for: string;
  current_state: string;
  sent_at: string | null;
  confirmed_at: string | null;
  followup_sent_at: string | null;
  escalated_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  automations?: { title?: string | null; people?: { name?: string | null } | null } | null;
}

interface WhatsappDeliveryRow {
  id: string;
  source_type: string;
  recipient_name: string | null;
  delivery_status: string;
  failure_reason: string | null;
  failed_at: string | null;
  last_status_at: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_LIMITS: ChiefOfStaffContextLimits = {
  tasks: 100,
  todos: 100,
  notes: 50,
  memory: 20,
  facts: 50,
  instructions: 50,
  people: 50,
  automations: 50,
  automationRuns: 50,
  whatsappDeliveries: 50,
  calendarEvents: 30,
};

export async function getChiefOfStaffContext(
  userEmail: string,
  options: ChiefOfStaffContextOptions = {},
): Promise<ChiefOfStaffContext> {
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const sectionStatus: Record<string, ChiefOfStaffSectionStatus> = {};

  const userResult = await safeSection("user", sectionStatus, async () => {
    const { data } = await supabase.auth.getUser();
    return {
      id: data.user?.id ?? null,
      email: data.user?.email ?? userEmail,
      authenticated: Boolean(data.user),
    };
  }, {
    id: null,
    email: userEmail,
    authenticated: false,
  });

  const [
    tasks,
    todos,
    notes,
    memory,
    facts,
    persistentInstructions,
    people,
    householdRules,
    automations,
    automationRuns,
    whatsappDeliveries,
  ] = await Promise.all([
    loadTasks(limits.tasks, fetchedAt, now, sectionStatus),
    loadTodos(limits.todos, fetchedAt, now, sectionStatus),
    loadNotes(limits.notes, fetchedAt, now, sectionStatus),
    loadMemory(limits.memory, fetchedAt, now, sectionStatus),
    loadFacts(limits.facts, fetchedAt, now, sectionStatus),
    loadPersistentInstructions(limits.instructions, fetchedAt, now, sectionStatus),
    loadPeople(limits.people, fetchedAt, now, sectionStatus),
    loadHouseholdRules(fetchedAt, now, sectionStatus),
    loadAutomations(limits.automations, fetchedAt, now, sectionStatus),
    loadAutomationRuns(limits.automationRuns, fetchedAt, now, sectionStatus),
    loadWhatsappDeliveries(limits.whatsappDeliveries, fetchedAt, now, sectionStatus),
  ]);

  const instructions = [...persistentInstructions, ...householdRules];
  const reminders = tasks.filter((item) => item.type === "reminder");
  const delegations = tasks.filter((item) => item.type === "delegation" || item.type === "followup");
  const calendar = buildCalendarSection(options, limits.calendarEvents, fetchedAt, now, sectionStatus);
  const openLoops = buildOpenLoops(tasks, todos, automations);
  const risks = buildRisks({
    tasks,
    automations,
    whatsappDeliveries,
    now,
    fetchedAt,
  });

  return {
    user: userResult,
    memory: [...memory, ...facts],
    instructions,
    people,
    openLoops,
    tasks,
    todos,
    notes,
    reminders,
    delegations,
    calendar,
    automations: [...automations, ...automationRuns],
    whatsappHealth: {
      deliveries: whatsappDeliveries,
      failed: whatsappDeliveries.filter((item) => item.delivery_status === "failed"),
    },
    risks,
    metadata: {
      generated_at: fetchedAt,
      source: "chief-of-staff-context",
      read_only: true,
      section_status: sectionStatus,
    },
  };
}

export function summarizeChiefOfStaffContext(context: ChiefOfStaffContext): string {
  const activeTodos = context.todos.filter((todo) => todo.status === "active").length;
  const openTasks = context.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled").length;
  const waiting = context.delegations.filter((task) => task.status !== "done" && task.status !== "cancelled").length;
  const dueReminders = context.reminders.filter((task) => task.status !== "done").length;
  const failedWhatsapp = context.whatsappHealth.failed.length;
  const failedAutomations = context.automations.filter(
    (item) => item.status === "failed" || item.failure_reason,
  ).length;
  const highRisks = context.risks.filter((risk) => risk.severity === "high").length;

  const parts = [
    context.user.email ? `Context for ${context.user.email}.` : "Chief of Staff context loaded.",
    `${openTasks} open task${openTasks === 1 ? "" : "s"}.`,
    `${activeTodos} active to-do${activeTodos === 1 ? "" : "s"}.`,
    `${waiting} waiting item${waiting === 1 ? "" : "s"}.`,
    `${dueReminders} reminder${dueReminders === 1 ? "" : "s"} visible.`,
    `${context.notes.length} saved note${context.notes.length === 1 ? "" : "s"}.`,
    `${context.people.length} people in context.`,
  ];

  if (context.calendar.fetched) {
    parts.push(`${context.calendar.events.length} calendar event${context.calendar.events.length === 1 ? "" : "s"} provided.`);
  }
  if (failedWhatsapp > 0) parts.push(`${failedWhatsapp} WhatsApp delivery issue${failedWhatsapp === 1 ? "" : "s"}.`);
  if (failedAutomations > 0) parts.push(`${failedAutomations} automation issue${failedAutomations === 1 ? "" : "s"}.`);
  if (highRisks > 0) parts.push(`${highRisks} high-risk item${highRisks === 1 ? "" : "s"} needs attention.`);
  if (context.risks.length === 0) parts.push("No immediate risks detected from loaded context.");

  return parts.join(" ");
}

async function loadTasks(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffTaskItem[]> {
  return safeSection("tasks", status, async () => {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, description, type, assigned_to, status, needs_follow_up, confirmed_at, due_at, archived_at, created_at, followup_sent_at, escalated_at, quality_review_status")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as TaskRow[]).map((row) => ({
      id: row.id,
      type: row.type,
      title: row.description,
      status: row.status,
      source: "tasks",
      created_at: row.created_at,
      updated_at: row.confirmed_at ?? row.created_at,
      due_at: row.due_at,
      person: row.assigned_to,
      confidence: 1,
      freshness: freshnessFrom(row.confirmed_at ?? row.due_at ?? row.created_at, now),
      provenance: provenance("tasks", fetchedAt),
      needs_follow_up: Boolean(row.needs_follow_up),
      confirmed_at: row.confirmed_at,
      followup_sent_at: row.followup_sent_at,
      escalated_at: row.escalated_at,
      quality_review_status: row.quality_review_status,
    }));
  }, []);
}

async function loadTodos(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffTodoItem[]> {
  return safeSection("todos", status, async () => {
    const { data, error } = await supabase
      .from("carson_todos")
      .select("id, title, description, status, source, created_at, updated_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as TodoRow[]).map((row) => ({
      id: row.id,
      type: "todo",
      title: row.title,
      status: row.status,
      source: row.source ?? "carson_todos",
      created_at: row.created_at,
      updated_at: row.updated_at,
      due_at: null,
      person: null,
      confidence: 1,
      freshness: freshnessFrom(row.updated_at ?? row.created_at, now),
      provenance: provenance("carson_todos", fetchedAt),
      description: row.description,
      completed_at: row.completed_at,
    }));
  }, []);
}

async function loadNotes(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffNoteItem[]> {
  return safeSection("notes", status, async () => {
    const { data, error } = await supabase
      .from("carson_notes")
      .select("id, note, category, source, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as NoteRow[]).map((row) => ({
      id: row.id,
      type: "note",
      title: row.note,
      status: "saved",
      source: row.source ?? "carson_notes",
      created_at: row.created_at,
      updated_at: row.updated_at,
      due_at: null,
      person: null,
      confidence: 1,
      freshness: freshnessFrom(row.updated_at ?? row.created_at, now),
      provenance: provenance("carson_notes", fetchedAt),
      category: row.category ?? "general",
      text: row.note,
    }));
  }, []);
}

async function loadMemory(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffMemoryItem[]> {
  return safeSection("memory", status, async () => {
    const { data, error } = await supabase
      .from("carson_memory")
      .select("id, summary, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as CarsonMemoryRow[]).map((row, index) => ({
      id: row.id ?? `carson_memory_${index}`,
      type: "memory",
      title: row.summary,
      status: "saved",
      source: "carson_memory",
      created_at: row.created_at,
      updated_at: row.created_at,
      due_at: null,
      person: null,
      confidence: null,
      freshness: freshnessFrom(row.created_at, now),
      provenance: provenance("carson_memory", fetchedAt),
      category: "session",
      key: null,
      value: row.summary,
    }));
  }, []);
}

async function loadFacts(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffMemoryItem[]> {
  return safeSection("facts", status, async () => {
    const { data, error } = await supabase
      .from("carson_facts")
      .select("id, category, key, value, confidence, source, created_at, updated_at, last_seen_at")
      .is("archived_at", null)
      .order("category", { ascending: true })
      .order("key", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as CarsonFactRow[]).map((row) => ({
      id: row.id,
      type: "fact",
      title: `${row.category}: ${row.key}`,
      status: "active",
      source: row.source ?? "carson_facts",
      created_at: row.created_at,
      updated_at: row.updated_at,
      due_at: null,
      person: null,
      confidence: row.confidence,
      freshness: freshnessFrom(row.last_seen_at ?? row.updated_at, now),
      provenance: provenance("carson_facts", fetchedAt),
      category: row.category,
      key: row.key,
      value: row.value,
    }));
  }, []);
}

async function loadPersistentInstructions(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffInstructionItem[]> {
  return safeSection("instructions", status, async () => {
    const { data, error } = await supabase
      .from("carson_persistent_memory")
      .select("id, category, instruction, created_at, updated_at")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as PersistentInstructionRow[]).map((row) => ({
      id: row.id,
      type: "instruction",
      title: row.instruction,
      status: "active",
      source: "carson_persistent_memory",
      created_at: row.created_at,
      updated_at: row.updated_at,
      due_at: null,
      person: null,
      confidence: 1,
      freshness: freshnessFrom(row.updated_at ?? row.created_at, now),
      provenance: provenance("carson_persistent_memory", fetchedAt),
      category: row.category,
      text: row.instruction,
    }));
  }, []);
}

async function loadPeople(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffPersonItem[]> {
  return safeSection("people", status, async () => {
    const { data, error } = await supabase
      .from("people")
      .select("id, name, role, notes, created_at, relationship, is_family, responsibilities, reliability_level, follow_up_level, delegation_guidance, communication_style, whatsapp_opted_in")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as PersonRow[]).map((row) => ({
      id: row.id,
      type: "person",
      title: row.name,
      status: "active",
      source: "people",
      created_at: row.created_at,
      updated_at: row.created_at,
      due_at: null,
      person: row.name,
      confidence: 1,
      freshness: freshnessFrom(row.created_at, now),
      provenance: provenance("people", fetchedAt),
      role: row.role,
      relationship: row.relationship,
      is_family: Boolean(row.is_family),
      responsibilities: row.responsibilities,
      reliability_level: row.reliability_level,
      follow_up_level: row.follow_up_level,
      whatsapp_opted_in: row.whatsapp_opted_in,
    }));
  }, []);
}

async function loadHouseholdRules(
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffInstructionItem[]> {
  return safeSection("household_rules", status, async () => {
    const { data, error } = await supabase
      .from("household_rules")
      .select("id, rules, created_at, updated_at")
      .maybeSingle();
    if (error) throw error;
    const row = data as HouseholdRuleRow | null;
    if (!row) return [];
    return [{
      id: row.id,
      type: "household_rule",
      title: "Household delegation rules",
      status: "active",
      source: "household_rules",
      created_at: row.created_at,
      updated_at: row.updated_at,
      due_at: null,
      person: null,
      confidence: 1,
      freshness: freshnessFrom(row.updated_at ?? row.created_at, now),
      provenance: provenance("household_rules", fetchedAt),
      category: "household",
      text: row.rules,
    }];
  }, []);
}

async function loadAutomations(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffAutomationItem[]> {
  return safeSection("automations", status, async () => {
    const { data, error } = await supabase
      .from("automations")
      .select("id, title, instruction, cadence_type, cadence_value, timezone, next_run_at, status, created_by, created_at, updated_at, people(name)")
      .order("next_run_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as AutomationRow[]).map((row) => ({
      id: row.id,
      type: "automation",
      title: row.title,
      status: row.status,
      source: row.created_by ?? "automations",
      created_at: row.created_at,
      updated_at: row.updated_at,
      due_at: row.next_run_at,
      person: row.people?.name ?? null,
      confidence: 1,
      freshness: freshnessFrom(row.updated_at ?? row.next_run_at, now),
      provenance: provenance("automations", fetchedAt),
      cadence_type: row.cadence_type,
      cadence_value: row.cadence_value,
      next_run_at: row.next_run_at,
    }));
  }, []);
}

async function loadAutomationRuns(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffAutomationItem[]> {
  return safeSection("automation_runs", status, async () => {
    const { data, error } = await supabase
      .from("automation_runs")
      .select("id, automation_id, task_id, run_for, current_state, sent_at, confirmed_at, followup_sent_at, escalated_at, completed_at, failure_reason, created_at, updated_at, automations(title, people(name))")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as AutomationRunRow[]).map((row) => ({
      id: row.id,
      type: "automation_run",
      title: row.automations?.title ?? "Automation run",
      status: row.current_state,
      source: "automation_runs",
      created_at: row.created_at,
      updated_at: row.updated_at,
      due_at: row.run_for,
      person: row.automations?.people?.name ?? null,
      confidence: row.failure_reason ? 0.95 : 1,
      freshness: freshnessFrom(row.updated_at ?? row.created_at, now),
      provenance: provenance("automation_runs", fetchedAt),
      automation_id: row.automation_id,
      task_id: row.task_id,
      failure_reason: row.failure_reason,
    }));
  }, []);
}

async function loadWhatsappDeliveries(
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): Promise<ChiefOfStaffWhatsappItem[]> {
  return safeSection("whatsapp_deliveries", status, async () => {
    const { data, error } = await supabase
      .from("whatsapp_deliveries")
      .select("id, source_type, recipient_name, delivery_status, failure_reason, failed_at, last_status_at, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as WhatsappDeliveryRow[]).map((row) => ({
      id: row.id,
      type: "whatsapp_delivery",
      title: row.recipient_name ? `WhatsApp to ${row.recipient_name}` : "WhatsApp delivery",
      status: row.delivery_status,
      source: "whatsapp_deliveries",
      created_at: row.created_at,
      updated_at: row.updated_at,
      due_at: null,
      person: row.recipient_name,
      confidence: row.delivery_status === "failed" ? 0.95 : 1,
      freshness: freshnessFrom(row.last_status_at ?? row.updated_at ?? row.created_at, now),
      provenance: provenance("whatsapp_deliveries", fetchedAt),
      delivery_status: row.delivery_status,
      source_type: row.source_type,
      failure_reason: row.failure_reason,
      failed_at: row.failed_at,
    }));
  }, []);
}

function buildCalendarSection(
  options: ChiefOfStaffContextOptions,
  limit: number,
  fetchedAt: string,
  now: Date,
  status: Record<string, ChiefOfStaffSectionStatus>,
): ChiefOfStaffContext["calendar"] {
  const rows = (options.calendarEvents ?? []).slice(0, limit).map((event) => ({
    id: event.id,
    type: "calendar_event" as const,
    title: event.title,
    status: event.start && new Date(event.start).getTime() < now.getTime() ? "past" : "upcoming",
    source: "calendar_context",
    created_at: null,
    updated_at: null,
    due_at: event.start,
    person: null,
    confidence: 1,
    freshness: "live" as const,
    provenance: {
      system: "google_calendar",
      source: "provided_calendar_context",
      fetched_at: fetchedAt,
    },
    end_at: event.end,
    location: event.location ?? null,
    all_day: event.allDay,
  }));
  status.calendar = { ok: true, count: rows.length };
  return {
    status: options.calendarStatus ?? (options.calendarFetched ? "provided" : "not_provided"),
    fetched: Boolean(options.calendarFetched || rows.length > 0),
    events: rows,
  };
}

function buildOpenLoops(
  tasks: ChiefOfStaffTaskItem[],
  todos: ChiefOfStaffTodoItem[],
  automations: ChiefOfStaffAutomationItem[],
): ChiefOfStaffBaseItem[] {
  return [
    ...tasks.filter((item) => item.status !== "done" && item.status !== "cancelled"),
    ...todos.filter((item) => item.status === "active"),
    ...automations.filter((item) => item.status === "active" || item.status === "failed"),
  ];
}

function buildRisks(input: {
  tasks: ChiefOfStaffTaskItem[];
  automations: ChiefOfStaffAutomationItem[];
  whatsappDeliveries: ChiefOfStaffWhatsappItem[];
  now: Date;
  fetchedAt: string;
}): ChiefOfStaffRiskItem[] {
  const risks: ChiefOfStaffRiskItem[] = [];
  for (const task of input.tasks) {
    if (task.status === "done" || task.status === "cancelled") continue;
    if (task.escalated_at) {
      risks.push(makeRisk(task, "high", "Delegated item has escalated.", input.fetchedAt));
      continue;
    }
    if (task.due_at && new Date(task.due_at).getTime() < input.now.getTime()) {
      risks.push(makeRisk(task, "medium", "Item is past its due time.", input.fetchedAt));
    }
  }
  for (const automation of input.automations) {
    if (automation.status === "failed" || automation.failure_reason) {
      risks.push(makeRisk(automation, "high", automation.failure_reason ?? "Automation run failed.", input.fetchedAt));
    }
  }
  for (const delivery of input.whatsappDeliveries) {
    if (delivery.delivery_status === "failed") {
      risks.push(makeRisk(delivery, "medium", delivery.failure_reason ?? "WhatsApp delivery failed.", input.fetchedAt));
    }
  }
  return risks.slice(0, 20);
}

function makeRisk(
  item: ChiefOfStaffBaseItem,
  severity: ChiefOfStaffRiskItem["severity"],
  reason: string,
  fetchedAt: string,
): ChiefOfStaffRiskItem {
  return {
    id: `risk:${item.id}`,
    type: "risk",
    title: item.title,
    status: severity,
    source: item.source,
    created_at: item.created_at,
    updated_at: item.updated_at,
    due_at: item.due_at,
    person: item.person,
    confidence: 0.9,
    freshness: item.freshness,
    provenance: {
      system: "ra7etbal",
      source: `derived_from:${item.provenance.table ?? item.source}`,
      fetched_at: fetchedAt,
    },
    severity,
    reason,
  };
}

async function safeSection<T>(
  name: string,
  status: Record<string, ChiefOfStaffSectionStatus>,
  load: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    const result = await load();
    status[name] = { ok: true, count: Array.isArray(result) ? result.length : 1 };
    return result;
  } catch (error) {
    status[name] = {
      ok: false,
      count: Array.isArray(fallback) ? fallback.length : 0,
      error: error instanceof Error ? error.message : "Unknown load error",
    };
    return fallback;
  }
}

function provenance(table: string, fetchedAt: string): ChiefOfStaffProvenance {
  return {
    table,
    system: "supabase",
    source: table,
    fetched_at: fetchedAt,
  };
}

function freshnessFrom(value: string | null | undefined, now: Date): ChiefOfStaffFreshness {
  if (!value) return "unknown";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "unknown";
  const ageMs = Math.abs(now.getTime() - timestamp);
  if (ageMs < 5 * 60_000) return "live";
  if (ageMs < 24 * 3_600_000) return "fresh";
  if (ageMs < 7 * 24 * 3_600_000) return "recent";
  return "stale";
}
