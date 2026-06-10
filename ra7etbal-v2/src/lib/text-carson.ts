import type { Person } from "../types/person";
import type { Task } from "../types/task";
import { loadUserMemory, upsertUserFacts } from "./carson-facts";
import { loadRecentMemory, saveSessionMemory } from "./carson-memory";
import { listTasks } from "./tasks";
import { saveInboxItem } from "./inbox";
import { buildCarsonContext } from "./carson-context";
import { CARSON_STATUS_POLICY } from "./carson-status-policy";
import { extractItems } from "./ai/extract";
import { savePending } from "./save";
import { sendWhatsAppTask } from "./whatsapp";
import { useTasksStore } from "../stores/tasks";
import { summarizeConversation } from "./carson-summarize";
import { extractDurableFacts } from "./carson-fact-extract";
import { updatePeopleInsightsFromTasks } from "./people-behavior";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 500;

export interface TextCarsonContext {
  displayName?: string | null;
  userEmail?: string | null;
  /** Supabase user ID — required for inbox saves. */
  userId?: string | null;
  /** Spoken prose brief (used as Daily Brief section in the prompt). */
  dailyBrief: string;
  people: Person[];
  tasks: Task[];
  /**
   * Optional image to attach to the first delegation item.
   * V1: one image per instruction, applied to the first delegation/message only.
   * Carson does not analyse the image — attach-and-send only.
   */
  imageFile?: File | null;
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
    now: new Date(),
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
  context: TextCarsonContext & { userMemory: string; recentMemory: string; now: Date },
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

${CARSON_STATUS_POLICY}

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

Current state (people, open tasks, recent completions):
${buildCarsonContext({
  tasks: context.tasks,
  people: context.people,
  email: context.userEmail,
  now: context.now,
})}

User asks:
${question}

Answer as a trusted chief of staff who already knows the situation. Lead with the most important thing. Include times when known. Keep it under 5 sentences.`;
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

  // If the user attached an image, assign it to the first delegation/message
  // item only. V1: one image per instruction. Carson never analyses the image.
  const imageFiles = new Map<string, File>();
  if (context.imageFile) {
    const firstDelegation = allItems.find(
      (i) => i.type === "delegation" || i.type === "message",
    );
    if (firstDelegation) imageFiles.set(firstDelegation.id, context.imageFile);
  }

  // Save every extracted item (reminders, delegations, actions, follow-ups…)
  const saved = await savePending(
    allItems,
    context.userId,
    context.displayName ?? null,
    context.people,
    imageFiles.size > 0 ? imageFiles : undefined,
  );

  const phoneByName = new Map<string, string>();
  for (const person of context.people) {
    const key = person.name.trim().toLowerCase();
    if (key && person.phone) phoneByName.set(key, person.phone);
  }

  // Send WhatsApp only for delegation/message rows (same as Review.tsx).
  // Use allSettled so a failed send for one recipient does not abort the
  // others — all sends are attempted independently. The summary below
  // accurately reflects which recipients were actually messaged vs which
  // failed, so Voice Carson cannot claim success for an unsent message.
  const sendableMessages = saved.messages.filter(
    (m) => !!m.recipient.trim() && !!m.content.trim(),
  );

  const sendResults =
    sendableMessages.length > 0
      ? await Promise.allSettled(
          sendableMessages.map((message) =>
            sendWhatsAppTask({
              to: phoneByName.get(message.recipient.trim().toLowerCase()) ?? null,
              messageText: message.content,
              confirmationLink: message.confirmation_url ?? null,
              messageRecordId: message.id,
              taskId: message.task_id,
              recipientName: message.recipient,
              ownerName: context.displayName ?? null,
              // Pass imagePath from the upload result so ra7etbal_task_image
              // fires automatically when the task had an attached image.
              imagePath: message.task_id
                ? (saved.imagePathsByTaskId.get(message.task_id) ?? null)
                : null,
            }),
          ),
        )
      : [];

  // Split into succeeded vs failed sends for honest summary reporting.
  const sentNames: string[] = [];
  const failedSends: Array<{ recipient: string; reason: string }> = [];
  for (let i = 0; i < sendableMessages.length; i++) {
    const result = sendResults[i];
    if (result.status === "fulfilled") {
      sentNames.push(sendableMessages[i].recipient);
    } else {
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : "send failed";
      failedSends.push({ recipient: sendableMessages[i].recipient, reason });
      console.error(
        `[executeDelegationFromText] WhatsApp send failed for ${sendableMessages[i].recipient}:`,
        result.reason,
      );
    }
  }

  // Fire-and-forget store refresh so task list updates immediately.
  useTasksStore.getState().loadFor(context.userId, { force: true }).catch(() => {});

  // Build a summary that reflects every item that was saved.
  const reminderCount = saved.tasks.filter((t) => t.type === "reminder").length;
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
  // Explicit failure report so Voice Carson must acknowledge send failures
  // rather than silently claiming success for all recipients.
  if (failedSends.length > 0) {
    for (const { recipient, reason } of failedSends) {
      parts.push(`${recipient} was NOT messaged — ${reason}`);
    }
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
    saved.tasks.length -
    (sentNames.length + failedSends.length + unsentDelegations.length + reminderCount);
  if (otherCount > 0) {
    parts.push(otherCount === 1 ? "1 item saved" : `${otherCount} items saved`);
  }

  if (parts.length === 0) return "Saved.";

  // ── Fire-and-forget memory writes ────────────────────────────────────────
  // Mirror what Voice Carson does post-session: summarise the user's instruction
  // and extract any durable facts (preferences, people notes, routines).
  // Best-effort only — never blocks the UI response.
  const memoryTranscript = [{ role: "user" as const, message: input }];
  summarizeConversation(memoryTranscript)
    .then((sessionSummary) => { if (sessionSummary) return saveSessionMemory(sessionSummary); })
    .catch(() => {});
  extractDurableFacts(memoryTranscript)
    .then((facts) => { if (facts.length > 0) return upsertUserFacts(context.userId!, facts); })
    .catch(() => {});
  // Behavioral insight: update people.notes for anyone mentioned in the input
  // based on their observed task-completion history. Requires ≥3 completed tasks.
  updatePeopleInsightsFromTasks(input, context.people, context.tasks).catch(() => {});

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
