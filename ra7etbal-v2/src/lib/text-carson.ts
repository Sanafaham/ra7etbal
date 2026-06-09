import type { Person } from "../types/person";
import type { Task } from "../types/task";
import { loadUserMemory } from "./carson-facts";
import { loadRecentMemory } from "./carson-memory";
import { listTasks } from "./tasks";
import { saveInboxItem } from "./inbox";
import { formatReminderDue } from "./reminder-time";
import { extractItems } from "./ai/extract";
import { savePending } from "./save";
import { sendWhatsAppTask } from "./whatsapp";
import { useTasksStore } from "../stores/tasks";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 500;

export interface TextCarsonContext {
  displayName?: string | null;
  userEmail?: string | null;
  /** Supabase user ID — required for inbox saves. */
  userId?: string | null;
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

  // ── Capture inbox detection ───────────────────────────────────────────────
  // Phrases like "Don't let me forget X" or "Idea: X" are saved directly to
  // inbox_items without going to the AI. Returns a short acknowledgment.
  const captureContent = extractCaptureContent(question);
  if (captureContent && context.userId) {
    try {
      await saveInboxItem({
        user_id: context.userId,
        content: captureContent,
        source: "text_carson",
      });
      return `Got it — saved to your inbox. I'll keep that for you.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[text-carson] inbox save failed:", msg);
      throw new Error(`Couldn't save to inbox: ${msg}`);
    }
  }

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

What you can do in this panel:
- Answer any question about the user's current state, priorities, and open tasks.
- Create reminders for the user ("remind me to…", "set a reminder…").
- Delegate tasks to people and send WhatsApp messages on the user's behalf.
- Save a captured thought to the inbox ("Don't let me forget...", "Idea:", "Thought:").

IMPORTANT — execution happens automatically client-side before your response:
- When the user types a reminder or delegation, it is already being executed before you reply.
- Your role is to confirm what was done, not to refuse or redirect.
- Never tell the user to "use Clear My Head" for reminders or delegations — those are handled here.
- Never say you cannot create reminders or delegate tasks from this panel. You can, and it is already done.
- If execution succeeded, confirm it calmly. If it failed, the user will see the real error message separately.

Ra7etBal capabilities (these exist and work — never deny them):
- Reminders: users can create reminders, schedule them, and receive push notifications when they are due.
- Task delegation: users can delegate tasks to people via WhatsApp with confirmation links.
- Escalation: overdue delegations automatically escalate with owner push notifications.
- WhatsApp messaging: task assignments and follow-ups are sent via WhatsApp.
- People memory: Carson remembers each person's personality and communication style.
- Carson memory: Carson remembers facts and preferences across sessions.
- Morning Brief: Carson delivers a daily Chief-of-Staff briefing covering attention items, waiting tasks, overdue items, recent completions, and risks.

Completed tasks — hard rule:
NEVER mention completed tasks in response to any operational, status, or future-facing question.
This applies to all question types including:
- "What needs attention?" / "What's my status?"
- "What should I pay attention to tomorrow?" / "What does tomorrow look like?"
- "Am I clear tomorrow?" / "What needs attention next week?"
- "What can you do for me today?" / "What's going on?"
If the answer to such a question is that nothing is open, stop there. Do not add completed tasks as context, color, or reassurance.
WRONG: "You're clear tomorrow. Grace has your luggage ready and dinner handled from today."
RIGHT: "You're clear tomorrow. No open tasks, overdue items, or bottlenecks."
Only surface completed tasks when the user explicitly asks: "What was completed?", "What did Grace do?", "Show me recent completions", or similar history-specific questions.

When answering operational questions ("what needs attention", "what can you do for me", "what's going on", "what's my status", any future-facing planning question):
- Base your answer ONLY on tasks in the OPEN section of the task snapshot below.
- If OPEN is empty, say clearly: "You're clear right now. No pending confirmations, overdue reminders, or active bottlenecks." Then stop.
- For future-facing questions with no relevant open items, say: "You're clear [tomorrow/this week/etc.]. No open tasks, overdue items, or bottlenecks." Then stop.

You can:
- Answer questions about the user's current Ra7etBal state.
- Accurately describe what Ra7etBal supports and how it works.
- Summarize what needs attention, what is waiting, what is handled, and what can wait.
- Prioritize and suggest the next best step.

You must not:
- Tell the user to use Clear My Head for reminders or delegations. This panel handles them directly.
- Refuse a reminder or delegation request. Execution already happened client-side before you replied.
- Tell the user that something is handled unless the context or execution result already confirms it.
- Claim Ra7etBal cannot do something it already supports.
- Respond to a delegation or message request as if you executed it. You did not. You cannot. Always redirect to Clear My Head.

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
  const unarchived = tasks.filter((task) => task.archived_at == null);

  const open = unarchived.filter((task) => task.status !== "done");
  const done = unarchived
    .filter((task) => task.status === "done")
    .sort(
      (a, b) =>
        new Date(b.confirmed_at ?? b.created_at).getTime() -
        new Date(a.confirmed_at ?? a.created_at).getTime(),
    )
    .slice(0, 5); // only the 5 most recent completions for context

  const lines: string[] = [];

  const now = new Date();

  if (open.length === 0) {
    lines.push("OPEN: none");
  } else {
    lines.push("OPEN:");
    for (const task of open.slice(0, 15)) {
      const assigned = task.assigned_to ? `, assigned to ${task.assigned_to}` : "";
      // Use the same locale-aware formatter as Actions/TaskCard so times match
      // what the user sees in the UI (browser local time, not UTC).
      const dueLabel = task.due_at ? formatReminderDue(task.due_at, now) : null;
      const due = dueLabel ? `, due ${dueLabel}` : "";
      lines.push(`- ${task.type}, ${task.status}${assigned}${due}: ${task.description.trim()}`);
    }
  }

  if (done.length > 0) {
    lines.push("COMPLETED (recent, treat as history only):");
    for (const task of done) {
      const assigned = task.assigned_to ? `, by ${task.assigned_to}` : "";
      const when = task.confirmed_at
        ? `, confirmed ${new Date(task.confirmed_at).toLocaleString()}`
        : "";
      lines.push(`- ${task.description.trim()}${assigned}${when}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Delegation execution
// ---------------------------------------------------------------------------

/**
 * Extracts ALL actionable items from `input`, saves them via the canonical
 * savePending path, then sends WhatsApp for delegation/message items only —
 * the same pipeline as Review.tsx. Returns a short honest summary.
 *
 * Reminders, actions, and other non-delegation items are saved even when the
 * input also contains a delegation (multi-item inputs are fully handled).
 */
export async function executeDelegationFromText(
  input: string,
  context: TextCarsonContext,
): Promise<string> {
  if (!context.userId) throw new Error("Not signed in.");

  const result = await extractItems(input, context.people, context.displayName ?? undefined);

  const allItems = result.extracted;
  if (allItems.length === 0) {
    throw new Error("Couldn't understand that. Try rephrasing.");
  }

  // Save every extracted item (reminders, delegations, actions, follow-ups…)
  const saved = await savePending(
    allItems,
    context.userId,
    context.displayName ?? null,
    context.people,
  );

  const phoneByName = new Map<string, string>();
  for (const person of context.people) {
    const key = person.name.trim().toLowerCase();
    if (key && person.phone) phoneByName.set(key, person.phone);
  }

  // Send WhatsApp only for delegation/message rows (same as Review.tsx)
  const sendableMessages = saved.messages.filter(
    (m) => !!m.recipient.trim() && !!m.content.trim(),
  );

  if (sendableMessages.length > 0) {
    await Promise.all(
      sendableMessages.map((message) =>
        sendWhatsAppTask({
          to: phoneByName.get(message.recipient.trim().toLowerCase()) ?? null,
          messageText: message.content,
          confirmationLink: message.confirmation_url ?? null,
          messageRecordId: message.id,
          taskId: message.task_id,
          recipientName: message.recipient,
          ownerName: context.displayName ?? null,
          imagePath: null,
        }),
      ),
    );
  }

  // Fire-and-forget store refresh so task list updates immediately.
  useTasksStore.getState().loadFor(context.userId, { force: true }).catch(() => {});

  // Build a summary that reflects every item that was saved.
  const reminderCount = saved.tasks.filter((t) => t.type === "reminder").length;
  const sentNames = sendableMessages.map((m) => m.recipient);
  const unsentDelegations = saved.tasks.filter(
    (t) =>
      (t.type === "delegation" || t.type === "followup") &&
      !sentNames.includes(t.assigned_to ?? ""),
  );

  const parts: string[] = [];

  if (sentNames.length > 0) {
    const names = sentNames.join(", ");
    parts.push(`${names} ${sentNames.length === 1 ? "has been" : "have been"} messaged via WhatsApp`);
  }
  if (unsentDelegations.length > 0) {
    const names = unsentDelegations
      .filter((t) => t.assigned_to)
      .map((t) => t.assigned_to)
      .join(", ");
    parts.push(
      names
        ? `task created for ${names} (no phone on file — not messaged)`
        : "task created",
    );
  }
  if (reminderCount > 0) {
    parts.push(reminderCount === 1 ? "reminder set" : `${reminderCount} reminders set`);
  }
  // Catch-all for action/decision/parked items not covered above
  const otherCount =
    saved.tasks.length - (sentNames.length + unsentDelegations.length + reminderCount);
  if (otherCount > 0) {
    parts.push(otherCount === 1 ? "1 item saved" : `${otherCount} items saved`);
  }

  if (parts.length === 0) return "Saved.";

  // Capitalise first word and end with a period.
  const summary = parts.join(", ");
  return summary.charAt(0).toUpperCase() + summary.slice(1) + ".";
}

// ---------------------------------------------------------------------------
// Capture inbox helpers
// ---------------------------------------------------------------------------

/**
 * Capture triggers — phrases that signal the user wants to store a thought
 * rather than ask a question. Returns the content to save, or null if the
 * input is not a capture phrase.
 *
 * Each entry is [prefix, stripPrefix].
 * - stripPrefix=true  → save everything after the prefix
 * - stripPrefix=false → save the full input verbatim (phrase is already
 *   self-contained, e.g. "Idea: go paperless")
 */
const CAPTURE_PATTERNS: Array<{ prefix: string; strip: boolean }> = [
  { prefix: "don't let me forget", strip: true },
  { prefix: "dont let me forget", strip: true },
  { prefix: "do not let me forget", strip: true },
  { prefix: "remember this:", strip: true },
  { prefix: "remember this -", strip: true },
  { prefix: "remember this", strip: true },
  { prefix: "idea:", strip: true },
  { prefix: "idea -", strip: true },
  { prefix: "thought:", strip: true },
  { prefix: "thought -", strip: true },
];

export function extractCaptureContent(input: string): string | null {
  // Normalize curly/smart apostrophes → straight apostrophe so iOS/macOS
  // autocorrect ("Don't") matches patterns written with straight apostrophes.
  const normalized = input.replace(/[‘’‚‛]/g, "'");
  const lower = normalized.toLowerCase();
  for (const { prefix, strip } of CAPTURE_PATTERNS) {
    if (lower.startsWith(prefix)) {
      if (!strip) return input.trim();
      const rest = normalized.slice(prefix.length).replace(/^[\s:,\-]+/, "").trim();
      return rest.length > 0 ? rest : input.trim();
    }
  }
  return null;
}
