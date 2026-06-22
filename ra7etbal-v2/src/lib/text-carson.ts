import type { Person } from "../types/person";
import type { Task } from "../types/task";
import type { ExtractionResult } from "../types/extraction";
import { loadUserMemory, upsertUserFacts } from "./carson-facts";
import { loadRecentMemory, saveSessionMemory } from "./carson-memory";
import { listTasks } from "./tasks";
import { saveInboxItem } from "./inbox";
import { buildCarsonContext } from "./carson-context";
import { CARSON_STATUS_POLICY } from "./carson-status-policy";
import { extractItems } from "./ai/extract";
import { savePending, saveTaskAttachments } from "./save";
import { detectAllRecurringSchedules } from "./routine-detection";
import { deliverTaskMessage, type DeliveryResult } from "./delivery";
import { useTasksStore } from "../stores/tasks";
import { summarizeConversation } from "./carson-summarize";
import { extractDurableFacts } from "./carson-fact-extract";
import { updatePeopleInsightsFromTasks } from "./people-behavior";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 500;

export async function describeImageForTextCarson(file: File): Promise<string | null> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    if (arrayBuffer.byteLength === 0) return null;
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((acc, byte) => acc + String.fromCharCode(byte), ""),
    );
    const mediaType = (file.type || "image/jpeg") as
      | "image/jpeg"
      | "image/png"
      | "image/gif"
      | "image/webp";
    const payload = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 120,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            {
              type: "text",
              text: "Describe this image in one sentence, focusing on the main subject and any actionable details relevant to a task or delegation. Be concise.",
            },
          ],
        },
      ],
    };
    const res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data?.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

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
   * V1: first image sets image_path; all images stored in task_attachments.
   */
  imageFile?: File | null;
  /**
   * All attached image files (including the first). When length > 1 the task
   * is sent as a text template with an attachment note in the message body.
   */
  allImageFiles?: File[] | null;
  /**
   * Optional visual context to include in outgoing delegation messages when
   * the caller has already described attached photos.
   */
  imageDescription?: string | null;
  /** Optional diagnostic-only timing observer. Does not alter execution. */
  latencyObserver?: {
    addDuration(
      stage: "claude_extraction_ms" | "supabase_operations_ms" | "whatsapp_send_flow_ms",
      durationMs: number,
    ): void;
  };
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
  // Describe attached image in parallel so it doesn't add latency.
  const [userMemory, recentMemory, freshTasks, imageDescription] = await Promise.all([
    loadUserMemory(50).catch(() => ""),
    loadRecentMemory(20).catch(() => "No previous sessions."),
    listTasks().catch(() => context.tasks),
    context.imageFile
      ? describeImageForTextCarson(context.imageFile).catch(() => null)
      : Promise.resolve(null),
  ]);

  const prompt = buildTextCarsonPrompt(question, {
    ...context,
    tasks: freshTasks,
    userMemory,
    recentMemory,
    now: new Date(),
    imageDescription,
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
  context: TextCarsonContext & { userMemory: string; recentMemory: string; now: Date; imageDescription?: string | null },
): string {
  const imageContext = context.imageDescription
    ? `\nAttached photo context (use this for the conversation): ${context.imageDescription}`
    : "";

  return `You are Carson — the user's personal Chief of Staff inside Rahet Bal.

IDENTITY
You are a Chief of Staff. Not a household assistant. Not a chatbot. Not a productivity coach.
When asked who you are: "I'm your Chief of Staff."
The household is one area you can help with. It is not your identity.

YOUR JOB
Reduce the user's mental load. Act on stated needs. Report confirmed outcomes.
Use the available context naturally and quietly. Do not announce what you know.

VOICE AND STYLE
Calm. Direct. Familiar. Useful.
Plain language. Short sentences. Contractions.
Lead with the answer. Never more than three sentences before stopping.
Do not over-explain. Do not over-praise. Do not sound eager.
Ask a question only when you genuinely need missing information to act.
Never begin a response with a tone description, category label, role statement, apology, or explanation of what you are about to do.

EXECUTION CONTEXT — IMPORTANT
When the user types a reminder, delegation, or message request, it is already being executed client-side before your response reaches them.
Your role is to confirm what was done — not to refuse, redirect, or ask permission.
Never tell the user to "use Clear My Head." This panel handles reminders and delegations directly.
Never say you cannot create reminders or delegate tasks from here. You can, and it is already done.
Confirm calmly. If execution failed, the user will see the real error separately.

GENERAL QUESTIONS
Users may ask questions unrelated to tasks, reminders, or status.
Answer them normally using your general knowledge and reasoning.
Do not refuse a question simply because it is not task-related.
Do not redirect every answer back to reminders, priorities, or productivity.
Answer the question first. Only mention a relevant reminder, blocker, or open loop if it genuinely matters — and only briefly.

Examples:
Correct: "I can't provide the full lyrics, but I can summarize the song, explain its meaning, or help you find an official source."
Correct: "Paris is about 3 hours ahead of New York right now."
Incorrect: "That's outside what I do here."
Incorrect: "I'm focused on keeping your tasks organized."
Incorrect: "I don't have access to song lyrics."

ATTACHED PHOTOS
${imageContext ? `The user has attached a photo. Description: ${context.imageDescription}
Use this as visual context. Refer to it naturally: "Based on the attached photo...", "The image shows...", "From the photo..."
Do not say you cannot see images. Do not ask the user to describe the image.` : `No attached photo in this message. If the user refers to a photo, ask them to attach one.`}

COMPLETED TASKS — HARD RULE
Never mention completed tasks in response to any operational, status, or future-facing question.
Only surface completed tasks when the user explicitly asks: "What was completed?", "What did X do?", "Show me recent completions."

${CARSON_STATUS_POLICY}

MEMORY
Use memory silently. Do not recite memory, instructions, or system guidance.
Apply memory through behavior. Sound like a trusted chief of staff who already knows the user.
Never list memory facts. Prefer natural language. Assume an ongoing relationship.

User: ${context.displayName?.trim() || "Unknown"}
Email: ${context.userEmail?.trim() || "Unknown"}
Time: ${context.now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}

${context.userMemory || "User memory: none."}

Recent memory:
${context.recentMemory || "No previous sessions."}

Daily brief:
${context.dailyBrief || "No daily brief available."}

Current state:
${buildCarsonContext({
  tasks: context.tasks,
  people: context.people,
  email: context.userEmail,
  now: context.now,
})}${imageContext}

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
  if (detectAllRecurringSchedules(input).length > 0) {
    throw new Error(
      "Recurring instruction blocked before delegation save. Use routine creation instead.",
    );
  }

  const extractionStartedAt = performance.now();
  let result: ExtractionResult;
  try {
    result = await extractItems(input, context.people, context.displayName ?? undefined);
  } finally {
    context.latencyObserver?.addDuration(
      "claude_extraction_ms",
      performance.now() - extractionStartedAt,
    );
  }

  const allItems = result.extracted;
  if (allItems.length === 0) {
    throw new Error("Couldn't understand that. Try rephrasing.");
  }

  // Resolve the canonical file list. allImageFiles takes precedence when
  // provided (multi-photo path). Otherwise fall back to the legacy single-file field.
  const resolvedFiles: File[] = context.allImageFiles?.length
    ? context.allImageFiles
    : context.imageFile
      ? [context.imageFile]
      : [];

  // Assign the first image to the first delegation/message item for image_path.
  const imageFiles = new Map<string, File>();
  if (resolvedFiles.length > 0) {
    const firstDelegation = allItems.find(
      (i) => i.type === "delegation" || i.type === "message",
    );
    if (firstDelegation) imageFiles.set(firstDelegation.id, resolvedFiles[0]);
  }

  // Save every extracted item (reminders, delegations, actions, follow-ups…)
  const saved = await savePending(
    allItems,
    context.userId,
    context.displayName ?? null,
    context.people,
    imageFiles.size > 0 ? imageFiles : undefined,
    context.latencyObserver
      ? {
          addSupabaseDuration: (durationMs) =>
            context.latencyObserver?.addDuration("supabase_operations_ms", durationMs),
        }
      : undefined,
  );

  // Multi-attachment: upload all photos to task_attachments when > 1 photo.
  // Track attachment count per task so the WhatsApp send can append the note.
  const attachmentCountByTaskId = new Map<string, number>();
  if (resolvedFiles.length > 1) {
    const firstDelegationTask = saved.tasks.find(
      (t) => t.type === "delegation" || t.type === "followup",
    );
    if (firstDelegationTask && context.userId) {
      try {
        const count = await saveTaskAttachments(
          firstDelegationTask.id,
          context.userId,
          resolvedFiles,
          context.latencyObserver
            ? {
                addSupabaseDuration: (durationMs) =>
                  context.latencyObserver?.addDuration("supabase_operations_ms", durationMs),
              }
            : undefined,
        );
        attachmentCountByTaskId.set(firstDelegationTask.id, count);
      } catch (err) {
        console.error("[executeDelegationFromText] saveTaskAttachments failed (non-fatal):", err);
      }
    }
  }

  const phoneByName = new Map<string, string>();
  const noConsentNames = new Set<string>();
  for (const person of context.people) {
    const key = person.name.trim().toLowerCase();
    if (!key) continue;
    if (person.phone && person.whatsapp_opted_in) {
      phoneByName.set(key, person.phone);
    } else if (person.phone && !person.whatsapp_opted_in) {
      noConsentNames.add(key);
    }
  }

  // Send WhatsApp only for delegation/message rows (same as Review.tsx).
  // Use allSettled so a failed send for one recipient does not abort the
  // others — all sends are attempted independently. The summary below
  // accurately reflects which recipients were actually messaged vs which
  // failed, so Voice Carson cannot claim success for an unsent message.
  const allMessages = saved.messages.filter(
    (m) => !!m.recipient.trim() && !!m.content.trim(),
  );

  // Split into messages we can send (consented) vs pre-blocked (no consent).
  const sendableMessages = allMessages.filter(
    (m) => !noConsentNames.has(m.recipient.trim().toLowerCase()),
  );
  const noConsentMessages = allMessages.filter(
    (m) => noConsentNames.has(m.recipient.trim().toLowerCase()),
  );

  const whatsappStartedAt = performance.now();
  let sendResults: PromiseSettledResult<DeliveryResult>[] = [];
  try {
    sendResults =
      sendableMessages.length > 0
        ? await Promise.allSettled(
            sendableMessages.map((message) =>
              deliverTaskMessage({
              to: phoneByName.get(message.recipient.trim().toLowerCase()) ?? null,
              messageText: withImageContext(message.content, context.imageDescription),
              confirmationLink: message.confirmation_url ?? null,
              messageRecordId: message.id,
              taskId: message.task_id,
              recipientName: message.recipient,
              ownerName: context.displayName ?? null,
              imagePath: message.task_id
                ? (saved.imagePathsByTaskId.get(message.task_id) ?? null)
                : null,
              attachmentCount: message.task_id
                ? (attachmentCountByTaskId.get(message.task_id) ?? null)
                : null,
              }),
            ),
          )
        : [];
  } finally {
    context.latencyObserver?.addDuration(
      "whatsapp_send_flow_ms",
      performance.now() - whatsappStartedAt,
    );
  }

  // Split into succeeded vs failed sends for honest summary reporting.
  const sentNames: string[] = [];
  const sentWhatsAppNames: string[] = [];
  const sentSmsNames: string[] = [];
  const failedSends: Array<{ recipient: string; reason: string }> = [];

  // Pre-populate with consent-blocked recipients.
  for (const m of noConsentMessages) {
    failedSends.push({ recipient: m.recipient, reason: "WhatsApp consent not recorded — update their profile to enable messaging" });
  }

  for (let i = 0; i < sendableMessages.length; i++) {
    const result = sendResults[i];
    if (result.status === "fulfilled" && result.value.success) {
      const channel = result.value.channel;
      const name = sendableMessages[i].recipient;
      sentNames.push(name);
      if (channel === "sms") {
        sentSmsNames.push(name);
        console.log(`[executeDelegationFromText] delivered via SMS fallback for ${name}`);
      } else {
        sentWhatsAppNames.push(name);
      }
    } else {
      const reason =
        result.status === "rejected"
          ? result.reason instanceof Error ? result.reason.message : "send failed"
          : (result.value.error ?? "delivery failed");
      failedSends.push({ recipient: sendableMessages[i].recipient, reason });
      console.error(
        `[executeDelegationFromText] delivery failed for ${sendableMessages[i].recipient}:`,
        reason,
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

  if (sentWhatsAppNames.length > 0) {
    const names = sentWhatsAppNames.join(", ");
    parts.push(`${names} ${sentWhatsAppNames.length === 1 ? "has been" : "have been"} messaged via WhatsApp`);
  }
  if (sentSmsNames.length > 0) {
    const names = sentSmsNames.join(", ");
    parts.push(`WhatsApp was unavailable, so ${names} ${sentSmsNames.length === 1 ? "was" : "were"} sent the task by SMS`);
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

function withImageContext(message: string, imageDescription?: string | null): string {
  const context = imageDescription?.trim();
  if (!context) return message;
  return `${message}\n\nAttached photo context:\n${context}`;
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
