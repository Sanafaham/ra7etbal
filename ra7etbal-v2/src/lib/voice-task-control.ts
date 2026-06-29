import type { Task } from "../types/task";

export type VoiceTaskControlAction = "mark_done" | "delete";

export interface VoiceTaskContext {
  id: string;
  description: string;
  assigned_to: string | null;
  type: Task["type"];
}

export interface VoiceTaskControlIntent {
  action: VoiceTaskControlAction;
  query: string;
  usesCurrentReference: boolean;
}

export type VoiceTaskControlResolution =
  | { status: "not_task_control" }
  | { status: "needs_context"; intent: VoiceTaskControlIntent }
  | { status: "not_found"; intent: VoiceTaskControlIntent }
  | { status: "ambiguous"; intent: VoiceTaskControlIntent; matches: Task[] }
  | { status: "matched"; intent: VoiceTaskControlIntent; task: Task };

export interface ExecuteVoiceTaskControlInput {
  rawText: string;
  tasks: Task[];
  currentTask?: VoiceTaskContext | null;
  taskId?: string | null;
  action?: string | null;
  markDoneTask: (task: Task) => Promise<Task>;
  deleteTask: (task: Task) => Promise<void>;
}

export interface ExecuteVoiceTaskControlResult {
  handled: boolean;
  reply: string;
  action?: VoiceTaskControlAction;
  task?: Task;
}

const CURRENT_REFERENCE_PATTERN = /\b(?:this|that|it|yes)\b/i;
const CALENDAR_ESCAPE_PATTERN = /\b(?:calendar|event|appointment|meeting)\b/i;

const DELETE_PATTERN =
  /\b(?:delete|cancel|remove|dismiss|clear)\b/i;

const MARK_DONE_PATTERN =
  /\b(?:mark|close|complete|finish|done|completed|finished|handled|resolved)\b/i;

const WAITING_CLOSE_PATTERN =
  /\b(?:remove|clear|close|mark|resolve)\b[\s\S]{0,80}\b(?:waiting|wait(?:ing)?\s+on)\b|\b(?:waiting|wait(?:ing)?\s+on)\b[\s\S]{0,80}\b(?:handled|resolved|done|complete|closed)\b/i;

export function resolveVoiceTaskControl(
  rawText: string,
  tasks: Task[],
  currentTask: VoiceTaskContext | null = null,
): VoiceTaskControlResolution {
  const intent = parseVoiceTaskControlIntent(rawText);
  if (!intent) return { status: "not_task_control" };

  const activeTasks = tasks.filter(
    (task) => task.archived_at == null && task.status === "pending",
  );

  if (intent.usesCurrentReference && !intent.query) {
    if (!currentTask) return { status: "needs_context", intent };
    const match = activeTasks.find((task) => task.id === currentTask.id);
    if (!match) return { status: "not_found", intent };
    return { status: "matched", intent, task: match };
  }

  const matches = findTaskMatches(activeTasks, intent);
  if (matches.length === 0) return { status: "not_found", intent };
  if (matches.length > 1) return { status: "ambiguous", intent, matches };
  return { status: "matched", intent, task: matches[0] };
}

export async function executeVoiceTaskControl({
  rawText,
  tasks,
  currentTask = null,
  taskId = null,
  action = null,
  markDoneTask,
  deleteTask,
}: ExecuteVoiceTaskControlInput): Promise<ExecuteVoiceTaskControlResult> {
  const activeTasks = tasks.filter(
    (task) => task.archived_at == null && task.status === "pending",
  );
  const normalizedAction = normalizeAction(action);
  const instruction =
    rawText.trim() ||
    (normalizedAction === "delete" ? "delete this task" : normalizedAction ? "mark this task done" : "");

  let resolution = resolveVoiceTaskControl(instruction, activeTasks, currentTask);

  if (taskId?.trim()) {
    const task = activeTasks.find((item) => item.id === taskId.trim());
    if (!task) {
      return { handled: true, reply: "I couldn't find that open task. It may already be handled." };
    }
    resolution = {
      status: "matched",
      intent: { action: normalizedAction ?? "mark_done", query: "", usesCurrentReference: true },
      task,
    };
  }

  if (resolution.status === "not_task_control") {
    return { handled: false, reply: "" };
  }
  if (resolution.status === "needs_context") {
    return { handled: true, reply: "Which task do you mean?" };
  }
  if (resolution.status === "not_found") {
    return { handled: true, reply: "I couldn't find an open task matching that. Which one do you mean?" };
  }
  if (resolution.status === "ambiguous") {
    const names = resolution.matches
      .slice(0, 4)
      .map((task) => task.description.trim())
      .filter(Boolean)
      .map((desc) => `"${desc.slice(0, 45)}${desc.length > 45 ? "..." : ""}"`)
      .join(", ");
    return {
      handled: true,
      reply: `I found more than one matching task: ${names}. Which one should I update?`,
    };
  }

  const task = resolution.task;
  const taskLabel = task.type === "reminder" ? "reminder" : "task";

  if (resolution.intent.action === "delete") {
    await deleteTask(task);
    return {
      handled: true,
      action: "delete",
      task,
      reply: `Done. I deleted that ${taskLabel}.`,
    };
  }

  const updated = await markDoneTask(task);
  return {
    handled: true,
    action: "mark_done",
    task: updated,
    reply: `Done. I marked that ${taskLabel} done.`,
  };
}

function normalizeAction(action?: string | null): VoiceTaskControlAction | null {
  if (!action) return null;
  if (/delete|cancel|remove|dismiss|clear/i.test(action)) return "delete";
  if (/mark|done|complete|close|finish/i.test(action)) return "mark_done";
  return null;
}

export function parseVoiceTaskControlIntent(rawText: string): VoiceTaskControlIntent | null {
  const text = rawText.trim();
  if (!text) return null;
  if (CALENDAR_ESCAPE_PATTERN.test(text)) return null;

  const lower = text.toLowerCase();
  const action: VoiceTaskControlAction | null = /^\s*yes[.!]?\s*$/i.test(text)
    ? "mark_done"
    : WAITING_CLOSE_PATTERN.test(text)
    ? "mark_done"
    : DELETE_PATTERN.test(text)
    ? "delete"
    : MARK_DONE_PATTERN.test(text)
      ? "mark_done"
      : null;
  if (!action) return null;

  const taskish =
    /\b(?:task|reminder|delegation|item|alarm|to[-\s]?do)\b/i.test(text) ||
    /\b(?:waiting|mark|close|complete|finish|done|completed|finished|handled|resolved|delete|cancel|remove|dismiss|clear|yes)\b/i.test(text);
  if (!taskish) return null;

  const usesCurrentReference = CURRENT_REFERENCE_PATTERN.test(text);
  const query = cleanTaskControlQuery(lower, action, usesCurrentReference);
  return { action, query, usesCurrentReference };
}

function findTaskMatches(tasks: Task[], intent: VoiceTaskControlIntent): Task[] {
  const queryTokens = tokenize(intent.query);
  if (queryTokens.length === 0) return [];

  const wantsReminder = /\b(?:reminder|alarm)\b/i.test(intent.query);
  const personTokens = new Set<string>();
  const contentTokens = new Set(queryTokens);

  for (const task of tasks) {
    const assignee = task.assigned_to?.trim();
    if (!assignee) continue;
    for (const token of tokenize(assignee)) {
      if (contentTokens.has(token)) personTokens.add(token);
    }
  }

  for (const token of personTokens) contentTokens.delete(token);

  const scored = tasks
    .map((task) => {
      if (wantsReminder && task.type !== "reminder") return { task, score: 0 };

      const haystackTokens = new Set(
        tokenize(`${task.assigned_to ?? ""} ${task.description} ${task.type}`),
      );
      const personMatched =
        personTokens.size === 0 || [...personTokens].some((token) => haystackTokens.has(token));
      if (!personMatched) return { task, score: 0 };

      let score = personTokens.size > 0 ? 3 : 0;
      for (const token of contentTokens) {
        if (haystackTokens.has(token)) score += 1;
      }

      if (contentTokens.size > 0 && score === (personTokens.size > 0 ? 3 : 0)) {
        return { task, score: 0 };
      }

      return { task, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.task.created_at) - Date.parse(a.task.created_at));

  if (scored.length <= 1) return scored.map((item) => item.task);

  const bestScore = scored[0].score;
  return scored.filter((item) => item.score === bestScore).map((item) => item.task);
}

function cleanTaskControlQuery(
  lowerText: string,
  action: VoiceTaskControlAction,
  usesCurrentReference: boolean,
): string {
  let query = lowerText
    .replace(/[’']s\b/g, "")
    .replace(/[’']/g, "")
    .replace(/\b(?:please|can you|could you|carson)\b/g, " ")
    .replace(/\b(?:the|a|an|my|me|for|from|in|on|as|is|are|was|were|owner|side)\b/g, " ")
    .replace(/\b(?:task|reminder|delegation|item|open\s+loop|loop|waiting|wait(?:ing)?\s+on|to\s*do|todo)\b/g, " ");

  if (action === "mark_done") {
    query = query.replace(/\b(?:mark|close|complete|finish|done|completed|finished|handled|resolved|remove|clear)\b/g, " ");
  } else {
    query = query.replace(/\b(?:delete|cancel|remove|dismiss|clear)\b/g, " ");
  }

  if (usesCurrentReference) {
    query = query.replace(/\b(?:this|that|it|yes)\b/g, " ");
  }

  return query.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  const baseTokens = value
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter(
      (token) =>
        !new Set([
          "the",
          "and",
          "for",
          "with",
          "task",
          "reminder",
          "delegation",
          "item",
          "todo",
          "to",
          "me",
          "my",
        ]).has(token),
    );
  return Array.from(
    new Set(
      baseTokens.flatMap((token) =>
        token.endsWith("s") && token.length > 3 ? [token, token.slice(0, -1)] : [token],
      ),
    ),
  );
}
