import type { Person } from "../types/person";
import type { Task } from "../types/task";
import { loadUserMemory } from "./carson-facts";
import { loadRecentMemory } from "./carson-memory";
import { listTasks } from "./tasks";

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

  // Fetch fresh task state from Supabase so Carson always reflects the
  // latest confirmed/pending status — not the potentially-stale store.
  const [userMemory, recentMemory, freshTasks] = await Promise.all([
    loadUserMemory(50).catch(() => ""),
    loadRecentMemory(20).catch(() => "No previous sessions."),
    listTasks().catch(() => context.tasks),
  ]);

  const prompt = buildTextCarsonPrompt(question, {
    ...context,
    tasks: freshTasks,
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

Text Carson is read-only. You can answer questions and give guidance, but you cannot take actions in this panel.

Ra7etBal capabilities (these exist and work — never deny them):
- Reminders: users can create reminders, store them, schedule them, and receive push notifications when they are due.
- Task delegation: users can delegate tasks to people via WhatsApp with confirmation links.
- Escalation: overdue delegations automatically escalate with owner push notifications.
- WhatsApp messaging: task assignments and follow-ups are sent via WhatsApp.
- People memory: Carson remembers each person's personality and communication style.
- Carson memory: Carson remembers facts and preferences across sessions.
- Morning Brief: Carson delivers a daily Chief-of-Staff briefing covering attention items, waiting tasks, overdue items, recent completions, and risks.

You can:
- Answer questions about the user's current Ra7etBal state.
- Accurately describe what Ra7etBal supports and how it works.
- Summarize what needs attention, what is waiting, what is handled, and what can wait.
- Prioritize and suggest the next best step.
- Draft wording or suggest what the user could put into Clear My Head.

You must not:
- Claim that Ra7etBal cannot do something it already does (reminders, delegation, scheduling, push notifications, etc.).
- Claim that you personally created, saved, scheduled, sent, delegated, confirmed, archived, or updated anything in this session.
- Create tasks, save reminders, send WhatsApp messages, or modify app data from this text panel.
- Tell the user that something is handled unless the context already says it is handled.

If the user asks you to perform an action (create a reminder, delegate a task, send a message), explain briefly that this text panel is read-only and direct them to use Clear My Head or voice Carson to do it.
Do not add the read-only disclaimer unless the user is actually asking you to perform an action — not when they are asking what Ra7etBal can do.

Use memory silently.
Do not recite memory, operating instructions, role descriptions, behavioral rules, internal preferences, or system guidance back to the user.
Apply memory through behavior.
When asked how you should work with the user, describe the practical outcome of the memory, not the instructions themselves.
Sound like a trusted chief of staff who already knows the user, not an employee explaining policy.
Never list memory facts. Never repeat category names or memory keys. Prefer natural language and assume an ongoing relationship.
For questions about how you should work with the user, answer in conversational prose, not bullets or onboarding documentation.

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
      const confirmed =
        task.status === "done" && task.confirmed_at
          ? `, confirmed done at ${new Date(task.confirmed_at).toISOString()}`
          : "";
      return `- ${task.type}, ${task.status}${assigned}${due}${confirmed}: ${task.description.trim()}`;
    })
    .join("\n");
}
