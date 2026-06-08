import type { Person } from "../types/person";
import type { Task } from "../types/task";
import { loadUserMemory } from "./carson-facts";
import { loadRecentMemory } from "./carson-memory";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 500;

export interface TextCarsonContext {
  displayName?: string | null;
  userEmail?: string | null;
  briefStateText: string;
  dailyBrief: string;
  people: Person[];
  tasks: Task[];
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

export async function askTextCarson(
  input: string,
  context: TextCarsonContext,
): Promise<string> {
  const question = input.trim();
  if (!question) return "";

  const [userMemory, recentMemory] = await Promise.all([
    loadUserMemory(50).catch(() => ""),
    loadRecentMemory(20).catch(() => "No previous sessions."),
  ]);

  const prompt = buildTextCarsonPrompt(question, {
    ...context,
    userMemory,
    recentMemory,
  });

  let res: Response;
  try {
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    throw err instanceof TypeError
      ? new Error("Network issue. Please check your connection.")
      : err;
  }

  let body: AnthropicResponse;
  try {
    body = (await res.json()) as AnthropicResponse;
  } catch {
    throw new Error("Couldn't read Carson's response. Please try again.");
  }

  if (!res.ok || body.error) {
    throw new Error(body.error?.message || `Carson request failed (${res.status}).`);
  }

  const text = body.content?.[0]?.text?.trim();
  if (!text) throw new Error("Carson returned an empty response. Please try again.");
  return text;
}

function buildTextCarsonPrompt(
  question: string,
  context: TextCarsonContext & { userMemory: string; recentMemory: string },
): string {
  return `You are Carson, the user's calm personal Chief of Staff inside Ra7etBal.

Text Carson V1 is read-only.

You can:
- Answer questions about the user's current Ra7etBal state.
- Summarize what needs attention, what is waiting, what is handled, and what can wait.
- Prioritize and suggest the next best step.
- Draft wording or suggest what the user could put into Clear My Head.

You must not:
- Claim that you created, saved, scheduled, sent, delegated, reminded, confirmed, archived, or updated anything.
- Create tasks, save reminders, send WhatsApp messages, or modify app data.
- Tell the user that something is handled unless the context already says it is handled.

If the user asks you to create, delegate, remind, save, send, or schedule something, explain briefly that Text Carson is read-only and they should use Clear My Head to save it.

Use User memory to adapt your behavior and answer style. Do not recite it unless asked.

User:
- Name: ${context.displayName?.trim() || "Unknown"}
- Email: ${context.userEmail?.trim() || "Unknown"}

${context.userMemory || "User memory: none."}

Recent memory:
${context.recentMemory || "No previous sessions."}

Daily brief:
${context.dailyBrief || "No daily brief available."}

Current Ra7etBal state:
${context.briefStateText || "No current state available."}

People snapshot:
${formatPeople(context.people)}

Task snapshot:
${formatTasks(context.tasks)}

User asks:
${question}

Reply compactly, calmly, and directly.`;
}

function formatPeople(people: Person[]): string {
  if (people.length === 0) return "None saved.";
  return people
    .slice(0, 12)
    .map((person) => {
      const role = person.role.trim() ? ` (${person.role.trim()})` : "";
      const notes = person.notes?.trim()
        ? ` - ${person.notes.trim().replace(/\s+/g, " ").slice(0, 120)}`
        : "";
      return `- ${person.name.trim()}${role}${notes}`;
    })
    .join("\n");
}

function formatTasks(tasks: Task[]): string {
  const active = tasks.filter((task) => task.archived_at == null);
  if (active.length === 0) return "No active tasks.";

  return active
    .slice(0, 20)
    .map((task) => {
      const assigned = task.assigned_to ? `, assigned to ${task.assigned_to}` : "";
      const due = task.due_at ? `, due ${new Date(task.due_at).toISOString()}` : "";
      return `- ${task.type}, ${task.status}${assigned}${due}: ${task.description.trim()}`;
    })
    .join("\n");
}
