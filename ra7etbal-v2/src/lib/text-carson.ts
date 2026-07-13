import type { Person } from "../types/person";
import type { Task } from "../types/task";
import type { Message } from "../types/message";
import type { ExtractionResult } from "../types/extraction";
import { upsertUserFacts } from "./carson-facts";
import { saveSessionMemory } from "./carson-memory";
import { extractItems } from "./ai/extract";
import { savePending, saveTaskAttachments } from "./save";
import { resizeImage } from "./image-upload";
import { detectAllRecurringSchedules } from "./routine-detection";
import { deliverTaskMessage, type DeliveryResult } from "./delivery";
import { sendDirectMessageRecord } from "./direct-messages";
import { useTasksStore } from "../stores/tasks";
import { summarizeConversation } from "./carson-summarize";
import { extractDurableFacts } from "./carson-fact-extract";
import { updatePeopleInsightsFromTasks } from "./people-behavior";
import { sanitizeCarsonReplyText } from "./carson-social";
import { parseMultiRecipientDelegation } from "./multi-recipient-delegation";

/**
 * The highest-risk point in the extraction pipeline for altering visible
 * text: Home.tsx's text+image submission branch calls this to summarize a
 * reference photo BEFORE the main extraction model ever runs — the main
 * model (extractItems, ./ai/extract) never sees the actual image in that
 * branch, only this one-sentence description. A brand/product name misread
 * or paraphrased here is unrecoverable downstream (confirmed production
 * bug: a TEREA Silver reference photo produced "OTEREA Silver" in the final
 * task). The prompt below explicitly requires exact transcription of any
 * visible text for this reason.
 */
export async function describeImageForTextCarson(file: File): Promise<string | null> {
  try {
    // Normalize phone camera uploads to JPEG before vision. Raw iPhone/large
    // files can have unsupported media types; the task upload path already
    // uses resizeImage, so keep description generation on the same path.
    const blob = await resizeImage(file);
    const arrayBuffer = await blob.arrayBuffer();
    if (arrayBuffer.byteLength === 0) return null;
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((acc, byte) => acc + String.fromCharCode(byte), ""),
    );
    const payload = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 120,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
            {
              type: "text",
              text: "Describe this image in one sentence, focusing on the main subject and any actionable details relevant to a task or delegation. Be concise. If any brand name, product name, model name/number, variant, color, or other printed text is visible, transcribe it exactly as printed, character-for-character — never invent characters, correct spelling, or substitute a more familiar-looking name, even if it looks unusual. This description is the only thing the task-extraction step will ever see of this image, so any text you alter here can't be recovered later. If a specific name is too unclear to read with confidence, say so plainly (e.g. \"a pack labeled something like 'TEREA' (unclear)\") rather than guessing.",
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
  /** Supabase user ID — required for delegation execution. */
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
  /** Optional observer for callers that need to compare requested vs saved work. */
  onSavedExecution?: (saved: { tasks: Task[]; messages: Message[] }) => void;
  /**
   * Optional cross-path duplicate-delegation guard. When provided, a
   * delegation/follow-up whose (recipientName, taskText) matches a very
   * recent send elsewhere (e.g. the send_delegation tool call) is skipped
   * here instead of sent again. Voice wires this to the same cooldown state
   * send_delegation uses, so a duplicate can't slip through by reaching
   * Carson through a different code path than the first attempt.
   */
  isDuplicateDelegation?: (recipientName: string, taskText: string) => boolean;
  /** Called once per message actually delivered, so the caller's duplicate
   *  guard above learns about sends that happened through this path. */
  onDelegationSent?: (recipientName: string, taskText: string) => void;
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

  const deterministicItems = parseMultiRecipientDelegation(input, context.people);
  let allItems = deterministicItems ?? [];
  if (!deterministicItems) {
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
    allItems = result.extracted;
  }
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

  // Assign the first image to the item that can actually carry it through to
  // WhatsApp. Only "delegation" items get a companion message row with a
  // task_id (save.ts), which is what threads image_path into the send below —
  // a "message" item's row has task_id: null and save.ts never even reads
  // imageFiles for it, so picking one here silently dropped the photo even
  // when a real delegation existed in the same batch. Prefer delegation;
  // fall back to any other image-capable task type so the photo still shows
  // on the task card even when there's nothing to send over WhatsApp.
  const imageFiles = new Map<string, File>();
  if (resolvedFiles.length > 0) {
    const firstDelegation =
      allItems.find((i) => i.type === "delegation") ??
      allItems.find((i) => i.type !== "message" && i.type !== "parked");
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
  context.onSavedExecution?.({
    tasks: saved.tasks,
    messages: saved.messages,
  });

  // Multi-attachment: upload all photos to task_attachments when > 1 photo.
  // Track attachment count per task so the WhatsApp send can append the note.
  // If the attachment save fails, do not send that task as if the photos made
  // it through. The task exists, but the WhatsApp send is not proven complete.
  const attachmentCountByTaskId = new Map<string, number>();
  const attachmentFailedTaskIds = new Set<string>();
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
        attachmentFailedTaskIds.add(firstDelegationTask.id);
        console.error("[executeDelegationFromText] saveTaskAttachments failed:", err);
      }
    }
  }

  const phoneByName = new Map<string, string>();
  const missingPhoneNames = new Set<string>();
  const noConsentNames = new Set<string>();
  for (const person of context.people) {
    const key = person.name.trim().toLowerCase();
    if (!key) continue;
    if (person.phone && person.whatsapp_opted_in) {
      phoneByName.set(key, person.phone);
    } else if (!person.phone?.trim()) {
      missingPhoneNames.add(key);
    } else if (person.whatsapp_opted_in !== true) {
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

  // Cross-path duplicate guard: a task/message row is still created (matches
  // the existing "task created but not sent" convention below), but the
  // WhatsApp send itself is skipped if the caller's guard recognizes this as
  // the same delegation already sent moments ago through another path.
  const duplicateBlockedNames = new Set<string>();
  if (context.isDuplicateDelegation) {
    for (const m of allMessages) {
      const task = m.task_id ? saved.tasks.find((t) => t.id === m.task_id) : null;
      const taskText = task?.description ?? m.content;
      if (context.isDuplicateDelegation(m.recipient, taskText)) {
        duplicateBlockedNames.add(m.recipient.trim().toLowerCase());
      }
    }
  }

  // Split into messages we can send (consented) vs pre-blocked (no consent).
  const sendableMessages = allMessages.filter((m) => {
    const recipientKey = m.recipient.trim().toLowerCase();
    if (missingPhoneNames.has(recipientKey)) return false;
    if (noConsentNames.has(recipientKey)) return false;
    if (m.task_id && attachmentFailedTaskIds.has(m.task_id)) return false;
    if (duplicateBlockedNames.has(recipientKey)) return false;
    return true;
  });
  const missingPhoneMessages = allMessages.filter(
    (m) => missingPhoneNames.has(m.recipient.trim().toLowerCase()),
  );
  const noConsentMessages = allMessages.filter(
    (m) => noConsentNames.has(m.recipient.trim().toLowerCase()),
  );
  const attachmentFailedMessages = allMessages.filter(
    (m) => !!m.task_id && attachmentFailedTaskIds.has(m.task_id),
  );
  const duplicateBlockedMessages = allMessages.filter(
    (m) => duplicateBlockedNames.has(m.recipient.trim().toLowerCase()),
  );

  const whatsappStartedAt = performance.now();

  // Build the delivery promises first so we can race them with a timeout.
  // messageText uses message.content only — never withImageContext — so that
  // the raw AI vision description (filenames, markdown headings, "Attached
  // photo context:") never leaks into a staff WhatsApp message. Photos reach
  // the assignee via imagePath (template header) or the task-link photo grid.
  const deliveryPromises =
    sendableMessages.length > 0
      ? sendableMessages.map((message) =>
          !message.task_id && !message.confirmation_url
            ? sendDirectMessageRecord({
                source: "execute_instruction",
                message,
                messageText: message.content,
                phone: phoneByName.get(message.recipient.trim().toLowerCase()) ?? null,
                ownerName: context.displayName ?? null,
              })
            : deliverTaskMessage({
                to: phoneByName.get(message.recipient.trim().toLowerCase()) ?? null,
                messageText: message.content,
                confirmationLink: message.confirmation_url ?? null,
                messageRecordId: message.id,
                taskId: message.task_id,
                sendMode: null,
                recipientName: message.recipient,
                ownerName: context.displayName ?? null,
                imagePath: saved.imagePathsByTaskId.get(message.task_id!) ?? null,
                attachmentCount: attachmentCountByTaskId.get(message.task_id!) ?? null,
              }),
        )
      : [];

  // Race delivery against a 12 s timeout so slow Meta/image work cannot hang
  // the client tool forever. A timeout is reported as unconfirmed delivery,
  // never optimistic success: Carson may only say "sent" after the delivery
  // boundary returns a real accepted result.
  const DELIVERY_RACE_MS = 12_000;
  let sendResults: PromiseSettledResult<DeliveryResult>[] = [];
  try {
    sendResults = await Promise.race([
      Promise.allSettled(deliveryPromises),
      new Promise<PromiseSettledResult<DeliveryResult>[]>((resolve) =>
        setTimeout(
          () =>
            resolve(
              sendableMessages.map(() => ({
                status: "fulfilled" as const,
                value: {
                  success: false,
                  channel: "failed" as const,
                  error: "Delivery was not confirmed before the timeout. Check delivery status before assuming it was sent.",
                },
              })),
            ),
          DELIVERY_RACE_MS,
        ),
      ),
    ]);
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

  // Pre-populate with locally blocked recipients.
  for (const m of missingPhoneMessages) {
    failedSends.push({ recipient: m.recipient, reason: "No phone number is saved for this person" });
  }
  for (const m of noConsentMessages) {
    failedSends.push({ recipient: m.recipient, reason: "WhatsApp consent not recorded — update their profile to enable messaging" });
  }
  for (const m of attachmentFailedMessages) {
    failedSends.push({ recipient: m.recipient, reason: "The attached photos could not be saved, so I did not send the message" });
  }
  for (const m of duplicateBlockedMessages) {
    failedSends.push({ recipient: m.recipient, reason: "I already sent this delegation moments ago — skipped to avoid a duplicate WhatsApp message" });
  }

  for (let i = 0; i < sendableMessages.length; i++) {
    const result = sendResults[i];
    if (result.status === "fulfilled" && result.value.success) {
      const channel = result.value.channel;
      const message = sendableMessages[i];
      const name = message.recipient;
      sentNames.push(name);
      if (context.onDelegationSent) {
        const task = message.task_id ? saved.tasks.find((t) => t.id === message.task_id) : null;
        context.onDelegationSent(name, task?.description ?? message.content);
      }
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
      !sentNames.includes(t.assigned_to ?? "") &&
      !failedSends.some((failure) => failure.recipient === t.assigned_to),
  );

  const parts: string[] = [];

  if (sentWhatsAppNames.length > 0) {
    const names = sentWhatsAppNames.join(", ");
    parts.push(`${names} ${sentWhatsAppNames.length === 1 ? "has" : "have"} it`);
  }
  if (sentSmsNames.length > 0) {
    const names = sentSmsNames.join(", ");
    parts.push(`${names} ${sentSmsNames.length === 1 ? "has" : "have"} it by SMS`);
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
    parts.push(reminderCount === 1 ? "I'll remind you" : `${reminderCount} reminders are covered`);
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
  return sanitizeCarsonReplyText(
    `${summary.charAt(0).toUpperCase() + summary.slice(1)}. I'll follow up if needed.`,
  ) || "I'm handling it.";
}

// withImageContext was removed. The imageDescription (AI vision analysis) must
// never appear in outgoing staff WhatsApp messages — it contains UUID filenames,
// markdown headings, and raw vision output. Photos reach staff via imagePath
// (WhatsApp image template header) or the confirm-page photo grid.
