import { buildDailyBrief } from "./daily-brief";
import { getUpcomingReminderTasks } from "./updates-reminders";
import { isReminderOverdue } from "./reminder-time";
import { createTodo, completeTodo, deleteTodo, updateTodo, findTodoMatches, listActiveTodos, type CarsonTodo } from "./carson-todos";
import { loadRecentNotes, deleteCarsonNote, findNoteMatches, type CarsonNote } from "./carson-notes";
import { createReminderTask } from "./reminders";
import { parseVoiceTime } from "./parse-voice-time";
import { useTasksStore } from "../stores/tasks";
import { supabase } from "./supabase";
import type { Task } from "../types/task";

export type CarsonUpdateKind = "needs_you" | "waiting" | "todo" | "note" | "reminder" | "automation";
export type CarsonUpdateAction =
  | "complete"
  | "delete"
  | "snooze"
  | "reschedule"
  | "update"
  | "convert_to_todo"
  | "convert_to_reminder"
  | "follow_up"
  | "continue_waiting"
  | "cancel_waiting"
  | "pause"
  | "resume";

export interface AutomationSummary {
  id: string;
  title: string;
  instruction: string;
  status: "active" | "paused" | "stopped" | "archived";
  next_run_at: string | null;
  created_at: string;
}

export interface CarsonUpdateItem {
  kind: CarsonUpdateKind;
  id: string;
  title: string;
  detail: string;
  status?: string | null;
  dueAt?: string | null;
  assignee?: string | null;
  createdAt?: string | null;
  source: Task | CarsonTodo | CarsonNote | AutomationSummary;
}

export interface CarsonUpdatesSnapshot {
  needsYou: CarsonUpdateItem[];
  waiting: CarsonUpdateItem[];
  todos: CarsonUpdateItem[];
  notes: CarsonUpdateItem[];
  reminders: CarsonUpdateItem[];
  automations: CarsonUpdateItem[];
}

export type CarsonProactiveDecision =
  | "turn into To-do"
  | "turn into reminder"
  | "leave as note"
  | "delete"
  | "mark done"
  | "reschedule"
  | "snooze"
  | "follow up"
  | "keep waiting"
  | "cancel"
  | "keep"
  | "pause"
  | "resume"
  | "update"
  | "complete";

export interface CarsonProactiveUpdatePrompt {
  item: CarsonUpdateItem;
  itemKey: string;
  prompt: string;
  actions: CarsonProactiveDecision[];
  priority: number;
}

export interface CarsonProactiveDismissalContinuation {
  suppressedItemKey: string;
  nextPrompt: CarsonProactiveUpdatePrompt | null;
  message: string;
}

export interface CarsonUpdatesDeps {
  now?: Date;
  tasks?: Task[];
  todos?: CarsonTodo[];
  notes?: CarsonNote[];
  automations?: AutomationSummary[];
  listTodos?: () => Promise<CarsonTodo[]>;
  listNotes?: () => Promise<CarsonNote[]>;
  listAutomations?: () => Promise<AutomationSummary[]>;
  markTaskDone?: (task: Task) => Promise<Task>;
  deleteTask?: (task: Task) => Promise<void>;
  updateTask?: (task: Task, patch: Partial<Pick<Task, "description" | "due_at" | "status" | "confirmed_at">>) => Promise<Task>;
  completeTodo?: (todo: CarsonTodo) => Promise<void>;
  deleteTodo?: (todo: CarsonTodo) => Promise<void>;
  updateTodo?: (todo: CarsonTodo, patch: { title?: string; description?: string | null }) => Promise<void>;
  deleteNote?: (note: CarsonNote) => Promise<void>;
  createTodo?: (title: string, description?: string | null, source?: string) => Promise<CarsonTodo>;
  createReminder?: (input: { userId: string; text: string; dueAt: string | null; source: string }) => Promise<Task>;
  patchAutomation?: (automation: AutomationSummary, patch: Record<string, unknown>) => Promise<AutomationSummary>;
  deleteAutomation?: (automation: AutomationSummary) => Promise<void>;
}

export function parseCarsonUpdatesIntent(text: string): {
  action: CarsonUpdateAction | "list";
  kind?: CarsonUpdateKind | "task";
  query?: string;
  time_text?: string;
  text?: string;
} | null {
  const raw = text.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const kind = inferKind(lower);

  if (/\b(?:what|show|list|which)\b/.test(lower) && kind) {
    return { action: "list", kind };
  }
  if (/\bwhat\s+is\s+carson\s+managing\b|\bwhat\s+are\s+you\s+managing\b/.test(lower)) {
    return { action: "list" };
  }

  const action = inferAction(lower);
  if (!action) return null;
  const query = cleanQuery(raw);
  if (!query && !/\b(?:this|that|it)\b/i.test(raw)) return null;
  return { action, kind, query: query || raw, time_text: extractTimePhrase(raw), text: extractUpdateText(raw) };
}

export async function loadCarsonUpdatesSnapshot(deps: CarsonUpdatesDeps = {}): Promise<CarsonUpdatesSnapshot> {
  const tasks = deps.tasks ?? useTasksStore.getState().items;
  const listTodos = deps.listTodos ?? (() => listActiveTodos(50));
  const listNotes = deps.listNotes ?? (() => loadRecentNotes(50));
  const listAutomations = deps.listAutomations ?? listActiveAutomationsForCurrentUser;
  const todos = deps.todos ?? await listTodos();
  const notes = deps.notes ?? await listNotes();
  const automations = deps.automations ?? await listAutomations();
  return buildCarsonUpdatesSnapshot({ tasks, todos, notes, automations, now: deps.now });
}

export function buildCarsonUpdatesSnapshot(input: {
  tasks: Task[];
  todos: CarsonTodo[];
  notes: CarsonNote[];
  automations: AutomationSummary[];
  now?: Date;
}): CarsonUpdatesSnapshot {
  const now = input.now ?? new Date();
  const brief = buildDailyBrief(input.tasks, now);
  const upcomingReminders = getUpcomingReminderTasks(input.tasks, brief.needsAttention, now);
  const dueReminders = brief.needsAttention.filter((task) => task.type === "reminder");

  return {
    needsYou: brief.needsAttention.map(taskToItem("needs_you")),
    waiting: brief.waitingOnOthers.map(taskToItem("waiting")),
    todos: input.todos.filter((todo) => todo.status === "active").map(todoToItem),
    notes: input.notes.map(noteToItem),
    reminders: [...dueReminders, ...upcomingReminders]
      .filter(uniqueById)
      .map(taskToItem("reminder")),
    automations: input.automations
      .filter((automation) => automation.status === "active" || automation.status === "paused")
      .map(automationToItem),
  };
}

export function summarizeCarsonUpdates(snapshot: CarsonUpdatesSnapshot, kind?: CarsonUpdateKind | "all"): string {
  const sections: Array<[string, CarsonUpdateItem[]]> =
    kind && kind !== "all"
      ? [[labelForKind(kind), itemsForKind(snapshot, kind)]]
      : [
          ["Needs You", snapshot.needsYou],
          ["Waiting", snapshot.waiting],
          ["To-do", snapshot.todos],
          ["Notes", snapshot.notes],
          ["Reminders", snapshot.reminders],
          ["Automations", snapshot.automations],
        ];

  const lines = sections.map(([label, items]) => {
    if (items.length === 0) return `${label}: none.`;
    const preview = items.slice(0, 3).map((item) => item.title).join("; ");
    const extra = items.length > 3 ? `, plus ${items.length - 3} more` : "";
    return `${label}: ${preview}${extra}.`;
  });
  return lines.join(" ");
}

export function getCarsonUpdateItemKey(item: CarsonUpdateItem): string {
  if (item.kind === "needs_you" || item.kind === "waiting" || item.kind === "reminder") {
    return `task:${(item.source as Task).id}`;
  }
  if (item.kind === "todo") return `todo:${(item.source as CarsonTodo).id}`;
  if (item.kind === "note") return `note:${(item.source as CarsonNote).id}`;
  return `automation:${(item.source as AutomationSummary).id}`;
}

export function isCarsonProactiveUpdateDismissal(value: string): boolean {
  return /\b(?:not now|later|leave it|leave this|ignore it|skip it|dismiss|keep it|keep as is|nothing for now)\b/i.test(value.trim());
}

export function chooseProactiveCarsonUpdate(
  snapshot: CarsonUpdatesSnapshot,
  input: { now?: Date; suppressedItemKeys?: Iterable<string> } = {},
): CarsonProactiveUpdatePrompt | null {
  const now = input.now ?? new Date();
  const suppressed = new Set(input.suppressedItemKeys ?? []);
  const candidates = [
    ...snapshot.needsYou.map((item) => buildProactiveCandidate(item, now)),
    ...snapshot.reminders.map((item) => buildProactiveCandidate(item, now)),
    ...snapshot.waiting.map((item) => buildProactiveCandidate(item, now)),
    ...snapshot.todos.map((item) => buildProactiveCandidate(item, now)),
    ...snapshot.notes.map((item) => buildProactiveCandidate(item, now)),
    ...snapshot.automations.map((item) => buildProactiveCandidate(item, now)),
  ]
    .filter((candidate): candidate is CarsonProactiveUpdatePrompt => Boolean(candidate))
    .filter((candidate) => !suppressed.has(candidate.itemKey))
    .sort((a, b) => a.priority - b.priority || getUpdateDateValue(a.item.dueAt ?? a.item.createdAt) - getUpdateDateValue(b.item.dueAt ?? b.item.createdAt));

  return candidates[0] ?? null;
}

export function buildProactiveDismissalContinuation(input: {
  current: CarsonProactiveUpdatePrompt;
  snapshot: CarsonUpdatesSnapshot;
  suppressedItemKeys?: Iterable<string>;
  now?: Date;
}): CarsonProactiveDismissalContinuation {
  const suppressed = new Set(input.suppressedItemKeys ?? []);
  suppressed.add(input.current.itemKey);
  const nextPrompt = chooseProactiveCarsonUpdate(input.snapshot, {
    now: input.now,
    suppressedItemKeys: suppressed,
  });
  return {
    suppressedItemKey: input.current.itemKey,
    nextPrompt,
    message: nextPrompt?.prompt ?? "That is everything requiring attention right now.",
  };
}

export function resolveCarsonUpdateItem(
  snapshot: CarsonUpdatesSnapshot,
  input: { kind?: CarsonUpdateKind | "task"; id?: string | null; query?: string | null },
): { status: "matched"; item: CarsonUpdateItem } | { status: "not_found" } | { status: "ambiguous"; matches: CarsonUpdateItem[] } {
  const id = input.id?.trim();
  const candidates = input.kind ? itemsForKindOrTask(snapshot, input.kind) : allItems(snapshot);
  if (id) {
    const byId = candidates.find((item) => item.id === id);
    return byId ? { status: "matched", item: byId } : { status: "not_found" };
  }

  const query = input.query?.trim() ?? "";
  if (!query) return { status: "not_found" };
  const matches = findUpdateMatches(candidates, query);
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "matched", item: matches[0] };
}

export async function actOnCarsonUpdate(input: {
  userId: string | null | undefined;
  action: CarsonUpdateAction;
  kind?: CarsonUpdateKind | "task";
  id?: string | null;
  query?: string | null;
  text?: string | null;
  time_text?: string | null;
  due_at?: string | null;
}, deps: CarsonUpdatesDeps = {}): Promise<string> {
  if (!input.userId) return "You are not signed in. Please sign in and try again.";
  const snapshot = await loadCarsonUpdatesSnapshot(deps);
  const resolved = resolveCarsonUpdateItem(snapshot, input);
  if (resolved.status === "not_found") return "I couldn't find that item. Which one do you mean?";
  if (resolved.status === "ambiguous") {
    const names = resolved.matches.slice(0, 4).map((item) => `"${truncate(item.title)}"`).join(", ");
    return `I found more than one matching item: ${names}. Which one should I update?`;
  }

  const item = resolved.item;
  if (item.kind === "todo") return actOnTodo(item.source as CarsonTodo, input, deps);
  if (item.kind === "note") return actOnNote(item.source as CarsonNote, input, deps);
  if (item.kind === "automation") return actOnAutomation(item.source as AutomationSummary, input, deps);
  return actOnTask(item.source as Task, input, deps);
}

async function actOnTask(task: Task, input: Parameters<typeof actOnCarsonUpdate>[0], deps: CarsonUpdatesDeps): Promise<string> {
  const markDone = deps.markTaskDone ?? ((t) => useTasksStore.getState().markDone(t.id));
  const remove = deps.deleteTask ?? ((t) => useTasksStore.getState().remove(t.id));
  const update = deps.updateTask ?? ((t, patch) => useTasksStore.getState().update(t.id, patch));

  if (input.action === "complete") {
    await markDone(task);
    return task.type === "reminder" ? "Done. I marked that reminder complete." : "Done. I marked that item complete.";
  }
  if (input.action === "follow_up") {
    return "That waiting item needs the existing follow-up sender.";
  }
  if (input.action === "delete" || input.action === "cancel_waiting") {
    await remove(task);
    return task.type === "reminder" ? "Done. I deleted that reminder." : "Done. I deleted that item.";
  }
  if (input.action === "continue_waiting") return "Done. I'll keep waiting on that.";
  if (input.action === "snooze" || input.action === "reschedule") {
    const dueAt = resolveDueAt(input);
    if (!dueAt) return "I need a clear time for that. When should I move it to?";
    await update(task, { due_at: dueAt });
    return `Done. I moved it to ${formatDue(dueAt)}.`;
  }
  if (input.action === "update") {
    const text = input.text?.trim();
    if (!text) return "What should I change it to?";
    await update(task, { description: text });
    return "Done. I updated it.";
  }
  return "That action is not supported for this item yet.";
}

async function actOnTodo(todo: CarsonTodo, input: Parameters<typeof actOnCarsonUpdate>[0], deps: CarsonUpdatesDeps): Promise<string> {
  if (input.action === "complete") {
    await (deps.completeTodo ?? ((t) => completeTodo(t.id)))(todo);
    return "Done. I marked that to-do complete.";
  }
  if (input.action === "delete") {
    await (deps.deleteTodo ?? ((t) => deleteTodo(t.id)))(todo);
    return "Done. I deleted that to-do.";
  }
  if (input.action === "update") {
    const text = input.text?.trim();
    if (!text) return "What should I change it to?";
    await (deps.updateTodo ?? ((t, patch) => updateTodo(t.id, patch)))(todo, { title: text });
    return "Done. I updated that to-do.";
  }
  return "That action is not supported for that to-do yet.";
}

async function actOnNote(note: CarsonNote, input: Parameters<typeof actOnCarsonUpdate>[0], deps: CarsonUpdatesDeps): Promise<string> {
  if (input.action === "delete") {
    await (deps.deleteNote ?? ((n) => deleteCarsonNote(n.id)))(note);
    return "Done. I deleted that note.";
  }
  if (input.action === "convert_to_todo") {
    await (deps.createTodo ?? createTodo)(note.note, null, "note");
    return "Done. I turned that note into a to-do.";
  }
  if (input.action === "convert_to_reminder") {
    const dueAt = resolveDueAt(input);
    if (!dueAt) return "I need to know when to remind you.";
    await (deps.createReminder ?? createReminderTask)({
      userId: input.userId!,
      text: note.note,
      dueAt,
      source: "carson_updates",
    });
    return `Done. I'll remind you ${formatDue(dueAt)}.`;
  }
  return "That note can be deleted, turned into a to-do, or turned into a reminder.";
}

async function actOnAutomation(automation: AutomationSummary, input: Parameters<typeof actOnCarsonUpdate>[0], deps: CarsonUpdatesDeps): Promise<string> {
  if (input.action === "pause" || input.action === "resume") {
    await (deps.patchAutomation ?? patchAutomationForCurrentUser)(automation, { action: input.action });
    return input.action === "pause" ? "Done. I paused that automation." : "Done. I resumed that automation.";
  }
  if (input.action === "delete") {
    await (deps.deleteAutomation ?? deleteAutomationForCurrentUser)(automation);
    return "Done. I deleted that automation.";
  }
  if (input.action === "update") {
    const text = input.text?.trim();
    if (!text) return "What should I change that automation to?";
    await (deps.patchAutomation ?? patchAutomationForCurrentUser)(automation, { instruction: text });
    return "Done. I updated that automation.";
  }
  return "That automation can be paused, resumed, updated, or deleted.";
}

async function listActiveAutomationsForCurrentUser(): Promise<AutomationSummary[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData?.session?.access_token;
  if (!jwt) return [];
  const res = await fetch("/api/automations?limit=100", { headers: { Authorization: `Bearer ${jwt}` } });
  if (!res.ok) return [];
  const json = await res.json().catch(() => ({}));
  return Array.isArray(json.automations) ? json.automations as AutomationSummary[] : [];
}

async function patchAutomationForCurrentUser(automation: AutomationSummary, patch: Record<string, unknown>): Promise<AutomationSummary> {
  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData?.session?.access_token;
  if (!jwt) throw new Error("Not signed in.");
  const res = await fetch("/api/automations", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ id: automation.id, ...patch }),
  });
  if (!res.ok) throw new Error("Could not update automation.");
  const json = await res.json().catch(() => ({}));
  if (!json?.automation?.id) throw new Error("Automation update was not confirmed.");
  return json.automation as AutomationSummary;
}

async function deleteAutomationForCurrentUser(automation: AutomationSummary): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData?.session?.access_token;
  if (!jwt) throw new Error("Not signed in.");
  const res = await fetch(`/api/automations?id=${encodeURIComponent(automation.id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error("Could not delete automation.");
}

function taskToItem(kind: "needs_you" | "waiting" | "reminder") {
  return (task: Task): CarsonUpdateItem => ({
    kind,
    id: task.id,
    title: task.description,
    detail: task.assigned_to ? `${task.description} (${task.assigned_to})` : task.description,
    status: task.status,
    dueAt: task.due_at,
    assignee: task.assigned_to,
    createdAt: task.created_at,
    source: task,
  });
}

function todoToItem(todo: CarsonTodo): CarsonUpdateItem {
  return {
    kind: "todo",
    id: todo.id,
    title: todo.title,
    detail: todo.description ? `${todo.title}: ${todo.description}` : todo.title,
    status: todo.status,
    createdAt: todo.created_at,
    source: todo,
  };
}

function noteToItem(note: CarsonNote): CarsonUpdateItem {
  return {
    kind: "note",
    id: note.id,
    title: note.note,
    detail: note.note,
    createdAt: note.created_at,
    source: note,
  };
}

function automationToItem(automation: AutomationSummary): CarsonUpdateItem {
  return {
    kind: "automation",
    id: automation.id,
    title: automation.title,
    detail: automation.instruction,
    status: automation.status,
    dueAt: automation.next_run_at,
    createdAt: automation.created_at,
    source: automation,
  };
}

function buildProactiveCandidate(item: CarsonUpdateItem, now: Date): CarsonProactiveUpdatePrompt | null {
  const itemKey = getCarsonUpdateItemKey(item);
  const title = truncate(item.title);

  if (item.kind === "needs_you") {
    const source = item.source as Task;
    const reminderOverdue = source.type === "reminder" && isReminderOverdue(item.dueAt ?? null, now);
    if (reminderOverdue) {
      return {
        item,
        itemKey,
        priority: 20,
        actions: ["mark done", "reschedule", "snooze", "delete"],
        prompt: `This reminder is overdue: ${title}. Should I mark it done, move it, remind you later, or delete it?`,
      };
    }
    return {
      item,
      itemKey,
      priority: 10,
      actions: actionsForNeedsYou(source),
      prompt: `This item needs your decision: ${title}. ${questionForNeedsYou(source)}`,
    };
  }

  if (item.kind === "reminder") {
    const overdue = isReminderOverdue(item.dueAt ?? null, now);
    return {
      item,
      itemKey,
      priority: overdue ? 20 : 60,
      actions: ["mark done", "reschedule", "snooze", "delete"],
      prompt: overdue
        ? `This reminder is overdue: ${title}. Should I mark it done, move it, remind you later, or delete it?`
        : `This reminder is coming up: ${title}. Should I mark it done, move it, remind you later, or delete it?`,
    };
  }

  if (item.kind === "waiting") {
    return {
      item,
      itemKey,
      priority: isBlockedOrOverdueWaiting(item, now) ? 40 : 45,
      actions: ["follow up", "keep waiting", "cancel"],
      prompt: `${waitingSubject(item)} has not replied yet. Should I follow up, keep waiting, or cancel it?`,
    };
  }

  if (item.kind === "todo") {
    return {
      item,
      itemKey,
      priority: item.dueAt ? 50 : 55,
      actions: ["complete", "reschedule", "delete"],
      prompt: `This To-do is still open: ${title}. Do you want to complete it, reschedule it, or delete it?`,
    };
  }

  if (item.kind === "note") {
    return {
      item,
      itemKey,
      priority: 70,
      actions: ["turn into To-do", "turn into reminder", "leave as note", "delete"],
      prompt: `You have a note about ${title}. Do you want me to turn it into a To-do, set a reminder, leave it as a note, or delete it?`,
    };
  }

  return {
    item,
    itemKey,
    priority: item.status === "paused" ? 80 : 75,
    actions: item.status === "paused" ? ["keep", "resume", "update", "delete"] : ["keep", "pause", "update", "delete"],
    prompt: `This automation is still ${item.status === "paused" ? "paused" : "active"}: ${title}. Do you want to keep it, ${item.status === "paused" ? "resume" : "pause"} it, change it, or delete it?`,
  };
}

function actionsForNeedsYou(task: Task): CarsonProactiveDecision[] {
  if (task.quality_review_status === "substitute_review") {
    return ["update", "delete"];
  }
  if (task.status === "cancelled") {
    return ["delete", "update"];
  }
  return ["complete", "update", "delete"];
}

function questionForNeedsYou(task: Task): string {
  if (task.quality_review_status === "substitute_review") {
    return "Do you want to give a different instruction or delete it?";
  }
  if (task.status === "cancelled") {
    return "Do you want to delete it or give a different instruction?";
  }
  return "Do you want to complete it, update it, or delete it?";
}

function isBlockedOrOverdueWaiting(item: CarsonUpdateItem, now: Date): boolean {
  const task = item.source as Task;
  if (task.needs_follow_up || task.escalated_at) return true;
  if (!item.dueAt) return false;
  const due = new Date(item.dueAt);
  return !Number.isNaN(due.getTime()) && due.getTime() < now.getTime();
}

function waitingSubject(item: CarsonUpdateItem): string {
  const assignee = item.assignee?.trim();
  if (assignee) return assignee;
  return `The waiting item "${truncate(item.title)}"`;
}

function getUpdateDateValue(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function itemsForKind(snapshot: CarsonUpdatesSnapshot, kind: CarsonUpdateKind): CarsonUpdateItem[] {
  if (kind === "needs_you") return snapshot.needsYou;
  if (kind === "waiting") return snapshot.waiting;
  if (kind === "todo") return snapshot.todos;
  if (kind === "note") return snapshot.notes;
  if (kind === "reminder") return snapshot.reminders;
  return snapshot.automations;
}

function itemsForKindOrTask(snapshot: CarsonUpdatesSnapshot, kind: CarsonUpdateKind | "task"): CarsonUpdateItem[] {
  if (kind === "task") return [...snapshot.needsYou, ...snapshot.waiting, ...snapshot.reminders];
  return itemsForKind(snapshot, kind);
}

function allItems(snapshot: CarsonUpdatesSnapshot): CarsonUpdateItem[] {
  return [
    ...snapshot.needsYou,
    ...snapshot.waiting,
    ...snapshot.todos,
    ...snapshot.notes,
    ...snapshot.reminders,
    ...snapshot.automations,
  ];
}

function findUpdateMatches(items: CarsonUpdateItem[], query: string): CarsonUpdateItem[] {
  const noteMatches = findNoteMatches(
    items.filter((item) => item.kind === "note").map((item) => item.source as CarsonNote),
    query,
  );
  const todoMatches = findTodoMatches(
    items.filter((item) => item.kind === "todo").map((item) => item.source as CarsonTodo),
    query,
  );
  const preferredIds = new Set([...noteMatches, ...todoMatches].map((item) => item.id));
  const qTokens = tokenize(cleanQuery(query));
  const scored = items
    .map((item) => {
      if (preferredIds.has(item.id)) return { item, score: 100 };
      const haystack = `${item.title} ${item.detail} ${item.assignee ?? ""} ${item.kind}`;
      const haystackTokens = new Set(tokenize(haystack));
      let score = 0;
      for (const token of qTokens) if (haystackTokens.has(token)) score += 1;
      if (haystack.toLowerCase().includes(query.toLowerCase().trim())) score += 20;
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.item.createdAt ?? "") - Date.parse(a.item.createdAt ?? ""));
  if (scored.length <= 1) return scored.map((entry) => entry.item);
  const best = scored[0].score;
  return scored.filter((entry) => entry.score === best).map((entry) => entry.item);
}

function resolveDueAt(input: { time_text?: string | null; due_at?: string | null }): string | null {
  const phrase = input.time_text?.trim();
  if (phrase) {
    const parsed = parseVoiceTime(phrase);
    return parsed.error ? null : parsed.dueAt;
  }
  if (!input.due_at) return null;
  const d = new Date(input.due_at);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = d.toDateString() === new Date().toDateString();
  const tomorrow = d.toDateString() === new Date(Date.now() + 86_400_000).toDateString();
  const day = today ? "today" : tomorrow ? "tomorrow" : d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  return `${day} at ${time}`;
}

function labelForKind(kind: CarsonUpdateKind): string {
  if (kind === "needs_you") return "Needs You";
  if (kind === "todo") return "To-do";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function uniqueById<T extends { id: string }>(item: T, index: number, arr: T[]): boolean {
  return arr.findIndex((candidate) => candidate.id === item.id) === index;
}

function cleanQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\b(?:please|carson|the|a|an|my|me|this|that|it|item|task|note|todo|to\s*do|reminder|automation)\b/g, " ")
    .replace(/\b(?:mark|close|complete|finish|done|delete|cancel|remove|pause|resume|update|change|turn|convert|into)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((token) => token.length > 1);
}

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 45 ? `${trimmed.slice(0, 45)}...` : trimmed;
}

function inferKind(lower: string): CarsonUpdateKind | "task" | undefined {
  if (/\bneeds?\s+(?:you|me|attention)|attention\b/.test(lower)) return "needs_you";
  if (/\bwaiting|wait(?:ing)?\s+on\b/.test(lower)) return "waiting";
  if (/\bto[-\s]?do|todo\b/.test(lower)) return "todo";
  if (/\bnotes?\b/.test(lower)) return "note";
  if (/\breminders?\b/.test(lower)) return "reminder";
  if (/\bautomations?|routines?\b/.test(lower)) return "automation";
  if (/\b(?:task|item)\b/.test(lower)) return "task";
  return undefined;
}

function inferAction(lower: string): CarsonUpdateAction | null {
  if (/\bturn\b[\s\S]{0,50}\bnote\b[\s\S]{0,50}\bto[-\s]?do\b|\bconvert\b[\s\S]{0,50}\bto[-\s]?do\b/.test(lower)) return "convert_to_todo";
  if (/\bturn\b[\s\S]{0,50}\bnote\b[\s\S]{0,50}\breminder\b|\bconvert\b[\s\S]{0,50}\breminder\b|\bremind\s+me\b/.test(lower)) return "convert_to_reminder";
  if (/\bfollow\s+up\b/.test(lower)) return "follow_up";
  if (/\bkeep\s+waiting|continue\s+waiting\b/.test(lower)) return "continue_waiting";
  if (/\bpause\b/.test(lower)) return "pause";
  if (/\bresume\b|\bturn\s+back\s+on\b/.test(lower)) return "resume";
  if (/\b(?:snooze|move|reschedule|change\s+the\s+reminder)\b/.test(lower)) return "reschedule";
  if (/\b(?:delete|remove|cancel|clear)\b/.test(lower)) return inferKind(lower) === "waiting" ? "cancel_waiting" : "delete";
  if (/\b(?:mark|complete|finish|done|handled|resolved|close)\b/.test(lower)) return "complete";
  if (/\b(?:update|change|edit|rename)\b/.test(lower)) return "update";
  return null;
}

function extractTimePhrase(raw: string): string | undefined {
  const match = raw.match(/\b(?:tomorrow|today|tonight|next\s+\w+|on\s+\w+|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|in\s+\d+\s+\w+|until\s+\w+|by\s+\w+)[\s\S]*$/i);
  return match?.[0]?.replace(/^until\s+/i, "").replace(/^by\s+/i, "").trim();
}

function extractUpdateText(raw: string): string | undefined {
  const match = raw.match(/\b(?:to|as|say|saying)\s+["“]?([^"”]+)["”]?$/i);
  return match?.[1]?.trim();
}
