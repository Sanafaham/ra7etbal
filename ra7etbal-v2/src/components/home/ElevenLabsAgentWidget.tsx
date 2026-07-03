import { Conversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import { resizeImage, uploadTaskImage } from "../../lib/image-upload";
import { saveTaskAttachments } from "../../lib/save";
import { extractDurableFacts } from "../../lib/carson-fact-extract";
import { loadUserMemory, upsertUserFacts } from "../../lib/carson-facts";
import { loadRecentMemory, saveSessionMemory } from "../../lib/carson-memory";
import { loadPersistentMemory, savePersistentInstruction } from "../../lib/carson-persistent-memory";
import { saveCarsonNote, loadRecentNotes, findNoteMatches, type CarsonNote } from "../../lib/carson-notes";
import { createTodo, listActiveTodos, completeTodo, findTodoMatches, type CarsonTodo } from "../../lib/carson-todos";
import { listClearMyHeadInboxItems, deleteClearMyHeadInboxItem } from "../../lib/clear-my-head-inbox";
import { looksLikeTaskInstruction } from "../../lib/carson-inbox-action-quality";
import {
  extractTodoTitleParam,
  extractTodoDescriptionParam,
  extractTodoQueryParam,
  extractStringField,
  type CreateTodoParams,
  type CompleteTodoParams,
} from "../../lib/carson-todo-tool-params";
import {
  extractPersonNameParam,
  extractMessageParam,
  extractTaskParam,
  extractNoteParam,
  extractTimeTextParam,
  extractCityParam,
  extractQueryParam,
  extractCalendarTitleParam,
  extractEventIdParam,
  extractAutomationInstructionParam,
} from "../../lib/carson-tool-params";
import { filterCalendarEventsByRange } from "../../lib/calendar";
import type { CalendarEvent, CalendarRange } from "../../lib/calendar";
import { callCalendarApi } from "../../lib/calendar-actions";
import { sanitizeForCarsonSpeech } from "../../lib/speech-sanitize";
import {
  buildSessionRecapWithActions,
  summarizeConversation,
  summarizeSessionRecap,
  isSummaryWorthSaving,
  SESSION_RECAP_PREFIX,
  type TranscriptMessage,
} from "../../lib/carson-summarize";
import { parseVoiceTime } from "../../lib/parse-voice-time";
import { buildCarsonOpeningLine } from "../../lib/carson-opening";
import { createReminderTask } from "../../lib/reminders";
import {
  createDelegationTaskAndMessage,
} from "../../lib/delegations";
import { createAndSendDirectMessage, DirectMessageBoundaryError } from "../../lib/direct-messages";
import { executeDelegationFromText } from "../../lib/text-carson";
import { executeDirectMessageFastPath, parseSimpleDirectMessage } from "../../lib/direct-message-fast-path";
import { executeDelegationFastPath } from "../../lib/delegation-fast-path";
import {
  getSocialAcknowledgementReply,
  isSocialAcknowledgement,
  sanitizeCarsonErrorDetail,
  sanitizeCarsonReplyText,
  sanitizeSocialAcknowledgementReply,
  shouldSuppressCarsonIdlePrompt,
} from "../../lib/carson-social";
import { planCarsonInstruction } from "../../lib/carson-planner";
import { auditCarsonExecution } from "../../lib/carson-audit";
import {
  summarizeCarsonAuditDiagnostic,
  summarizeCarsonPlanDiagnostic,
} from "../../lib/carson-planner-diagnostics";
import { buildCarsonDirectToolDiagnosticEvent } from "../../lib/carson-direct-tool-diagnostics";
import { detectAllRecurringSchedules, buildVoiceAutomationInput, createReminderRoutineFromInstruction, findPersonInInstruction, normalizeCadenceText, resolveRecurringAutomationPerson } from "../../lib/routine-detection";
import {
  buildOperationalPlanFromOutcome,
  resolveGuestOutcomeAction,
  executeProposedPlan,
  isConfirmation,
  isRejection,
  isStatusQuestion,
  resolvePendingPlanDecision,
  handlePendingPlanTurn,
  loadLatestPendingPlan,
  type ProposedPlan,
} from "../../lib/ops-intelligence";
import { mergePersonNotes, updatePeopleInsightsFromTasks } from "../../lib/people-behavior";
import { createMessage } from "../../lib/messages";
import { createTask } from "../../lib/tasks";
import { sendWhatsAppTask } from "../../lib/whatsapp";
import { recordCarsonDiagnostic } from "../../lib/carson-diagnostics";
import { resolveSanitizedCarsonDisplayMessage, type DirectToolSuccessResult } from "../../lib/carson-direct-tool-override";
import {
  executeVoiceTaskControl,
  resolveVoiceTaskControl,
  type VoiceTaskContext,
} from "../../lib/voice-task-control";
import {
  buildDelegationCoveragePartialSuccessResponse,
  checkDelegationCoverage,
  type ExecutedDelegationRecord,
} from "../../lib/carson-action-coverage";
import { CARSON_STATUS_POLICY, CARSON_VOICE_SESSION_GUARD } from "../../lib/carson-status-policy";
import {
  addLatencyStageDuration,
  createExecuteInstructionLatencyTrace,
  roundDuration,
  type ExecuteInstructionLatencyTrace,
} from "../../lib/carson-latency";
import { useAuthStore } from "../../stores/auth";
import type { Person } from "../../types/person";
import { usePeopleStore } from "../../stores/people";
import { useProfileStore } from "../../stores/profile";
import { useTasksStore } from "../../stores/tasks";

type CallStatus = "idle" | "connecting" | "connected" | "error";
type AgentMode = "listening" | "speaking";
type ExecuteInstructionParams =
  | string
  | {
      instruction?: unknown;
      instructions?: unknown;
      text?: unknown;
      input?: unknown;
    }
  | null
  | undefined;

interface PendingPhoto {
  id: string;
  file: File;
  previewUrl: string;
  name: string;
}

function extractInstructionParam(params: ExecuteInstructionParams): string {
  if (typeof params === "string") return params;
  if (!params || typeof params !== "object") return "";

  for (const key of ["instruction", "instructions", "text", "input"] as const) {
    const value = params[key];
    if (typeof value === "string") return value;
  }
  return "";
}


// ---------------------------------------------------------------------------
// Image analysis — converts an attached File to a 1-sentence Claude description.
// Called at execute_instruction time so Carson receives image context in the
// same turn as the spoken instruction.
// Returns null on any failure so callers can fall back gracefully.
// ---------------------------------------------------------------------------
async function describeImageForCarson(file: File): Promise<string | null> {
  console.log("[img-diag] describeImageForCarson called — file:", file?.name, file?.size, file?.type);
  try {
    // Use the same browser JPEG-normalization path as task uploads. Phone
    // camera files can arrive as HEIC/large originals; Anthropic vision expects
    // common web image types, and raw unsupported files made Carson think no
    // photo was attached.
    const blob = await resizeImage(file);
    const arrayBuffer = await blob.arrayBuffer();
    console.log("[img-diag] arrayBuffer size:", arrayBuffer.byteLength);
    if (arrayBuffer.byteLength === 0) {
      console.warn("[img-diag] arrayBuffer is empty — File object may have been invalidated by iOS");
      return null;
    }
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((acc, byte) => acc + String.fromCharCode(byte), ""),
    );
    const mediaType = "image/jpeg";

    const payload = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 120,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            {
              type: "text",
              text: "Describe this image in one sentence, focusing on the main subject and any actionable details relevant to a task delegation. Be concise.",
            },
          ],
        },
      ],
    };

    console.log("[img-diag] POSTing to /api/anthropic for vision description");
    const res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    console.log("[img-diag] /api/anthropic response status:", res.status);
    if (!res.ok) {
      const errText = await res.text().catch(() => "(unreadable)");
      console.warn("[img-diag] /api/anthropic error body:", errText);
      return null;
    }
    const data = await res.json();
    const description: string | undefined = data?.content?.[0]?.text?.trim();
    console.log("[img-diag] vision description:", description ?? "(null/empty)");
    return description || null;
  } catch (err) {
    console.error("[img-diag] describeImageForCarson threw:", err);
    return null;
  }
}

async function describePhotosForCarson(photos: PendingPhoto[]): Promise<string | null> {
  if (photos.length === 0) return null;

  const descriptions = await Promise.all(
    photos.map(async (photo, index) => {
      const description = await describeImageForCarson(photo.file).catch(() => null);
      return `Photo ${index + 1}${photo.name ? ` (${photo.name})` : ""}: ${
        description || "An attached photo is present, but the visual description could not be generated."
      }`;
    }),
  );

  const lines = descriptions.filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : null;
}

interface SentDelegationRecord {
  personName: string;
  taskText: string;
  messageText: string;
}

const MAX_VOICE_PHOTOS = 1;
const MID_SESSION_PHOTO_PENDING_CONTEXT =
  "The user attached a photo during this call. The current photo is available for delegation, but the visual description is still being generated. Use this current photo only and ignore any earlier attached photo.";

interface DelegationSendOptions {
  userId: string;
  person: Person;
  taskText: string;
  message?: string;
  /** Personal/emotional/status note to inject into the message body, e.g.
   *  "Sana says she misses you." — never tracked as a separate task. */
  personalNote?: string | null;
  ownerName?: string | null;
  /**
   * Optional image to attach to the delegation.
   * Uploaded before createTask so image_path is set atomically.
   * When non-null, send-whatsapp-task uses ra7etbal_task_image automatically.
   */
  imageFile?: File | null;
  /**
   * Current Talk to Carson image set. Voice UX is single-image by design:
   * replacing an image removes the previous one before a delegation can send.
   */
  imageFiles?: File[] | null;
}

/**
 * Best-effort extraction of a personal note from an agent-supplied message.
 *
 * When the ElevenLabs agent calls send_delegation with a `message` that
 * includes both the action request and a personal note, this extracts
 * the note sentences so they can be injected via injectPersonalNote.
 *
 * Skips:
 *  - Opening greeting lines ("Hi Grace, ...")
 *  - The action request sentence (contains the task text)
 *  - Standard closing lines ("Confirm when done", "Let X know when done")
 */
function extractNoteFromAgentMessage(
  agentMessage: string | undefined,
  taskText: string,
): string | null {
  if (!agentMessage?.trim()) return null;
  const taskCore = taskText.toLowerCase().replace(/[.!?]+$/, "").trim().slice(0, 30);
  const sentences = agentMessage
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const noteSentences = sentences.filter((s) => {
    const lower = s.toLowerCase();
    if (/^hi\s+\w+/i.test(s)) return false;
    if (/\b(confirm when done|confirm when finished|let \w+ know when done|let me know when done)\b/i.test(lower)) return false;
    if (taskCore && lower.includes(taskCore)) return false;
    if (/^(can you|could you|please\b)/i.test(s)) return false;
    return true;
  });
  return noteSentences.join(" ").trim() || null;
}

interface DelegationSendResult {
  taskId: string;
  messageText: string;
  taskContext: VoiceTaskContext;
  deliveryId?: string | null;
  messageId?: string | null;
  channel?: "whatsapp" | "sms";
}

async function createAndSendDelegation({
  userId,
  person,
  taskText,
  message,
  personalNote,
  ownerName,
  imageFile,
  imageFiles,
}: DelegationSendOptions): Promise<DelegationSendResult> {
  const rawNote =
    personalNote?.trim() ||
    extractNoteFromAgentMessage(message, taskText) ||
    null;

  const taskRowId = crypto.randomUUID();

  // Resolve the canonical photo list. imageFiles (multi) takes precedence;
  // fall back to the legacy single imageFile field.
  const resolvedFiles: File[] = imageFiles?.length
    ? imageFiles
    : imageFile
      ? [imageFile]
      : [];

  // Start image upload immediately so it can overlap with task/message
  // creation, but still await it before reporting success. Carson may only say
  // "sent" after both attachment handling and delivery are proven.
  const imageUploadPromise: Promise<string | null> =
    resolvedFiles.length > 0
      ? (async () => {
          try {
            const blob = await resizeImage(resolvedFiles[0]);
            const path = await uploadTaskImage(userId, taskRowId, blob);
            console.log("[send_delegation] image_uploaded task_id=", taskRowId, "path=", path);
            return path;
          } catch (err) {
            console.error("[send_delegation] image upload failed (non-fatal, task still created):", err);
            return null;
          }
        })()
      : Promise.resolve(null);

  // Create task with imagePath=null; once upload resolves we patch image_path
  // and send WhatsApp only after attachment handling has succeeded.
  const created = await createDelegationTaskAndMessage({
    source: "send_delegation",
    userId,
    assignee: person,
    taskText,
    note: rawNote,
    imagePath: null,
    ownerName,
    taskId: taskRowId,
    onEscalationError: (err, task) =>
      console.error("[send_delegation] QStash scheduleEscalationMessages failed for task", task.id, err),
  });
  const taskRow = created.task;
  console.log("[send_delegation] task_created task_id=", taskRow.id);

  const resolvedImagePath = await imageUploadPromise;
  if (resolvedFiles.length > 0 && !resolvedImagePath) {
    throw new Error("The attached photo could not be saved, so I did not send the delegation.");
  }

  if (resolvedImagePath) {
    const { error } = await supabase
      .from("tasks")
      .update({ image_path: resolvedImagePath })
      .eq("id", taskRow.id);
    if (error) {
      console.error("[send_delegation] image_path update failed:", error);
      throw new Error("The attached photo could not be linked to the task, so I did not send the delegation.");
    }
    console.log("[send_delegation] image_path updated task_id=", taskRow.id);
  }

  let attachmentCount: number | null = null;
  if (resolvedFiles.length > 1) {
    try {
      attachmentCount = await saveTaskAttachments(taskRow.id, userId, resolvedFiles);
    } catch (err) {
      console.error("[send_delegation] saveTaskAttachments failed:", err);
      throw new Error("The attached photos could not be saved, so I did not send the delegation.");
    }
  }

  console.log("[send_delegation] send_started task_id=", taskRow.id, "has_image=", !!resolvedImagePath);
  const delivery = await sendWhatsAppTask({
    to: person.phone,
    messageText: created.messageText,
    confirmationLink: created.confirmationUrl,
    messageRecordId: created.message?.id ?? null,
    taskId: taskRow.id,
    recipientName: person.name,
    ownerName: ownerName ?? null,
    imagePath: resolvedImagePath,
    attachmentCount,
  });

  return {
    taskId: taskRow.id,
    messageText: created.messageText,
    deliveryId: delivery.deliveryId ?? null,
    messageId: delivery.messageId ?? null,
    channel: delivery.channel,
    taskContext: {
      id: taskRow.id,
      description: taskRow.description,
      assigned_to: taskRow.assigned_to,
      type: taskRow.type,
    },
  };
}

/**
 * Builds the `current_time` dynamic variable as a human-readable LOCAL date/time
 * with a timezone label, followed by the UTC ISO string for unambiguous machine
 * reference. Previously only the raw UTC ISO was injected, so Carson had no
 * local anchor and couldn't reason about how long ago a session happened.
 *
 *   "Sunday, Jun 22, 2026, 4:14 AM (Europe/Istanbul) [UTC 2026-06-22T01:14:00.000Z]"
 */
function buildCurrentTimeLabel(now: Date = new Date()): string {
  const local = now.toLocaleString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    tz = "";
  }
  const tzLabel = tz ? ` (${tz})` : "";
  return `${local}${tzLabel} [UTC ${now.toISOString()}]`;
}

function normalizeDelegationKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeMemoryText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

function normalizeReminderKey(description: string, dueAt: string): string {
  return `${description.toLowerCase().replace(/\s+/g, " ").trim()}|${new Date(dueAt).toISOString()}`;
}

function splitIntoSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalizeMemoryText)
    .filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelyDurablePersonContext(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  const durableSignals = [
    "often",
    "usually",
    "always",
    "tends to",
    "needs",
    "prefers",
    "reliable",
    "responsible",
    "punctual",
    "helpful",
    "proactive",
    "strong",
    "protective",
    "bodyguard",
    "bossy",
    "controlling",
    "clear instructions",
    "follow-up",
    "follow up",
  ];
  const temporarySignals = [
    "today",
    "tonight",
    "tomorrow",
    "guests",
    "dinner",
    "flowers",
    "cars",
    "kitchen",
    "gets home",
    "arrive",
    "arrives",
    " at 7",
    " at 9",
  ];

  return (
    durableSignals.some((signal) => lower.includes(signal)) &&
    !temporarySignals.some((signal) => lower.includes(signal))
  );
}

function extractDurablePersonMemories(
  transcript: TranscriptMessage[],
  people: Person[],
): Array<{ person: Person; memory: string }> {
  const userText = transcript
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.message)
    .join("\n");
  if (!userText.trim() || people.length === 0) return [];

  const sentences = splitIntoSentences(userText);
  const updates: Array<{ person: Person; memory: string }> = [];

  for (const person of people) {
    const name = person.name.trim();
    if (!name) continue;
    const namePattern = new RegExp(`\\b${escapeRegex(name)}\\b`, "i");
    const matchingSentences = sentences.filter(
      (sentence) =>
        namePattern.test(sentence) && isLikelyDurablePersonContext(sentence),
    );
    if (matchingSentences.length === 0) continue;

    const memory = matchingSentences
      .map((sentence) =>
        normalizeMemoryText(sentence.replace(namePattern, "").replace(/^[:,\-\s]+/, "")),
      )
      .filter(Boolean)
      .join(" ");

    if (memory) updates.push({ person, memory });
  }

  return updates;
}

// mergePersonNotes is imported from ../../lib/people-behavior

function extractDinnerPreparationRequest(sourceText: string): { timeLabel: string; taskText: string; messageText: string } | null {
  const match = /\bdinner\s+(?:is|starts|will be|begins)\s+(?:at\s+)?(?<time>(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm|a\.m\.|p\.m\.)?)\b/i.exec(
    sourceText,
  );
  const rawTime = match?.groups?.time?.trim();
  if (!rawTime) return null;

  const timeLabel = rawTime
    .replace(/\s+/g, " ")
    .replace(/\ba\.m\.\b/i, "AM")
    .replace(/\bp\.m\.\b/i, "PM")
    .replace(/\bam\b/i, "AM")
    .replace(/\bpm\b/i, "PM")
    .trim();

  return {
    timeLabel,
    taskText: `Prepare dinner by ${timeLabel}.`,
    messageText: `Can you please prepare dinner by ${timeLabel}?`,
  };
}

function hasDinnerPreparationDelegation(records: SentDelegationRecord[]): boolean {
  return records.some((record) => {
    const haystack = `${record.taskText} ${record.messageText}`.toLowerCase();
    return (
      /\bdinner\b/.test(haystack) &&
      /\b(prepare|prep|cook|make|ready|serve|have)\b/.test(haystack)
    );
  });
}

function findDinnerOwner(people: Person[]): Person | null {
  return people.find((person) => /\b(cook|chef|kitchen)\b/i.test(person.role)) ?? null;
}

// ---------------------------------------------------------------------------
// Smart follow-up helpers
// ---------------------------------------------------------------------------

/** Same criteria as isWaitingTask() in daily-brief.ts — not imported to avoid
 *  coupling the widget to brief logic. */
function isOpenWaitingTask(task: {
  archived_at: string | null;
  status: string;
  assigned_to: string | null;
  needs_follow_up: boolean;
  type: string;
}): boolean {
  if (task.archived_at !== null) return false;
  if (task.status === "done" || task.status === "cancelled") return false;
  if (task.needs_follow_up) return true;
  if (task.type === "delegation" && task.assigned_to) return true;
  if (task.type === "followup") return true;
  return false;
}

/** Strip leading action verbs so the topic reads naturally in a sentence.
 *  Mirrors cleanForWaiting() in daily-brief.ts. */
function topicFromDescription(description: string): string {
  const trimmed = description.trim().replace(/[.!?]+$/, "").trim();
  const cleaned = trimmed.replace(
    /^(Confirm|Ask|Tell|Remind|Have|Message|Send|Check|Follow up on|Follow up|Get)\s+/i,
    "",
  );
  const result = cleaned === trimmed ? trimmed : cleaned;
  // lower-case the first letter so it fits mid-sentence
  return result.charAt(0).toLowerCase() + result.slice(1);
}

/** Build the default follow-up message text from a task description. */
function buildFollowUpText(description: string): string {
  const topic = topicFromDescription(description);
  return `Following up on ${topic}. Let me know when done.`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ElevenLabsAgentWidget({
  briefStateText,
  spokenBrief,
  displayName,
  planningCalendarEvents = [],
  calendarFetched = false,
  inline = false,
  onBeforeCallStart,
  onCallStatusChange,
  onRequestClose,
}: {
  briefStateText: string;
  /** Pre-built spoken daily brief paragraph injected as `daily_brief` dynamic variable. */
  spokenBrief?: string;
  displayName?: string | null;
  /**
   * 30-day calendar planning cache prefetched by Home before each session.
   * Powers get_calendar_events in-memory filtering — no live network call needed.
   */
  planningCalendarEvents?: CalendarEvent[];
  /**
   * True once App has completed a successful 30-day calendar fetch (even if it
   * returned zero events). Lets get_calendar_events distinguish "calendar
   * connected but empty" from "calendar not connected / fetch not yet done".
   */
  calendarFetched?: boolean;
  /** When true, renders inline (no fixed positioning). Use inside the Carson section. */
  inline?: boolean;
  /**
   * Optional async callback invoked at the very start of startCall(), before
   * the ElevenLabs session opens. Should force-refresh live task/message state
   * from Supabase and return freshly computed context strings.
   *
   * Returns BOTH dynamic variables so the stale React snapshot is bypassed for
   * every variable Carson reads — not just ra7etbal_state. Without this,
   * daily_brief (spokenBrief) would still contain stale waiting-on data even
   * after a task is confirmed in Supabase.
   */
  onBeforeCallStart?: () => Promise<{ briefStateText: string; spokenBrief: string }>;
  /** Called whenever the call status changes — lets the parent track connected state. */
  onCallStatusChange?: (status: CallStatus) => void;
  /** Called when the user taps a close/dismiss control inside the widget. */
  onRequestClose?: () => void;
}) {
  const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID?.trim();

  const [status, setStatus] = useState<CallStatus>("idle");
  const [mode, setMode] = useState<AgentMode>("listening");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionEndedMsg, setSessionEndedMsg] = useState<string | null>(null);

  // Notify parent whenever call status changes.
  useEffect(() => { onCallStatusChange?.(status); }, [status, onCallStatusChange]);
  /** Latest finalized spoken response from Carson. Cleared at session start, persists after disconnect. */
  const [lastCarsonMessage, setLastCarsonMessage] = useState<string | null>(null);
  /** Latest finalized user transcript, shown briefly for local voice diagnostics only. */
  const [lastUserTranscript, setLastUserTranscript] = useState<string | null>(null);
  const userTranscriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationRef = useRef<Awaited<
    ReturnType<typeof Conversation.startSession>
  > | null>(null);
  const statusRef = useRef<CallStatus>("idle");
  const sessionGenerationRef = useRef(0);
  const startInFlightRef = useRef(false);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Pending photos for the next voice delegation.
  // Stored in a ref (not state) to avoid triggering re-renders and to ensure
  // executeInstruction always reads the latest value without stale closure issues.
  const pendingPhotosRef = useRef<PendingPhoto[]>([]);
  // Preview metadata is state so thumbnails re-render correctly.
  const [pendingPhotoPreviews, setPendingPhotoPreviews] = useState<PendingPhoto[]>([]);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const photoRevisionRef = useRef(0);

  // Session-scoped photo snapshot.
  // On iOS Safari, a File from <input type="file"> can become inaccessible
  // once the input element unmounts. Snapshotted at startCall time, before
  // setStatus("connecting") changes state.
  const sessionPhotosRef = useRef<PendingPhoto[]>([]);

  // Pre-computed photo descriptions for the active session.
  // Generated during startCall setup (parallel to memory loads) and injected
  // into Carson immediately after the session connects — before the user speaks.
  // This ensures Carson has photo context from the very first word, not only
  // when execute_instruction fires (which can be after Carson has already responded).
  const sessionPhotoContextRef = useRef<string | null>(null);

  const syncPendingPhotoState = useCallback((next: PendingPhoto[]) => {
    pendingPhotosRef.current = next;
    setPendingPhotoPreviews(next);
  }, []);

  const clearPendingPhotoPreviews = useCallback(() => {
    photoRevisionRef.current += 1;
    for (const photo of pendingPhotosRef.current) {
      URL.revokeObjectURL(photo.previewUrl);
    }
    pendingPhotosRef.current = [];
    setPendingPhotoPreviews([]);
  }, []);

  // Revoke object URLs and clear both queued photos and active session snapshots.
  // Use after a successful send or manual removal, when the photo is truly done.
  const clearPendingImages = useCallback(() => {
    clearPendingPhotoPreviews();
    sessionPhotosRef.current = [];
    sessionPhotoContextRef.current = null;
  }, [clearPendingPhotoPreviews]);

  function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const newFiles = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow reselecting same files
    if (newFiles.length === 0) return;

    const previousPhotos = pendingPhotosRef.current;
    for (const photo of previousPhotos) {
      URL.revokeObjectURL(photo.previewUrl);
    }

    const file = newFiles.slice(0, MAX_VOICE_PHOTOS)[0];
    if (!file) return;
    const newPhoto = {
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
    };
    const newPhotos = [newPhoto];
    const revision = photoRevisionRef.current + 1;
    photoRevisionRef.current = revision;

    syncPendingPhotoState(newPhotos);
    sessionPhotosRef.current = newPhotos;
    sessionPhotoContextRef.current =
      statusRef.current === "connected"
        ? MID_SESSION_PHOTO_PENDING_CONTEXT
        : null;

    // Mid-call attachment/replacement — pendingPhotosRef and sessionPhotosRef
    // now hold exactly the current image, so the next tool call sends the
    // latest photo only. Update Carson's live context too; stale descriptions
    // are ignored if the user replaces/removes the photo before vision returns.
    if (statusRef.current === "connected" && conversationRef.current) {
      conversationRef.current.sendContextualUpdate(
        `[Session photo update] ${MID_SESSION_PHOTO_PENDING_CONTEXT}`,
      );
      describePhotosForCarson(newPhotos)
        .then((description) => {
          if (
            photoRevisionRef.current !== revision ||
            pendingPhotosRef.current[0]?.id !== newPhoto.id
          ) {
            return;
          }
          const currentDescription = description ?? MID_SESSION_PHOTO_PENDING_CONTEXT;
          sessionPhotoContextRef.current = currentDescription;
          conversationRef.current?.sendContextualUpdate(
            `The user just attached or replaced the photo during this call. Current photo description:\n${currentDescription}\nUse this current photo only for the task they were referring to. Ignore any earlier attached photo.`,
          );
        })
        .catch((err) => console.error("[carson-photo-attach] mid-call describe failed (non-fatal):", err));
    }
  }

  function removePendingPhoto(id: string) {
    const removed = pendingPhotosRef.current.find((photo) => photo.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    photoRevisionRef.current += 1;
    const next = pendingPhotosRef.current.filter((photo) => photo.id !== id);
    syncPendingPhotoState(next);
    sessionPhotosRef.current = next;
    sessionPhotoContextRef.current = null;
    if (statusRef.current === "connected" && conversationRef.current) {
      conversationRef.current.sendContextualUpdate(
        "The user removed the attached photo during this call. Do not use any previously attached photo for the next action.",
      );
    }
  }

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      for (const photo of pendingPhotosRef.current) {
        URL.revokeObjectURL(photo.previewUrl);
      }
      if (userTranscriptTimerRef.current) {
        clearTimeout(userTranscriptTimerRef.current);
      }
    };
  }, []);

  /** Per-action cooldown: action/topic key → timestamp of last send */
  const lastSentRef = useRef<Map<string, number>>(new Map());

  /** Successful delegation sends from this live voice session. Used for
   *  deterministic Daily Brief safety nets and duplicate prevention. */
  const sentDelegationsRef = useRef<SentDelegationRecord[]>([]);

  /** Accumulates successful tool-call descriptions for this session.
   *  Flushed to carson_memory on disconnect. */
  const sessionActionsRef = useRef<string[]>([]);
  const createdReminderKeysRef = useRef<Map<string, string>>(new Map());

  /** Holds an unconfirmed operational plan proposed by Operations Intelligence.
   *  Cleared on execution or when a new instruction doesn't confirm it. */
  const pendingPlanRef = useRef<ProposedPlan | null>(null);

  /** Snapshot of saved notes loaded at startCall. Used by act_on_note for
   *  in-memory keyword lookup without hitting Supabase during the call. */
  const notesRef = useRef<CarsonNote[]>([]);

  /** Snapshot of active to-dos loaded at startCall. Used by complete_todo for
   *  in-memory keyword lookup without hitting Supabase during the call. */
  const todosRef = useRef<CarsonTodo[]>([]);

  /** Most recent concrete Ra7etBal task Carson created or controlled. Used
   *  only for safe "this / it / that" task-control references. */
  const currentTaskContextRef = useRef<VoiceTaskContext | null>(null);

  /** Most recent successful direct client-tool result.
   *  The ElevenLabs agent's spoken/displayed reply is a separate LLM generation
   *  (onMessage) that can contradict a tool that just succeeded — this lets
   *  onMessage prefer the tool's own result over a contradictory agent message. */
  const lastDirectToolSuccessRef = useRef<DirectToolSuccessResult | null>(null);

  /**
   * Last user utterance that contained recurring language, captured in onMessage
   * BEFORE the LLM processes it. ElevenLabs sometimes strips recurring language
   * from the `instruction` param passed to execute_instruction, so we capture the
   * raw text here and use it as the authoritative source for recurring detection.
   * Cleared at session start and consumed (set null) after the first matching tool call.
   */
  const recurringRawRef = useRef<string | null>(null);

  // Diagnostic only: tracks which client tool (if any) is mid-execution, so the
  // onDisconnect log can report whether a disconnect landed before, during, or
  // after a tool call. Null when no tool is running. No behavioral effect.
  const toolInFlightRef = useRef<string | null>(null);
  const lastUserTranscriptTimingRef = useRef<{
    eventId: number | null;
    receivedAt: string;
    receivedPerf: number;
  } | null>(null);
  const activeExecuteLatencyRef = useRef<{
    trace: ExecuteInstructionLatencyTrace;
    toolStartedPerf: number;
    toolCompletedPerf: number | null;
  } | null>(null);

  /** Accumulates finalized transcript messages (both user and agent) for
   *  this session. Summarised by Haiku at disconnect for conversational memory. */
  const sessionTranscriptRef = useRef<TranscriptMessage[]>([]);

  // Tracks latest planning calendar cache for stable useCallback closure.
  const planningCalendarEventsRef = useRef<CalendarEvent[]>(planningCalendarEvents);
  useEffect(() => {
    planningCalendarEventsRef.current = planningCalendarEvents;
  }, [planningCalendarEvents]);

  // Tracks whether App has completed a successful 30-day calendar fetch.
  // Lets get_calendar_events distinguish "connected but empty" from "not connected".
  const calendarFetchedRef = useRef<boolean>(calendarFetched);
  useEffect(() => {
    calendarFetchedRef.current = calendarFetched;
  }, [calendarFetched]);

  const maybeSendImpliedDinnerDelegation = useCallback(
    async (userId: string): Promise<void> => {
      if (hasDinnerPreparationDelegation(sentDelegationsRef.current)) return;

      const sourceText = sessionTranscriptRef.current
        .filter((entry) => entry.role === "user")
        .map((entry) => entry.message)
        .join("\n");
      const dinner = extractDinnerPreparationRequest(sourceText);
      if (!dinner) return;

      const peopleState = usePeopleStore.getState();
      if (peopleState.status === "idle" || peopleState.items.length === 0) {
        await usePeopleStore.getState().loadFor(userId);
      }

      const owner = findDinnerOwner(usePeopleStore.getState().items);
      if (!owner?.phone) return;

      if (hasDinnerPreparationDelegation(sentDelegationsRef.current)) return;

      try {
        const result = await createAndSendDelegation({
          userId,
          person: owner,
          taskText: dinner.taskText,
          message: dinner.messageText,
          ownerName: displayName,
        });
        sentDelegationsRef.current.push({
          personName: owner.name,
          taskText: dinner.taskText,
          messageText: result.messageText,
        });
        currentTaskContextRef.current = result.taskContext;
        useTasksStore.getState().loadFor(userId, { force: true }).catch(() => {});
        sessionActionsRef.current.push(`Delegated to ${owner.name}: ${dinner.taskText}`);
      } catch (err) {
        console.error("[send_delegation] implied dinner delegation failed", err);
      }
    },
    [displayName],
  );

  const savePeopleMemoryFromTranscript = useCallback(
    async (userId: string, transcript: TranscriptMessage[]): Promise<void> => {
      const peopleState = usePeopleStore.getState();
      if (peopleState.status === "idle" || peopleState.items.length === 0) {
        await usePeopleStore.getState().loadFor(userId);
      }

      const updates = extractDurablePersonMemories(
        transcript,
        usePeopleStore.getState().items,
      );
      if (updates.length === 0) return;

      for (const { person, memory } of updates) {
        try {
          await usePeopleStore.getState().update(person.id, {
            notes: mergePersonNotes(person.notes, memory),
          });
        } catch (err) {
          console.error("[people_memory] save failed", person.id, err);
        }
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: send_followup
  // ------------------------------------------------------------------
  const sendFollowup = useCallback(
    async (params: {
      name: string;
      message?: string;
      allowNewFollowup?: boolean;
    }): Promise<string> => {
      const normalizedName = extractPersonNameParam(params, "name").trim();
      const message = params?.message ?? extractMessageParam(params) ?? undefined;
      const allowNewFollowup = params?.allowNewFollowup ?? false;
      if (!normalizedName) {
        return "I did not receive a person name. Ask the user who to follow up with.";
      }

      // 1. Ensure stores are loaded before lookups
      const authUserId = useAuthStore.getState().user?.id;
      if (authUserId) {
        const peopleState = usePeopleStore.getState();
        if (peopleState.status === "idle" || peopleState.items.length === 0) {
          await usePeopleStore.getState().loadFor(authUserId);
        }
        const tasksState = useTasksStore.getState();
        if (tasksState.status === "idle" || tasksState.items.length === 0) {
          await useTasksStore.getState().loadFor(authUserId);
        }
      }

      // 2. Resolve person from People store
      const people = usePeopleStore.getState().items;
      const person = people.find(
        (p) => p.name.trim().toLowerCase() === normalizedName.toLowerCase(),
      );
      if (!person) {
        return `I could not find "${normalizedName}" in your contacts. Ask the user to add them first.`;
      }
      if (!person.phone) {
        return `${person.name} does not have a phone number saved. Ask the user to add one in People settings.`;
      }

      // 3. Duplicate guard (30-second cooldown per person)
      const cooldownKey = normalizedName.toLowerCase();
      const lastSent = lastSentRef.current.get(cooldownKey) ?? 0;
      if (Date.now() - lastSent < 30_000) {
        return `I already sent ${person.name} a follow-up just now. Wait a moment before sending again.`;
      }

      // 4. Resolve message
      let messageText = message?.trim() ?? "";
      let topicLabel = messageText || "";

      const tasks = useTasksStore.getState().items;
      const openTasks = tasks.filter(
        (t) =>
          isOpenWaitingTask(t) &&
          (t.assigned_to ?? "").trim().toLowerCase() ===
            normalizedName.toLowerCase(),
      );

      if (!messageText) {
        if (openTasks.length === 0) {
          return `I could not find an open item for ${person.name}. Ask the user what to follow up about.`;
        }
        if (openTasks.length > 1) {
          const topics = openTasks
            .slice(0, 4)
            .map((t) => topicFromDescription(t.description))
            .join(", ");
          return `I found more than one open item for ${person.name}: ${topics}. Ask the user which one to follow up on.`;
        }
        const singleTask = openTasks[0];
        messageText = buildFollowUpText(singleTask.description);
        topicLabel = topicFromDescription(singleTask.description);
      } else {
        topicLabel = topicFromDescription(messageText);
        if (!allowNewFollowup) {
          const messageLower = messageText.toLowerCase();
          const matchingOpen = openTasks.find((t) =>
            t.description.toLowerCase().includes(messageLower) ||
            messageLower.includes(topicFromDescription(t.description).toLowerCase()),
          );
          if (!matchingOpen) {
            if (openTasks.length === 0) {
              return `I do not see any open items for ${person.name}. Ask the user if they still want to send a new follow-up.`;
            }
            return `I do not see "${topicLabel}" as an open item for ${person.name}. Ask the user if they still want to send a new follow-up.`;
          }
        }
      }

      const userId = authUserId;
      if (!userId) return "You are not signed in. Please sign in and try again.";

      // 6. Create follow-up task row
      // confirmation_url is derived from a pre-generated UUID so it is set
      // atomically in the same INSERT — no second write required.
      const taskId = crypto.randomUUID();
      const confirmationUrl = `${window.location.origin}/confirm?task=${taskId}`;
      let task;
      try {
        task = await createTask({
          id: taskId,
          user_id: userId,
          description: messageText,
          type: "followup",
          assigned_to: person.name,
          status: "pending",
          needs_follow_up: true,
          confirmation_url: confirmationUrl,
          due_at: null,
        });
      } catch (err) {
        return `Could not save the follow-up task. ${sanitizeCarsonErrorDetail(err)}`;
      }

      // 8. Create message row
      let messageRecord;
      try {
        messageRecord = await createMessage({
          user_id: userId,
          task_id: task.id,
          recipient: person.name,
          content: messageText,
          confirmation_url: confirmationUrl,
        });
      } catch {
        // Non-fatal
      }

      // 9. Send via WhatsApp Cloud API
      try {
        await sendWhatsAppTask({
          to: person.phone,
          messageText,
          confirmationLink: confirmationUrl,
          messageRecordId: messageRecord?.id ?? null,
          taskId: task.id,
          recipientName: person.name,
          ownerName: displayName ?? null,
        });
      } catch (err) {
        return `Could not send the WhatsApp message to ${person.name}. ${sanitizeCarsonErrorDetail(err)}`;
      }

      lastSentRef.current.set(cooldownKey, Date.now());
      sessionActionsRef.current.push(`Sent follow-up to ${person.name} about ${topicLabel}`);
      return `${person.name} has the follow-up. I'll watch for the reply.`;
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: send_delegation
  // ------------------------------------------------------------------
  const sendDelegation = useCallback(
    async (params: {
      name: string;
      task: string;
      message?: string;
      /** Optional explicit personal/informational note — injected into the
       *  WhatsApp message body but not tracked as a separate task.
       *  Dashboard prompt should pass this when it detects phrases like
       *  "tell her I miss her", "and say thank you", "I'm on my way", etc.
       *  When absent, note is extracted from `message` as best-effort. */
      note?: string;
    }): Promise<string> => {
      const normalizedName = extractPersonNameParam(params, "name").trim();
      const message = params?.message ?? extractMessageParam(params);
      const note = params?.note;
      if (!normalizedName) {
        return "I did not receive a person name. Ask the user who to delegate to.";
      }

      const taskText = extractTaskParam(params).trim();
      if (!taskText || taskText.length < 4) {
        return "The task description is too vague. Ask the user what exactly they should do.";
      }

      // 1. Ensure stores are loaded
      const authUserId = useAuthStore.getState().user?.id;
      if (!authUserId) return "You are not signed in. Please sign in and try again.";

      const peopleState = usePeopleStore.getState();
      if (peopleState.status === "idle" || peopleState.items.length === 0) {
        await usePeopleStore.getState().loadFor(authUserId);
      }
      const tasksState = useTasksStore.getState();
      if (tasksState.status === "idle" || tasksState.items.length === 0) {
        await useTasksStore.getState().loadFor(authUserId);
      }

      // 2. Resolve person
      const people = usePeopleStore.getState().items;
      const latestUserMessageForOps = [...sessionTranscriptRef.current]
        .reverse()
        .find((m) => m.role === "user")?.message?.trim();
      // Guardrail: a guest/hosting event must NEVER execute as a direct
      // per-person delegation. The ElevenLabs agent tends to decompose a guest
      // event into several send_delegation calls (its own roster — e.g. Grace
      // "follow up", Ghulam "standby"); each such call is blocked here and
      // handed to the deterministic planner instead. This does NOT require
      // operating authority — detection alone diverts. Ordinary single-person
      // commands are not detected as outcomes and pass straight through.
      const guestAction = resolveGuestOutcomeAction(latestUserMessageForOps);
      if (latestUserMessageForOps && guestAction !== "none") {
        // Dedup a burst of per-person PROPOSE calls: reuse the plan already
        // proposed for this same utterance. (Execute is idempotent on its own.)
        if (guestAction === "propose" && pendingPlanRef.current?.sourceText === latestUserMessageForOps) {
          return pendingPlanRef.current.proposalSpeech;
        }
        const plan = await buildOperationalPlanFromOutcome(latestUserMessageForOps, people);
        if (plan) {
          if (guestAction === "execute") {
            // Operating authority → run the plan now and report the real result.
            const execSummary = await executeProposedPlan(plan, {
              displayName: displayName ?? null,
              userId: authUserId,
              people,
            });
            sessionActionsRef.current.push(`Ops plan executed: ${plan.sourceText}`);
            useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
            lastDirectToolSuccessRef.current = {
              toolName: "send_delegation",
              resultText: execSummary,
              at: new Date().toISOString(),
              inputSummary: { kind: "guest_operation_execute", instruction: latestUserMessageForOps },
            };
            return execSummary;
          }
          // No operating authority → confirm-before-send.
          pendingPlanRef.current = plan;
          lastDirectToolSuccessRef.current = {
            toolName: "send_delegation",
            resultText: plan.proposalSpeech,
            at: new Date().toISOString(),
            inputSummary: { kind: "guest_operation_reroute", instruction: latestUserMessageForOps },
          };
          return plan.proposalSpeech;
        }
        // Plan build failed — block the direct send rather than fanning out.
        return "Let me put the full plan together for that. One moment, then say yes to send it.";
      }

      const matches = people.filter(
        (p) => p.name.trim().toLowerCase() === normalizedName.toLowerCase(),
      );
      if (matches.length === 0) {
        return `I could not find "${normalizedName}" in your contacts. Ask the user to add them first.`;
      }
      if (matches.length > 1) {
        return `I found more than one person named ${normalizedName}. Ask the user to clarify which one.`;
      }
      const person = matches[0];

      const lastUserMessage = [...sessionTranscriptRef.current]
        .reverse()
        .find((m) => m.role === "user")?.message?.trim();
      const recurringSources = [
        recurringRawRef.current,
        lastUserMessage ?? null,
        taskText,
        message?.trim() ? normalizeCadenceText(message.trim()) : null,
        note?.trim() ? normalizeCadenceText(note.trim()) : null,
      ].filter((source): source is string => !!source);

      let recurringSource: string | null = null;
      let recurringSchedules: ReturnType<typeof detectAllRecurringSchedules> = [];
      for (const source of recurringSources) {
        const schedules = detectAllRecurringSchedules(source);
        if (schedules.length > 0) {
          recurringSource = source;
          recurringSchedules = schedules;
          break;
        }
      }

      if (recurringSchedules.length > 0 && recurringSource) {
        recurringRawRef.current = null;
        console.warn("[routine:LEGACY_SEND_DELEGATION_BLOCKED]", {
          name: person.name,
          taskText,
          recurringSource,
          recurringSchedules,
        });

        const recurringSourcePerson = findPersonInInstruction(recurringSource, people);
        const automationPerson = resolveRecurringAutomationPerson(recurringSource, people, person);
        const routineInstruction = recurringSourcePerson
          ? recurringSource
          : `${recurringSource} ask ${person.name} to ${taskText}`;

        // ── Get JWT once for all automation POSTs ──────────────────────────
        const { data: delSessionData } = await supabase.auth.getSession();
        const delJwt = delSessionData?.session?.access_token;
        if (!delJwt) return "You are not signed in. Please sign in and try again.";

        const results = await Promise.all(
          recurringSchedules.map(async (sched) => {
            try {
              // If the captured recurring source names a person, trust that
              // source-local person over the current tool recipient. This
              // prevents stale recurring text from being attached to an
              // unrelated one-time delegation recipient.
              const input = buildVoiceAutomationInput(routineInstruction, sched, people, automationPerson, routineInstruction);
              if (!input) {
                console.warn("[automation:SEND_DELEGATION_NO_INPUT]", { routineInstruction });
                return null;
              }
              const { assigneeId, cleanMessage, cadenceType, cadenceValue, title, summary, automationType } = input;

              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
              const [hh, mm] = (cadenceValue.time as string).split(":").map(Number);
              const todayAt = new Date();
              todayAt.setHours(hh, mm, 0, 0);
              const nextRunAt = todayAt > new Date()
                ? todayAt.toISOString()
                : new Date(todayAt.getTime() + 86_400_000).toISOString();

              const res = await fetch("/api/automations", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${delJwt}` },
                body: JSON.stringify({
                  title, instruction: cleanMessage, cadence_type: cadenceType,
                  cadence_value: cadenceValue, next_run_at: nextRunAt, timezone: tz,
                  assignee_id: assigneeId, created_by: "carson",
                  proof_required: false, proof_type: null,
                  automation_type: automationType,
                }),
              });
              if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                console.error("[automation:SEND_DELEGATION_FAILED]", err);
                return null;
              }
              const result = await res.json();
              console.log("[automation:SEND_DELEGATION_CREATED]", { id: result.automation?.id, title, cadenceType });
              return summary;
            } catch (err) {
              console.error("[automation:SEND_DELEGATION_ERROR]", err);
              return null;
            }
          }),
        );

        const successes = results.filter(Boolean) as string[];
        if (successes.length > 0) {
          sessionActionsRef.current.push(`Automation(s) created: ${routineInstruction}`);
          console.log("[automation:DISPATCH_REFRESH] dispatching ra7etbal:routine-created");
          window.dispatchEvent(new CustomEvent("ra7etbal:routine-created"));
          return successes.join(" ");
        }

        return "I detected this is a recurring instruction, but I could not create the automation. I did not create a waiting item or send a WhatsApp message.";
      }

      if (!person.phone) {
        return `${person.name} does not have a phone number saved. Ask the user to add one in People settings.`;
      }

      // 3. Cooldown. Key by person + task, not person alone, so a Daily Brief
      // can legitimately send Christopher both dinner prep and kitchen check.
      const delegationKey = normalizeDelegationKey(taskText);
      const cooldownKey = `delegation:${normalizedName.toLowerCase()}:${delegationKey}`;
      const lastSent = lastSentRef.current.get(cooldownKey) ?? 0;
      if (Date.now() - lastSent < 30_000) {
        return `I already sent ${person.name} that delegation just now. Wait a moment before sending again.`;
      }

      const userId = authUserId;

      // Snapshot pending photos — prefer live ref, fall back to session snapshot.
      const delegationPhotos =
        pendingPhotosRef.current.length > 0
          ? pendingPhotosRef.current
          : sessionPhotosRef.current;
      const delegationImageFile = delegationPhotos[0]?.file ?? null;
      const delegationImageFiles = delegationPhotos.map((p) => p.file);

      let result: DelegationSendResult;
      try {
        result = await createAndSendDelegation({
          userId,
          person,
          taskText,
          message,
          personalNote: note ?? null,
          ownerName: displayName,
          imageFile: delegationImageFile,
          imageFiles: delegationImageFiles,
        });
      } catch (err) {
        const detail = sanitizeCarsonErrorDetail(err);
        return `Could not send the delegation to ${person.name}. ${detail}`;
      }

      // Clear pending photos after successful send — covers the send_delegation path.
      if (delegationPhotos.length > 0) clearPendingImages();

      lastSentRef.current.set(cooldownKey, Date.now());
      sentDelegationsRef.current.push({
        personName: person.name,
        taskText,
        messageText: result.messageText,
      });
      currentTaskContextRef.current = result.taskContext;
      useTasksStore.getState().loadFor(userId, { force: true }).catch(() => {});
      sessionActionsRef.current.push(`Delegated to ${person.name}: ${taskText}`);

      await maybeSendImpliedDinnerDelegation(userId);

      const successText = `Done. I asked ${person.name} to ${taskText}.`;
      // Record success so the override mechanism can replace any contradictory
      // failure language Carson's LLM generates from its own separate reply.
      lastDirectToolSuccessRef.current = {
        toolName: "send_delegation",
        resultText: successText,
        at: new Date().toISOString(),
        inputSummary: { name: person.name, task: taskText },
      };

      // Inject a contextual update into EL's conversation so that status
      // questions later in the session ("Did you send it?", "Did it go through?")
      // are answered from this live fact rather than from the stale
      // {{ra7etbal_state}} snapshot (set at session-start; never refreshed
      // mid-call). Without this, EL's DATA HIERARCHY rule ("Live state overrides
      // memory") causes it to say "No, both attempts timed out" when the task
      // doesn't appear in the session-start state.
      conversationRef.current?.sendContextualUpdate(
        `[Session update] Task created and WhatsApp sent to ${person.name}: "${taskText}". ` +
        `This happened during the current session. If the user asks whether it was sent, ` +
        `confirm yes — it was sent. Do not ask whether to send it now; it has already been sent. ` +
        `Do not ask whether the user is still there.`,
      );

      return successText;
    },
    [displayName, maybeSendImpliedDinnerDelegation, clearPendingImages],
  );

  // ------------------------------------------------------------------
  // Client tool: create_reminder
  // ------------------------------------------------------------------
  const createReminder = useCallback(
    async (params: {
      description: string;
      /** Raw time phrase from the user, e.g. "tomorrow at 5 PM", "in 30 minutes". */
      time_text?: string;
      /** ISO fallback — only used when time_text is absent. */
      due_at?: string;
    }): Promise<string> => {
      const due_at = params?.due_at;
      // "description" is create_reminder's existing exact key — tried first,
      // then the same note-shaped fallbacks as save_note.
      const text = extractStringField(params, ["description", "note", "text", "content"]).trim();
      if (!text) {
        return "I did not receive a reminder description. Ask the user what they want to be reminded about.";
      }

      // ── Resolve due time ──────────────────────────────────────────────────
      // Prefer parsing the raw phrase; fall back to agent-supplied ISO only when
      // time_text is absent. This ensures "tomorrow at 5 PM" always resolves
      // using the browser's local clock, not the agent's arithmetic.
      let resolvedDueAt: string;
      const time_text = extractTimeTextParam(params);

      if (time_text?.trim()) {
        const parsed = parseVoiceTime(time_text.trim());
        if (parsed.error || !parsed.dueAt) {
          console.error(
            `[create_reminder] parseVoiceTime failed: raw="${time_text}" error="${parsed.error}"`,
          );
          return `I could not understand the time "${time_text}". Ask the user to repeat when they want to be reminded.`;
        }
        console.log(
          `[create_reminder] time resolved: raw="${time_text}" parsedAs="${parsed.parsedAs}" dueAt=${parsed.dueAt} tz=${parsed.timezone}`,
        );
        resolvedDueAt = parsed.dueAt;
      } else if (due_at) {
        const dueMs = new Date(due_at).getTime();
        if (Number.isNaN(dueMs)) {
          return "I did not receive a valid due time. Ask the user when they want to be reminded.";
        }
        console.log(`[create_reminder] using agent-supplied due_at=${due_at} (no time_text)`);
        resolvedDueAt = due_at;
      } else {
        return "I did not receive a time for the reminder. Ask the user when they want to be reminded.";
      }

      const userId = useAuthStore.getState().user?.id;
      if (!userId) return "You are not signed in. Please sign in and try again.";

      const reminderKey = normalizeReminderKey(text, resolvedDueAt);
      const existingReminderReply = createdReminderKeysRef.current.get(reminderKey);
      if (existingReminderReply) {
        console.info("[create_reminder] duplicate tool call suppressed", {
          description: text,
          dueAt: resolvedDueAt,
        });
        return existingReminderReply;
      }

      try {
        const task = await createReminderTask({
          userId,
          text,
          dueAt: resolvedDueAt,
          source: "create_reminder",
          createTaskFn: useTasksStore.getState().add,
        });
        currentTaskContextRef.current = {
          id: task.id,
          description: task.description,
          assigned_to: task.assigned_to,
          type: task.type,
        };
      } catch (err) {
        return `Could not save the reminder. ${sanitizeCarsonErrorDetail(err)}`;
      }

      // Human-readable confirmation for the agent to speak back.
      const dueDate = new Date(resolvedDueAt);
      const timeStr = dueDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const isToday =
        dueDate.toDateString() === new Date().toDateString();
      const isTomorrow =
        dueDate.toDateString() ===
        new Date(Date.now() + 86_400_000).toDateString();
      const dateLabel = isToday
        ? "today"
        : isTomorrow
        ? "tomorrow"
        : dueDate.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });

      // Prefix with CREATED: so the agent system prompt can pattern-match
      // success vs error without ambiguity.
      const reply = `I'll remind you ${dateLabel} at ${timeStr}.`;
      createdReminderKeysRef.current.set(reminderKey, reply);
      sessionActionsRef.current.push(`Created reminder: ${text} (${dateLabel} at ${timeStr})`);
      lastDirectToolSuccessRef.current = {
        toolName: "create_reminder",
        resultText: reply,
        at: new Date().toISOString(),
        inputSummary: { description: text, dueAt: resolvedDueAt },
      };
      return reply;
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: create_automation
  // Carson calls this to schedule a recurring task loop.
  // Cadence resolution is done client-side (browser clock + timezone).
  // ------------------------------------------------------------------
  const createAutomation = useCallback(
    async (params: {
      /** Short display title, e.g. "Daily kitchen check". */
      title: string;
      /** The full instruction sent to the assignee or executed as an action. */
      instruction: string;
      /**
       * Natural-language cadence, e.g. "daily", "every morning", "weekly",
       * "every Monday", "every 3 days", "monthly", "once".
       */
      cadence_phrase: string;
      /**
       * Natural-language first-run time, e.g. "tomorrow at 9 AM", "tonight",
       * "next Monday at 8 AM". Resolved via parseVoiceTime.
       */
      first_run_text: string;
      /** Optional: name of the person to assign this loop to. */
      assignee_name?: string;
      /** Whether the assignee must submit proof of completion. */
      proof_required?: boolean;
      /** Type of proof required: "photo", "confirmation", or "text". */
      proof_type?: "photo" | "confirmation" | "text" | null;
    }): Promise<string> => {
      const { cadence_phrase, first_run_text, proof_required, proof_type } = params;
      const assignee_name = params?.assignee_name ?? extractPersonNameParam(params, "assignee_name");
      const titleTrimmed = (params?.title ?? "").trim();
      // "instruction" is the existing exact key — tried first, with the same
      // task-shaped fallbacks used elsewhere (task/description/text).
      const instrTrimmed = extractAutomationInstructionParam(params).trim();
      if (!titleTrimmed) return "I did not receive a title. Ask the user what to call this automation.";
      if (!instrTrimmed) return "I did not receive an instruction. Ask the user what Carson should do.";
      if (!cadence_phrase?.trim()) return "I did not receive a cadence. Ask the user how often this should run.";
      if (!first_run_text?.trim()) return "I did not receive a first-run time. Ask the user when this should first fire.";

      // ── Resolve first run time ──────────────────────────────────────────
      const parsed = parseVoiceTime(first_run_text.trim());
      if (parsed.error || !parsed.dueAt) {
        return `I could not understand "${first_run_text}" as a time. Ask the user when this should first fire.`;
      }
      const nextRunAt = parsed.dueAt;
      const timezone = parsed.timezone;

      // ── Parse cadence phrase → (cadence_type, cadence_value) ───────────
      const raw = cadence_phrase.trim().toLowerCase();

      type CadenceType = "once" | "daily" | "weekly" | "every_n_days" | "monthly";
      let cadenceType: CadenceType = "once";
      let cadenceValue: Record<string, unknown> = {};

      if (/\bonce\b|\bone.?time\b|\bone.?off\b/.test(raw)) {
        cadenceType = "once";
      } else if (/\bdaily\b|\bevery\s+day\b|\bevery\s+morning\b|\bevery\s+night\b|\bevery\s+evening\b/.test(raw)) {
        cadenceType = "daily";
      } else if (/\bweekly\b|\bevery\s+week\b/.test(raw)) {
        cadenceType = "weekly";
      } else if (/\bmonthly\b|\bevery\s+month\b/.test(raw)) {
        cadenceType = "monthly";
      } else {
        // "every N days" / "every other day"
        const everyNMatch = raw.match(/every\s+(\d+)\s+days?/);
        const otherDay = /every\s+other\s+day/.test(raw);
        const weekdayMatch = raw.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
        if (everyNMatch) {
          cadenceType = "every_n_days";
          cadenceValue = { n: parseInt(everyNMatch[1], 10) };
        } else if (otherDay) {
          cadenceType = "every_n_days";
          cadenceValue = { n: 2 };
        } else if (weekdayMatch) {
          // Map named weekday → weekly (next_run_at already lands on correct day)
          cadenceType = "weekly";
        } else {
          // Fallback: treat unknown cadence as daily rather than fail silently
          cadenceType = "daily";
        }
      }

      // ── Store wall-clock time in cadence_value so runner can snap back ──
      // Extract HH:MM from the resolved first-run timestamp in the user's timezone.
      if (cadenceType !== "once") {
        const firstRunDate = new Date(nextRunAt);
        const timeParts = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(firstRunDate);
        const hh = timeParts.find((p) => p.type === "hour")?.value ?? "09";
        const mm = timeParts.find((p) => p.type === "minute")?.value ?? "00";
        cadenceValue = { ...cadenceValue, time: `${hh}:${mm}` };
      }

      // ── Resolve optional assignee ───────────────────────────────────────
      let assigneeId: string | null = null;
      if (assignee_name?.trim()) {
        const authUserId = useAuthStore.getState().user?.id;
        if (authUserId) {
          const peopleState = usePeopleStore.getState();
          if (peopleState.status === "idle" || peopleState.items.length === 0) {
            await usePeopleStore.getState().loadFor(authUserId);
          }
          const people = usePeopleStore.getState().items;
          const match = people.find(
            (p) => p.name.trim().toLowerCase() === assignee_name.trim().toLowerCase(),
          );
          if (!match) {
            return `I could not find "${assignee_name}" in your contacts. Ask the user to add them first, or create the automation without an assignee.`;
          }
          assigneeId = match.id;
        }
      }

      // ── POST to /api/automations ────────────────────────────────────────
      const { data: sessionData } = await supabase.auth.getSession();
      const jwt = sessionData?.session?.access_token;
      if (!jwt) return "You are not signed in. Please sign in and try again.";

      const body = {
        title: titleTrimmed,
        instruction: instrTrimmed,
        cadence_type: cadenceType,
        cadence_value: cadenceValue,
        next_run_at: nextRunAt,
        timezone,
        assignee_id: assigneeId,
        created_by: "carson",
        proof_required: proof_required === true,
        proof_type: proof_type ?? null,
      };

      let result: { automation?: { id: string; title: string } };
      try {
        const res = await fetch("/api/automations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return `I could not create that automation. ${(err as { error?: string }).error ?? "Please try again."}`;
        }
        result = await res.json();
      } catch {
        return "I could not reach the server. Please check your connection and try again.";
      }

      // ── Confirmation for Carson to speak back ───────────────────────────
      const cadenceLabel: Record<CadenceType, string> = {
        once: "once",
        daily: "daily",
        weekly: "weekly",
        every_n_days: cadenceValue.n ? `every ${cadenceValue.n} days` : "every few days",
        monthly: "monthly",
      };
      const firstRunDate = new Date(nextRunAt);
      const timeStr = firstRunDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const isToday = firstRunDate.toDateString() === new Date().toDateString();
      const isTomorrow = firstRunDate.toDateString() === new Date(Date.now() + 86_400_000).toDateString();
      const dateLabel = isToday ? "today" : isTomorrow ? "tomorrow" : firstRunDate.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });

      const assigneeLabel = assignee_name?.trim() ? ` for ${assignee_name.trim()}` : "";

      sessionActionsRef.current.push(`Created automation: ${titleTrimmed} (${cadenceLabel[cadenceType]})`);
      console.log("[create_automation] created id=", result.automation?.id, "cadence=", cadenceType);
      return `I've got that running${assigneeLabel}. First check is ${dateLabel} at ${timeStr}.`;
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: send_direct_whatsapp_message
  // Dedicated structured tool for sending a WhatsApp message directly to a
  // specific person. ElevenLabs fills recipient_name and message as typed
  // fields — no parsing, no Anthropic call, no regex. Runs entirely
  // browser-side and calls the existing /api/send-whatsapp-task route.
  // ------------------------------------------------------------------
  const sendDirectWhatsAppMessage = useCallback(
    async (params: {
      recipient_name: string;
      message: string;
    }): Promise<string> => {
      const name = extractPersonNameParam(params, "recipient_name").trim();
      const text = extractMessageParam(params).trim();

      console.log("[direct_whatsapp_tool_called]", {
        recipient_name: name,
        message_length: text.length,
      });

      if (!name || !text) {
        return "I need both a recipient name and a message to send.";
      }

      // This tool sends a plain `messages` row with no image column and no
      // taskId to scope an upload under — it cannot carry a photo. If one is
      // pending, decline so Carson retries via send_delegation, which can.
      const pendingPhotos =
        pendingPhotosRef.current.length > 0
          ? pendingPhotosRef.current
          : sessionPhotosRef.current;
      if (pendingPhotos.length > 0) {
        return "There's a photo attached, so use the delegation tool for this instead — it will include the photo. A plain message can't carry it.";
      }

      const people = usePeopleStore.getState().items;
      const person = people.find(
        (p) => p.name.trim().toLowerCase() === name.toLowerCase(),
      );

      if (!person) {
        console.warn("[direct_whatsapp_tool_failed]", {
          reason: "missing_person",
          recipient_name: name,
        });
        return `I couldn't find ${name} in your contacts.`;
      }

      console.log("[direct_whatsapp_tool_recipient_resolved]", {
        recipient_name: person.name,
        has_phone: !!person.phone?.trim(),
        opted_in: person.whatsapp_opted_in,
      });

      if (!person.phone?.trim()) {
        return `I don't have a phone number for ${person.name}.`;
      }

      if (person.whatsapp_opted_in !== true) {
        return `WhatsApp consent is not recorded for ${person.name}.`;
      }

      const userId = useAuthStore.getState().user?.id;
      if (!userId) {
        return "I couldn't verify your identity. Please try again.";
      }

      const ownerName = useProfileStore.getState().displayName ?? null;

      try {
        const { message, delivery } = await createAndSendDirectMessage({
          source: "send_direct_whatsapp_message",
          userId,
          recipient: person.name,
          messageText: text,
          phone: person.phone,
          ownerName,
          createMessageFn: createMessage,
        });
        console.log("[direct_whatsapp_tool_saved]", {
          messageRecordId: message.id,
          recipient: person.name,
        });
        console.log("[direct_whatsapp_tool_delivery_result]", {
          success: true,
          channel: delivery.channel,
          deliveryId: delivery.deliveryId,
        });
        return `It's with ${person.name}. I'll watch for the reply.`;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[direct_whatsapp_tool_failed]", {
          stage: err instanceof DirectMessageBoundaryError ? err.stage : "deliver_message",
          recipient: person.name,
          error: errMsg,
        });
        return `I couldn't send ${person.name} the message. Please try again.`;
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: save_city
  // Carson calls this when the user tells it their city for the first time.
  // Persists to profiles.weather_city so future sessions have weather.
  // ------------------------------------------------------------------
  const saveCity = useCallback(
    async (params: { city: string }): Promise<string> => {
      const trimmed = extractCityParam(params).trim();
      if (!trimmed) return "I did not receive a city name. Please ask the user again.";
      try {
        await useProfileStore.getState().saveWeatherCity(trimmed);
        return `Got it. I'll use ${trimmed} for weather from now on.`;
      } catch {
        return `I couldn't save the city. Please try again.`;
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: save_note
  // Explicit user notes and ideas. Not reminders, tasks, delegations, or
  // durable behavior rules.
  // ------------------------------------------------------------------
  const saveNote = useCallback(
    async (params: {
      note: string;
      category?: string;
    }): Promise<string> => {
      const trimmed = extractNoteParam(params).trim();
      const category = params?.category;
      if (!trimmed) {
        return "I did not receive a note. Ask the user what they want saved.";
      }

      try {
        await saveCarsonNote(trimmed, category ?? "general");
        sessionActionsRef.current.push(`Saved note: ${trimmed}`);
        return "Saved.";
      } catch {
        return "I couldn't save that note right now. Please try again.";
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: create_todo
  // Active personal commitments — "add X to my to-do list", "remind me to
  // add X to my to-do". Distinct from save_note (passive information).
  // ------------------------------------------------------------------
  const createTodoTool = useCallback(
    async (params: CreateTodoParams): Promise<string> => {
      const trimmed = extractTodoTitleParam(params).trim();
      if (!trimmed) {
        return "I did not receive a to-do title. Ask the user what to add.";
      }
      const description = extractTodoDescriptionParam(params) ?? null;

      try {
        const todo = await createTodo(trimmed, description);
        todosRef.current = [todo, ...todosRef.current];
        sessionActionsRef.current.push(`Added to-do: ${trimmed}`);
        const resultText = "Added to your to-do list.";
        // Genuine success only — recorded here, not in the generic tool
        // wrapper, so the no-title early-return above is never mistaken
        // for success by the onMessage override.
        lastDirectToolSuccessRef.current = {
          toolName: "create_todo",
          resultText,
          at: new Date().toISOString(),
          inputSummary: { title: trimmed },
        };
        return resultText;
      } catch (err) {
        const supabaseErr = err as { message?: string; code?: string; details?: string; hint?: string };
        try {
          recordCarsonDiagnostic("carson-error", {
            message: `create_todo failed: ${supabaseErr?.message ?? String(err)}`,
            detail: JSON.stringify({
              code: supabaseErr?.code,
              details: supabaseErr?.details,
              hint: supabaseErr?.hint,
              title: trimmed,
            }),
          });
        } catch {
          // diagnostic logging must never block the user-facing reply
        }
        return "I wasn't able to save that. Please say the to-do again.";
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: complete_todo
  // "Mark buy flowers done" — matches an active to-do by keyword and marks
  // it completed. To-dos are pre-loaded into todosRef at startCall — no
  // in-call network fetch for the lookup itself.
  // ------------------------------------------------------------------
  const completeTodoTool = useCallback(
    async (params: CompleteTodoParams): Promise<string> => {
      const q = extractTodoQueryParam(params).trim();
      if (!q) {
        return "I did not receive which to-do to complete. Ask the user which one they mean.";
      }

      const matches = findTodoMatches(todosRef.current, q);

      if (matches.length === 0) {
        return `I couldn't find a to-do matching "${q}". Ask the user what it's called exactly.`;
      }

      if (matches.length > 1) {
        const snippets = matches
          .slice(0, 4)
          .map((t) => `"${t.title.slice(0, 45).trim()}${t.title.length > 45 ? "…" : ""}"`)
          .join(", ");
        return `I found ${matches.length} to-dos matching "${q}": ${snippets}. Ask the user which one they mean.`;
      }

      const todo = matches[0];
      try {
        await completeTodo(todo.id);
        todosRef.current = todosRef.current.filter((t) => t.id !== todo.id);
        sessionActionsRef.current.push(`Completed to-do: ${todo.title}`);
        const resultText = "Done. I've marked that complete.";
        lastDirectToolSuccessRef.current = {
          toolName: "complete_todo",
          resultText,
          at: new Date().toISOString(),
          inputSummary: { title: todo.title },
        };
        return resultText;
      } catch {
        return "I couldn't mark that to-do complete right now. Please try again.";
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: control_task
  // Owner-side control for existing Ra7etBal tasks: mark done or delete.
  // Uses the same store actions as the Updates UI, so reminder push
  // cancellation and optimistic state behavior stay unchanged.
  // ------------------------------------------------------------------
  const controlTaskTool = useCallback(
    async (params: {
      instruction?: string;
      query?: string;
      text?: string;
      description?: string;
      action?: "mark_done" | "delete" | string;
      task_id?: string;
    }): Promise<string> => {
      const taskId = params?.task_id?.trim();
      const rawInstruction = extractStringField(params, [
        "instruction",
        "query",
        "text",
        "description",
      ]).trim();
      const actionParam = params?.action?.trim();

      const tasksStore = useTasksStore.getState();
      const authUserId = useAuthStore.getState().user?.id;
      if (!authUserId) return "You are not signed in. Please sign in and try again.";
      if (tasksStore.status === "idle" || tasksStore.items.length === 0) {
        await tasksStore.loadFor(authUserId, { force: true });
      }
      const latestTasksStore = useTasksStore.getState();
      try {
        const result = await executeVoiceTaskControl({
          rawText: rawInstruction,
          tasks: latestTasksStore.items,
          currentTask: currentTaskContextRef.current,
          taskId,
          action: actionParam,
          markDoneTask: (task) => latestTasksStore.markDone(task.id),
          deleteTask: (task) => latestTasksStore.remove(task.id),
        });
        if (!result.handled) return "Which task should I update?";

        if (result.action === "delete" && result.task) {
          currentTaskContextRef.current = null;
          sessionActionsRef.current.push(`Deleted ${result.task.type === "reminder" ? "reminder" : "task"}: ${result.task.description}`);
          lastDirectToolSuccessRef.current = {
            toolName: "control_task",
            resultText: result.reply,
            at: new Date().toISOString(),
            inputSummary: { action: "delete", taskId: result.task.id, description: result.task.description },
          };
          return result.reply;
        }

        if (result.action === "mark_done" && result.task) {
          currentTaskContextRef.current = null;
          sessionActionsRef.current.push(`Marked ${result.task.type === "reminder" ? "reminder" : "task"} done: ${result.task.description}`);
          lastDirectToolSuccessRef.current = {
            toolName: "control_task",
            resultText: result.reply,
            at: new Date().toISOString(),
            inputSummary: { action: "mark_done", taskId: result.task.id, description: result.task.description },
          };
        }
        return result.reply;
      } catch {
        return "I couldn't update that task right now. Please try again.";
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: get_calendar_events
  // On-demand calendar access for wider ranges (today, tomorrow, this_week,
  // next_week, next_7_days, next_10_days, next_14_days, next_30_days).
  // Returns a plain-text event list Carson can read aloud.
  // ------------------------------------------------------------------
  const validCalendarRanges: CalendarRange[] = [
    "today", "tomorrow", "this_week", "next_week",
    "next_7_days", "next_10_days", "next_14_days", "next_30_days",
  ];

  const getCalendarEvents = useCallback(
    async (params: any): Promise<string> => {
      try {
        const range = params?.range ?? "";
        const safeRange: CalendarRange = (validCalendarRanges as string[]).includes(range)
          ? (range as CalendarRange)
          : "today";
        const cached = planningCalendarEventsRef.current;
        // If the 30-day fetch has never succeeded (not connected or not yet run),
        // tell Carson to prompt the user to connect Google Calendar in Settings.
        // If fetch succeeded but returned zero events, say "no events" instead —
        // not "connect Google Calendar" (calendar IS connected, just empty).
        if (!calendarFetchedRef.current) {
          return "No calendar events are loaded. If Google Calendar is not connected, the user should connect it in Settings.";
        }
        if (!cached || cached.length === 0) return "No events found in the next 30 days.";
        const filtered = filterCalendarEventsByRange(cached, safeRange);
        if (filtered.length === 0) return "No events found for that period.";
        return filtered
          .map((ev) => {
            const start = ev.start ? new Date(ev.start) : null;
            const end = ev.end ? new Date(ev.end) : null;
            const dateStr = start
              ? start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
              : "";
            const timeStr = ev.allDay
              ? "All day"
              : start
                ? start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                : "";
            // Suppress end time when duration is exactly 60 minutes — that is
            // the create_calendar_event default for unspecified durations, so
            // showing it would make "dentist at 11" read as "dentist 11–12".
            // Explicit longer durations (90 min, 2 h, etc.) are still shown.
            const durationMs = start && end ? end.getTime() - start.getTime() : null;
            const isDefaultDuration = durationMs === 60 * 60 * 1000;
            const endStr =
              !ev.allDay && end && !isDefaultDuration
                ? `–${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                : "";
            const locStr = ev.location ? ` (${ev.location})` : "";
            // Embed event_id so Carson can pass it to update/delete tools.
            // Format: [event_id:xxx] — Carson is instructed never to read this aloud.
            return `${dateStr} ${timeStr}${endStr}: ${ev.title}${locStr} [event_id:${ev.id}]`;
          })
          .join("\n");
      } catch {
        return "I couldn't fetch calendar events right now.";
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: create_calendar_event
  // Creates a Google Calendar event on the user's primary calendar.
  // Carson must confirm with the user before calling this tool.
  // Returns a plain-English result string Carson reads aloud.
  // ------------------------------------------------------------------
  const createCalendarEvent = useCallback(
    async (params: any): Promise<string> => {
      try {
        // Debug: log tool invocation with param keys and title length only (no content)
        console.log("[calendar-create-debug] tool called paramKeys=%s titleLen=%d dateVal=%s timeVal=%s",
          Object.keys(params ?? {}).join(","),
          String(params?.title ?? "").length,
          params?.date ?? "none",
          params?.time ?? "none",
        );

        const title: string = extractCalendarTitleParam(params).trim();
        const date: string  = (params?.date  ?? "").trim();
        const time: string  = (params?.time  ?? "").trim();
        const durationMinutes: number = Number(params?.duration_minutes) > 0
          ? Number(params.duration_minutes)
          : 60;
        // "description" can double as the title fallback above — don't also
        // duplicate it as the event description in that case.
        const descriptionRaw: string = (params?.description ?? "").trim();
        const description: string = descriptionRaw === title ? "" : descriptionRaw;

        if (!title || !date || !time) {
          console.log("[calendar-create-debug] client validation failed missing fields title=%s date=%s time=%s",
            Boolean(title), Boolean(date), Boolean(time));
          return "I need the event title, date, and time before I can add it to your calendar.";
        }

        // Validate formats before hitting the API
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return "I couldn't parse the date. Please say the date clearly and try again.";
        }
        if (!/^\d{2}:\d{2}$/.test(time)) {
          return "I couldn't parse the time. Please say the time clearly and try again.";
        }

        // ── Conflict detection ──────────────────────────────────────────────
        // Runs before the POST so no Google API call is made on a conflict.
        // Skipped when the user has explicitly approved adding despite a clash.
        const forceCreate = Boolean(params?.override_conflict);

        if (!forceCreate) {
          const propStart = new Date(`${date}T${time}:00`).getTime();
          const propEnd   = propStart + durationMinutes * 60_000;

          if (!Number.isNaN(propStart)) {
            const conflicts = planningCalendarEventsRef.current.filter((ev) => {
              if (ev.allDay || !ev.start) return false;
              const evStart = new Date(ev.start).getTime();
              if (Number.isNaN(evStart)) return false;
              const evEnd = ev.end
                ? new Date(ev.end).getTime()
                : evStart + 60 * 60_000; // treat no-end as 60-min block
              if (Number.isNaN(evEnd)) return false;
              // Exclusive boundary overlap — back-to-back events are not conflicts
              return propStart < evEnd && propEnd > evStart;
            });

            if (conflicts.length > 0) {
              const names = conflicts
                .map((ev) => {
                  const t = ev.start
                    ? new Date(ev.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                    : "";
                  return `${ev.title}${t ? ` at ${t}` : ""}`;
                })
                .join(", ");
              return `Conflict found: ${names} is already on the calendar at that time. Ask ${displayName ?? "the user"} if they still want to add this. If yes, call create_calendar_event again with override_conflict: true.`;
            }
          }
        }
        // ── End conflict detection ──────────────────────────────────────────

        const body: Record<string, unknown> = { title, date, time, duration_minutes: durationMinutes };
        if (description) body.description = description;

        const result = await callCalendarApi("POST", body);
        console.log("[calendar-create-debug] server response ok=%s code=%s",
          result.data?.ok ?? "null", (result.data?.code as string | undefined) ?? result.code ?? "none");
        if (result.code === "unauthenticated") return "You're not signed in. Please sign in and try again.";
        const data = result.data as Record<string, any> | null;
        if (!data) return "Something went wrong. Please try again.";

        if (!data.ok) {
          if (data.code === "reconnect_required") {
            return "I couldn't add that because Google Calendar needs to be reconnected in Settings to allow event creation.";
          }
          if (data.code === "missing_fields") {
            return "I need the event title, date, and time before I can add it.";
          }
          return "I couldn't add the event to your calendar. Please try again.";
        }

        // Format the confirmation string Carson reads aloud
        const startDate = data.start ? new Date(data.start) : null;
        const timeLabel = startDate
          ? startDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : time;
        const dateLabel = startDate
          ? startDate.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })
          : date;

        // Append to in-session planning cache so get_calendar_events sees the
        // new event immediately — no re-fetch needed for same-session queries.
        planningCalendarEventsRef.current = [
          ...planningCalendarEventsRef.current,
          {
            id: data.id ?? crypto.randomUUID(),
            title: data.title,
            start: data.start ?? null,
            end: data.end ?? null,
            location: null,
            allDay: false,
          } satisfies CalendarEvent,
        ];

        sessionActionsRef.current.push(
          `Created calendar event: ${data.title} (${dateLabel} at ${timeLabel})`,
        );

        return `Added ${data.title} to your Google Calendar — ${dateLabel} at ${timeLabel}.`;
      } catch {
        return "I couldn't add the event to your calendar right now. Please try again.";
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: update_calendar_event
  // Moves, renames, or reschedules an existing Google Calendar event.
  // Uses the event_id embedded by get_calendar_events in [event_id:xxx] format.
  // Preserves duration unless duration_minutes is explicitly provided.
  // After success, updates planningCalendarEventsRef so conflict detection stays accurate.
  // ------------------------------------------------------------------
  const updateCalendarEventTool = useCallback(
    async (params: any): Promise<string> => {
      try {
        console.log("[calendar:update_tool_called] event_id=%s title=%s date=%s time=%s",
          params?.event_id ?? "none",
          params?.title ?? "none",
          params?.date ?? "none",
          params?.time ?? "none",
        );
        const eventId: string = extractEventIdParam(params).trim();
        if (!eventId) {
          return "I need the event ID to update it. Please call get_calendar_events first to find the event.";
        }

        const patch: Record<string, string | number> = {};
        if (params?.title) patch.title = String(params.title).trim();
        if (params?.date) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params.date))) {
            return "I couldn't parse the date. Please use YYYY-MM-DD format.";
          }
          patch.date = String(params.date);
        }
        if (params?.time) {
          if (!/^\d{2}:\d{2}$/.test(String(params.time))) {
            return "I couldn't parse the time. Please use HH:MM 24-hour format.";
          }
          patch.time = String(params.time);
        }
        if (Number(params?.duration_minutes) > 0) {
          patch.duration_minutes = Number(params.duration_minutes);
        }

        if (Object.keys(patch).length === 0) {
          return "I need something to change — a new title, date, or time.";
        }

        const result = await callCalendarApi("PATCH", { event_id: eventId, ...patch });
        console.log("[calendar:update_tool_called] backend_ok=%s code=%s",
          result.data?.ok, (result.data?.code as string | undefined) ?? result.code ?? "none");
        if (result.code === "unauthenticated") return "You're not signed in. Please sign in and try again.";
        const data = result.data as Record<string, any> | null;
        if (!data) return "I couldn't update that event. Please try again.";

        if (!data.ok) {
          if (data.code === "reconnect_required") {
            return "Google Calendar needs to be reconnected in Settings.";
          }
          if (data.code === "not_found") {
            return "I couldn't find that event on your calendar. It may have already been deleted.";
          }
          return "I couldn't update that event. Please try again.";
        }

        // Mutate the in-session cache so conflict detection and get_calendar_events stay accurate
        planningCalendarEventsRef.current = planningCalendarEventsRef.current.map((ev) =>
          ev.id === eventId
            ? ({
                ...ev,
                title: data.title ?? ev.title,
                start: data.start ?? ev.start,
                end:   data.end   ?? ev.end,
              } satisfies CalendarEvent)
            : ev,
        );

        // Spoken confirmation
        const newStart = data.start ? new Date(data.start) : null;
        const timeLabel = newStart
          ? newStart.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : "";
        const dateLabel = newStart
          ? newStart.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })
          : "";

        const parts: string[] = [];
        if (dateLabel) parts.push(`for ${dateLabel}`);
        if (timeLabel) parts.push(`at ${timeLabel}`);

        sessionActionsRef.current.push(
          `Updated calendar event: ${data.title}${parts.length ? ` (${parts.join(" ")})` : ""}`,
        );

        return `${data.title} is on your calendar${parts.length ? " " + parts.join(" ") : ""}.`;
      } catch {
        return "I couldn't update that event right now. Please try again.";
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: delete_calendar_event
  // Deletes an existing Google Calendar event by event_id.
  // SAFETY: Only call when the user has explicitly said delete, cancel, or remove.
  // After success, removes the event from planningCalendarEventsRef.
  // ------------------------------------------------------------------
  const deleteCalendarEventTool = useCallback(
    async (params: any): Promise<string> => {
      try {
        console.log("[calendar:delete_tool_called] event_id=%s", params?.event_id ?? "none");
        const eventId: string = extractEventIdParam(params).trim();
        if (!eventId) {
          return "I need the event ID to delete it. Please call get_calendar_events first to find the event.";
        }

        // Capture the event title for the confirmation message before removing from cache
        const eventEntry = planningCalendarEventsRef.current.find((ev) => ev.id === eventId);
        const eventTitle = eventEntry?.title ?? "that event";

        const result = await callCalendarApi("DELETE", { event_id: eventId });
        console.log("[calendar:delete_tool_called] backend_ok=%s code=%s",
          result.data?.ok, (result.data?.code as string | undefined) ?? result.code ?? "none");
        if (result.code === "unauthenticated") return "You're not signed in. Please sign in and try again.";
        const data = result.data as Record<string, any> | null;
        if (!data) return "I couldn't delete that event. Please try again.";

        if (!data.ok) {
          if (data.code === "reconnect_required") {
            return "Google Calendar needs to be reconnected in Settings.";
          }
          if (data.code === "not_found") {
            // Already gone — still remove from local cache
            planningCalendarEventsRef.current = planningCalendarEventsRef.current.filter(
              (ev) => ev.id !== eventId,
            );
            return `${eventTitle} is off your calendar.`;
          }
          return "I couldn't delete that event. Please try again.";
        }

        // Remove from in-session cache so conflict detection and get_calendar_events stay accurate
        planningCalendarEventsRef.current = planningCalendarEventsRef.current.filter(
          (ev) => ev.id !== eventId,
        );

        sessionActionsRef.current.push(`Deleted calendar event: ${eventTitle}`);

        return `${eventTitle} is off your calendar.`;
      } catch {
        return "I couldn't delete that event right now. Please try again.";
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: act_on_note
  // Execute an action (task / reminder / delegate / calendar) on a saved note
  // matched by keyword. Returns a spoken confirmation or clarification string.
  // Notes are pre-loaded into notesRef at startCall — no in-call network fetch.
  // Defined after createCalendarEvent so the calendar branch can call it directly.
  // ------------------------------------------------------------------
  const actOnNote = useCallback(
    async (params: {
      /** Keyword(s) to match against note text — case-insensitive substring. */
      query: string;
      action: "task" | "reminder" | "delegate" | "calendar";
      /** Required for reminder + calendar. Raw time phrase as spoken, e.g. "tomorrow at 5pm". */
      time_text?: string;
      /** Required for delegate. Exact person name. */
      person_name?: string;
    }): Promise<string> => {
      const { action } = params;
      const time_text = extractTimeTextParam(params);
      const person_name = params?.person_name ?? extractPersonNameParam(params, "person_name");
      const q = extractQueryParam(params).trim();
      if (!q) {
        return "I did not receive a search term. Ask the user which note they mean.";
      }

      // ── Note lookup ──────────────────────────────────────────────────────────
      const matches = notesRef.current.filter((n) =>
        n.note.toLowerCase().includes(q.toLowerCase()),
      );

      if (matches.length === 0) {
        return `I couldn't find a note matching "${q}". Ask the user what the note says exactly.`;
      }

      if (matches.length > 1) {
        const snippets = matches
          .slice(0, 4)
          .map((n) => `"${n.note.slice(0, 45).trim()}${n.note.length > 45 ? "…" : ""}"`)
          .join(", ");
        return `I found ${matches.length} notes matching "${q}": ${snippets}. Ask the user which one they mean.`;
      }

      const note = matches[0];
      const authUserId = useAuthStore.getState().user?.id;
      if (!authUserId) return "You are not signed in. Please sign in and try again.";

      // ── task ────────────────────────────────────────────────────────────────
      if (action === "task") {
        try {
          const task = await createTask({
            user_id: authUserId,
            description: note.note,
            type: "action",
            assigned_to: null,
            status: "pending",
            needs_follow_up: false,
            confirmation_url: null,
            due_at: null,
          });
          useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
          sessionActionsRef.current.push(`Turned note into task: ${note.note}`);
          console.log("[act_on_note] task created from note:", task.id);
          return "I've got that on your list.";
        } catch (err) {
          return `Couldn't create the task. ${sanitizeCarsonErrorDetail(err)}`;
        }
      }

      // ── reminder ────────────────────────────────────────────────────────────
      if (action === "reminder") {
        const phrase = time_text?.trim();
        if (!phrase) {
          return "I need to know when to remind you. Ask the user for a time.";
        }
        const parsed = parseVoiceTime(phrase);
        if (parsed.error || !parsed.dueAt) {
          return `I couldn't understand the time "${phrase}". Ask the user to say when they want the reminder.`;
        }
        try {
          const task = await createReminderTask({
            userId: authUserId,
            text: note.note,
            dueAt: parsed.dueAt,
            source: "act_on_note",
          });
          useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
          currentTaskContextRef.current = {
            id: task.id,
            description: task.description,
            assigned_to: task.assigned_to,
            type: task.type,
          };
          sessionActionsRef.current.push(`Set reminder from note: ${note.note}`);
          const d = new Date(parsed.dueAt);
          const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          const isToday = d.toDateString() === new Date().toDateString();
          const isTomorrow =
            d.toDateString() === new Date(Date.now() + 86_400_000).toDateString();
          const dateLabel = isToday
            ? "today"
            : isTomorrow
            ? "tomorrow"
            : d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
          console.log("[act_on_note] reminder created:", task.id, parsed.dueAt);
          return `I'll remind you ${dateLabel} at ${timeStr}.`;
        } catch (err) {
          return `Couldn't set the reminder. ${sanitizeCarsonErrorDetail(err)}`;
        }
      }

      // ── delegate ────────────────────────────────────────────────────────────
      if (action === "delegate") {
        const personNameInput = person_name?.trim();
        if (!personNameInput) {
          return "I need to know who to delegate this to. Ask the user for a name.";
        }

        // Ensure people store is loaded.
        const peopleState = usePeopleStore.getState();
        if (peopleState.status === "idle" || peopleState.items.length === 0) {
          await usePeopleStore.getState().loadFor(authUserId);
        }
        const people = usePeopleStore.getState().items;
        const person = people.find(
          (p) => p.name.trim().toLowerCase() === personNameInput.toLowerCase(),
        );
        if (!person) {
          return `I couldn't find "${personNameInput}" in your contacts. Ask the user to add them first.`;
        }
        if (!person.phone) {
          return `${person.name} has no phone number saved. Ask the user to add one in People settings.`;
        }

        try {
          const result = await createAndSendDelegation({
            userId: authUserId,
            person,
            taskText: note.note,
            ownerName: displayName,
          });
          useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
          currentTaskContextRef.current = result.taskContext;
          sessionActionsRef.current.push(`Delegated note to ${person.name}: ${note.note}`);
          console.log("[act_on_note] delegation sent:", result.taskId, "→", person.name);
          return `${person.name} has it. I'll follow up if needed.`;
        } catch (err) {
          return `Couldn't send the delegation. ${sanitizeCarsonErrorDetail(err)}`;
        }
      }

      // ── calendar ────────────────────────────────────────────────────────────
      if (action === "calendar") {
        const phrase = time_text?.trim();
        if (!phrase) {
          return "I need a date and time. Ask the user when to add this to the calendar.";
        }
        const parsed = parseVoiceTime(phrase);
        if (parsed.error || !parsed.dueAt) {
          return `I couldn't understand "${phrase}". Ask the user to say the date and time clearly.`;
        }
        const d = new Date(parsed.dueAt);
        const pad = (n: number) => String(n).padStart(2, "0");
        // Delegate to the existing createCalendarEvent callback which handles
        // JWT auth, conflict detection, and cache update.
        return createCalendarEvent({
          title: note.note,
          date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
          time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        });
      }

      return "I don't know how to perform that action on a note. Ask the user to clarify.";
    },
    [displayName, createCalendarEvent],
  );

  // ------------------------------------------------------------------
  // Client tool: list_inbox_items
  //
  // Carson Inbox Review V1 — read-only. Lists the user's Clear My Head
  // Inbox (clear_my_head_inbox), summarizes it, and suggests conversion
  // options. Never converts or deletes anything itself — the prompt must
  // speak this return verbatim and wait for the user to say what they want
  // done with a specific item before calling act_on_inbox_item.
  // ------------------------------------------------------------------
  const getInboxItems = useCallback(async (): Promise<string> => {
    const items = await listClearMyHeadInboxItems(20);
    if (items.length === 0) {
      return "Your inbox is empty.";
    }
    const lines = items.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
    const count = items.length === 1 ? "1 inbox item" : `${items.length} inbox items`;
    return (
      `You have ${count}:\n${lines}\n\n` +
      "I can help turn these into a note, to-do, reminder, delegation, message, or delete them. " +
      "What do you want me to do first?"
    );
  }, []);

  // ------------------------------------------------------------------
  // Client tool: act_on_inbox_item
  //
  // Carson Inbox Review V1 — converts (or deletes) exactly one Clear My
  // Head Inbox item, once the user has said what they want done with it.
  // Mirrors act_on_note's keyword-lookup + dispatch-by-action shape exactly,
  // reusing the same underlying save/create/send functions as every other
  // Carson conversion path — no new storage, no new confirmation state
  // machine. On success the item is removed from the inbox (it "became"
  // the new object); on any missing input or failure, nothing is created,
  // sent, or deleted, and the inbox item is left untouched.
  // ------------------------------------------------------------------
  const actOnInboxItem = useCallback(
    async (params: {
      /** Keyword(s) to match against inbox item text — case-insensitive substring. */
      query: string;
      action: "note" | "todo" | "reminder" | "delegate" | "message" | "delete";
      /** Required for reminder. Raw time phrase as spoken, e.g. "tomorrow at 9am". */
      time_text?: string;
      /** Required for delegate + message. Exact person name. */
      person_name?: string;
    }): Promise<string> => {
      const { action } = params;
      const time_text = extractTimeTextParam(params);
      const person_name = params?.person_name ?? extractPersonNameParam(params, "person_name");
      const q = extractQueryParam(params).trim();
      if (!q) {
        return "I did not receive a search term. Ask the user which inbox item they mean.";
      }

      // ── Inbox item lookup ────────────────────────────────────────────────
      const items = await listClearMyHeadInboxItems(100);
      const matches = items.filter((item) => item.text.toLowerCase().includes(q.toLowerCase()));

      if (matches.length === 0) {
        return `I couldn't find an inbox item matching "${q}". Ask the user what it says exactly.`;
      }

      if (matches.length > 1) {
        const snippets = matches
          .slice(0, 4)
          .map((item) => `"${item.text.slice(0, 45).trim()}${item.text.length > 45 ? "…" : ""}"`)
          .join(", ");
        return `I found ${matches.length} inbox items matching "${q}": ${snippets}. Ask the user which one they mean.`;
      }

      const item = matches[0];
      const authUserId = useAuthStore.getState().user?.id;
      if (!authUserId) return "You are not signed in. Please sign in and try again.";

      // ── note ─────────────────────────────────────────────────────────────
      // Duplicate check first: never create a second note for the same
      // thought. On a match, the inbox item is left untouched — no delete,
      // no create — so the user can still decide what to do with it.
      if (action === "note") {
        try {
          const existingNotes = await loadRecentNotes(100);
          const dupes = findNoteMatches(existingNotes, item.text);
          if (dupes.length > 0) {
            sessionActionsRef.current.push(`Inbox note skipped as duplicate: ${item.text}`);
            return `You already have a note that says "${dupes[0].note}". I've left it in your inbox — say delete if you want it gone.`;
          }
          await saveCarsonNote(item.text, "general");
          await deleteClearMyHeadInboxItem(item.id);
          sessionActionsRef.current.push(`Turned inbox item into note: ${item.text}`);
          return "Saved as a note.";
        } catch (err) {
          return `Couldn't save that as a note. ${sanitizeCarsonErrorDetail(err)}`;
        }
      }

      // ── todo ─────────────────────────────────────────────────────────────
      // Duplicate check first: never create a second to-do for the same
      // thought. On a match, the inbox item is left untouched — no delete,
      // no create — so the user can still decide what to do with it.
      if (action === "todo") {
        try {
          const existingTodos = await listActiveTodos(100);
          const dupes = findTodoMatches(existingTodos, item.text);
          if (dupes.length > 0) {
            sessionActionsRef.current.push(`Inbox to-do skipped as duplicate: ${item.text}`);
            return `You already have "${dupes[0].title}" on your to-do list. I've left it in your inbox — say delete if you want it gone.`;
          }
          await createTodo(item.text);
          await deleteClearMyHeadInboxItem(item.id);
          sessionActionsRef.current.push(`Turned inbox item into to-do: ${item.text}`);
          return "Added to your to-do list.";
        } catch (err) {
          return `Couldn't add that to your to-do list. ${sanitizeCarsonErrorDetail(err)}`;
        }
      }

      // ── reminder ─────────────────────────────────────────────────────────
      if (action === "reminder") {
        const phrase = time_text?.trim();
        if (!phrase) {
          return "I need to know when to remind you. Ask the user for a time.";
        }
        const parsed = parseVoiceTime(phrase);
        if (parsed.error || !parsed.dueAt) {
          return `I couldn't understand the time "${phrase}". Ask the user to say when they want the reminder.`;
        }
        try {
          const task = await createReminderTask({
            userId: authUserId,
            text: item.text,
            dueAt: parsed.dueAt,
            source: "clear_my_head_inbox",
          });
          // Intentionally does NOT delete the source inbox item — a
          // reminder is a nudge to revisit later, not proof the underlying
          // thought is resolved. The item stays until the user explicitly
          // deletes it or converts it into something else.
          useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
          currentTaskContextRef.current = {
            id: task.id,
            description: task.description,
            assigned_to: task.assigned_to,
            type: task.type,
          };
          sessionActionsRef.current.push(`Set reminder from inbox item: ${item.text}`);
          const d = new Date(parsed.dueAt);
          const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          const isToday = d.toDateString() === new Date().toDateString();
          const isTomorrow =
            d.toDateString() === new Date(Date.now() + 86_400_000).toDateString();
          const dateLabel = isToday
            ? "today"
            : isTomorrow
            ? "tomorrow"
            : d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
          return `I'll remind you ${dateLabel} at ${timeStr}. I've kept it in your inbox too.`;
        } catch (err) {
          return `Couldn't set the reminder. ${sanitizeCarsonErrorDetail(err)}`;
        }
      }

      // ── delegate ─────────────────────────────────────────────────────────
      if (action === "delegate") {
        const personNameInput = person_name?.trim();
        if (!personNameInput) {
          return "I need to know who to delegate this to. Ask the user for a name.";
        }
        const peopleState = usePeopleStore.getState();
        if (peopleState.status === "idle" || peopleState.items.length === 0) {
          await usePeopleStore.getState().loadFor(authUserId);
        }
        const people = usePeopleStore.getState().items;
        const person = people.find(
          (p) => p.name.trim().toLowerCase() === personNameInput.toLowerCase(),
        );
        if (!person) {
          return `I couldn't find "${personNameInput}" in your contacts. Ask the user to add them first.`;
        }
        if (!person.phone) {
          return `${person.name} has no phone number saved. Ask the user to add one in People settings.`;
        }
        try {
          const result = await createAndSendDelegation({
            userId: authUserId,
            person,
            taskText: item.text,
            ownerName: displayName,
          });
          await deleteClearMyHeadInboxItem(item.id);
          useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
          currentTaskContextRef.current = result.taskContext;
          sessionActionsRef.current.push(`Delegated inbox item to ${person.name}: ${item.text}`);
          return `${person.name} has it. I'll follow up if needed.`;
        } catch (err) {
          return `Couldn't send the delegation. ${sanitizeCarsonErrorDetail(err)}`;
        }
      }

      // ── message ──────────────────────────────────────────────────────────
      // Task-like text ("Confirm the menu.", "Call Grace.") must not become
      // a bare direct message — that path has no confirmation link and no
      // follow-up/escalation coverage. Ask instead of silently converting it.
      if (action === "message") {
        if (looksLikeTaskInstruction(item.text)) {
          return `"${item.text}" reads like something you want done, not just an FYI. Ask the user if they mean to delegate it as a task instead — only send it as a plain message if they confirm that's really what they want.`;
        }
        const personNameInput = person_name?.trim();
        if (!personNameInput) {
          return "I need to know who to send this message to. Ask the user for a name.";
        }
        const peopleState = usePeopleStore.getState();
        if (peopleState.status === "idle" || peopleState.items.length === 0) {
          await usePeopleStore.getState().loadFor(authUserId);
        }
        const people = usePeopleStore.getState().items;
        const person = people.find(
          (p) => p.name.trim().toLowerCase() === personNameInput.toLowerCase(),
        );
        if (!person) {
          return `I couldn't find "${personNameInput}" in your contacts. Ask the user to add them first.`;
        }
        if (!person.phone?.trim()) {
          return `I don't have a phone number for ${person.name}.`;
        }
        if (person.whatsapp_opted_in !== true) {
          return `WhatsApp consent is not recorded for ${person.name}.`;
        }
        try {
          await createAndSendDirectMessage({
            source: "clear_my_head_inbox",
            userId: authUserId,
            recipient: person.name,
            messageText: item.text,
            phone: person.phone,
            ownerName: displayName,
            createMessageFn: createMessage,
          });
          await deleteClearMyHeadInboxItem(item.id);
          sessionActionsRef.current.push(`Sent inbox item as a message to ${person.name}: ${item.text}`);
          return `It's with ${person.name}.`;
        } catch (err) {
          return `Couldn't send that message. ${sanitizeCarsonErrorDetail(err)}`;
        }
      }

      // ── delete ───────────────────────────────────────────────────────────
      if (action === "delete") {
        try {
          await deleteClearMyHeadInboxItem(item.id);
          sessionActionsRef.current.push(`Deleted inbox item: ${item.text}`);
          return "Deleted from your inbox.";
        } catch (err) {
          return `Couldn't delete that. ${sanitizeCarsonErrorDetail(err)}`;
        }
      }

      return "I don't know how to perform that action on an inbox item. Ask the user to clarify.";
    },
    [displayName],
  );

  const runDirectToolWithDiagnostic = useCallback(
    async <TResult,>(
      toolName: string,
      input: unknown,
      runTool: () => Promise<TResult>,
    ): Promise<TResult> => {
      const startedAt = new Date().toISOString();
      const startedPerf = performance.now();
      try {
        const result = await runTool();
        try {
          recordCarsonDiagnostic(
            "carson-direct-tool",
            buildCarsonDirectToolDiagnosticEvent({
              toolName,
              startedAt,
              durationMs: performance.now() - startedPerf,
              success: true,
              result,
              input,
            }),
          );
        } catch (diagnosticErr) {
          console.warn("[carson_direct_tool:DIAGNOSTIC_ERROR]", diagnosticErr);
        }
        // NOTE: do not record lastDirectToolSuccessRef here — a string return
        // from runTool() only means the tool didn't throw, not that it
        // genuinely succeeded (createTodoTool's "no title received" early
        // return is also a string). create_todo/complete_todo record their
        // own override-eligible success directly, only on their real
        // success path, right before returning.
        return typeof result === "string" ? (sanitizeCarsonReplyText(result) as TResult) : result;
      } catch (err) {
        try {
          recordCarsonDiagnostic(
            "carson-direct-tool",
            buildCarsonDirectToolDiagnosticEvent({
              toolName,
              startedAt,
              durationMs: performance.now() - startedPerf,
              success: false,
              input,
              error: err,
            }),
          );
        } catch (diagnosticErr) {
          console.warn("[carson_direct_tool:DIAGNOSTIC_ERROR]", diagnosticErr);
        }
        throw err;
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Shared delegation/message pipeline
  //
  // execute_instruction is the PREFERRED tool for Voice Carson delegation
  // and messaging. It routes through the same extraction pipeline as Text
  // Carson (extractItems → savePending → sendWhatsAppTask), so both
  // channels produce identical output for the same raw instruction.
  //
  // Architecture:
  //   spoken instruction
  //   → execute_instruction(instruction)
  //   → executeDelegationFromText (shared with Text Carson)
  //   → extractItems (Claude Sonnet, full classify rules, anti-split rules)
  //   → savePending  (tasks + messages → Supabase)
  //   → sendWhatsAppTask (one send per message row)
  //
  // send_delegation is kept as a fallback for simple pre-classified
  // cases that the ElevenLabs dashboard prompt may still emit. For any
  // compound instruction ("ask X to … and tell her …"), Voice Carson's
  // dashboard prompt must call execute_instruction with the raw user
  // quote so the classification is handled by the shared Claude pipeline.
  // ------------------------------------------------------------------
  const executeInstruction = useCallback(
    async (params?: ExecuteInstructionParams): Promise<string> => {
      const instruction = extractInstructionParam(params);
      console.log("[executeInstruction:PARAMS]", params);

      // Prefer the verbatim user transcript (lastUserMessage) over the
      // agent-provided instruction param — EL may rephrase, losing personal notes
      // or altering names. EXCEPTION: fall back to the instruction param when
      // lastUserMessage is a short confirmatory reply ("yes", "go ahead",
      // "yes, send it" ≤ 5 words) — those come after Carson rephrases the task
      // and do not contain the full delegation context (e.g. the recipient name).
      const lastUserMessage = [...sessionTranscriptRef.current]
        .reverse()
        .find((m) => m.role === "user")?.message?.trim();
      const lastUserWordCount = lastUserMessage ? lastUserMessage.split(/\s+/).length : 0;
      const lastUserIsVague =
        !lastUserMessage ||
        isConfirmation(lastUserMessage) ||
        isRejection(lastUserMessage) ||
        lastUserWordCount <= 5;
      const rawInstruction = (
        lastUserIsVague
          ? (instruction?.trim() || lastUserMessage || "")
          : lastUserMessage
      ).trim();

      // ── Routing trace — emitted before any branching ──────────────────
      console.log("[routine:TRACE] instruction_param=", (instruction?.trim() ?? "null").slice(0, 120));
      console.log("[routine:TRACE] lastUserMessage=", (lastUserMessage ?? "null").slice(0, 120));
      console.log("[routine:TRACE] recurringRawRef=", (recurringRawRef.current ?? "null").slice(0, 120));
      console.log("[routine:TRACE] rawInstruction=", rawInstruction.slice(0, 120));
      console.log("[routine:TRACE] transcriptLength=", sessionTranscriptRef.current.length, "people=", usePeopleStore.getState().items.length);

      if (!rawInstruction) {
        return "I did not receive an instruction. Ask the user what they want to do.";
      }

      // ── Carson supervisor — Phase 1+2: classify, plan, and log ──────────
      // Non-blocking. planCarsonInstruction calls classifyCarsonInstruction
      // internally (logs [carson_router]). Phase 3 audit runs after production.
      // Inspect [carson_plan] and [carson_plan_audit] in the console.
      let carsonPlan: ReturnType<typeof planCarsonInstruction> | null = null;
      try {
        carsonPlan = planCarsonInstruction({
          transcript: rawInstruction,
          people: usePeopleStore.getState().items,
        });
        console.log("[carson_plan]", carsonPlan);
        try {
          recordCarsonDiagnostic(
            "carson-plan",
            summarizeCarsonPlanDiagnostic(rawInstruction, carsonPlan),
          );
        } catch (diagnosticErr) {
          console.warn("[carson_plan:DIAGNOSTIC_ERROR]", diagnosticErr);
        }
      } catch (planErr) {
        console.warn("[carson_plan:ERROR]", planErr);
      }

      // Social turns are not work. If the dashboard accidentally calls
      // execute_instruction for "thank you" / "thanks", return naturally before
      // auth checks, store refreshes, extraction, Supabase, or WhatsApp.
      if (isSocialAcknowledgement(rawInstruction)) {
        return sanitizeSocialAcknowledgementReply(getSocialAcknowledgementReply(rawInstruction));
      }

      // Delivery status questions — "Did you send it?", "Did it go through?",
      // "Was it delivered?", "Did Christopher get it?" etc.
      //
      // Root cause of false failure: these fall through to executeDelegationFromText
      // which feeds them to Anthropic extraction. Anthropic either creates a
      // DUPLICATE task or returns a failure string. EL's LLM then synthesises
      // "No, both attempts timed out." from the tool result + stale ra7etbal_state
      // (which never contains tasks created during the current session because
      // dynamicVariables is set once at Conversation.startSession and not updated).
      //
      // Fix: answer from sentDelegationsRef (live current-session state) before
      // any Supabase or Anthropic call. If nothing was sent this session, fall
      // through normally — the instruction might be a real task, not a status check.
      if (isStatusQuestion(rawInstruction)) {
        const recentSends = sentDelegationsRef.current;
        if (recentSends.length > 0) {
          const last = recentSends[recentSends.length - 1];
          console.log("[execute_instruction] status_question answered from session state →", {
            person: last.personName, task: last.taskText,
          });
          return `Yes. ${last.personName} has it.`;
        }
        // No in-session send — fall through so the question gets processed normally
        // (it might be asking about a prior session's task, or might be a real
        // instruction misidentified as a status question on a cold session).
        console.log("[execute_instruction] status_question — no in-session sends, falling through");
      }

      const authUserId = useAuthStore.getState().user?.id;
      if (!authUserId) return "You are not signed in. Please sign in and try again.";

      // Ensure stores are fresh before extraction so person data is current.
      const peopleState = usePeopleStore.getState();
      if (peopleState.status === "idle" || peopleState.items.length === 0) {
        const startedAt = performance.now();
        try {
          await usePeopleStore.getState().loadFor(authUserId, { force: true });
        } finally {
          const active = activeExecuteLatencyRef.current;
          if (active) {
            addLatencyStageDuration(
              active.trace,
              "supabase_operations_ms",
              performance.now() - startedAt,
            );
          }
        }
      }
      const tasksState = useTasksStore.getState();
      if (tasksState.status === "idle" || tasksState.items.length === 0) {
        const startedAt = performance.now();
        try {
          await useTasksStore.getState().loadFor(authUserId);
        } finally {
          const active = activeExecuteLatencyRef.current;
          if (active) {
            addLatencyStageDuration(
              active.trace,
              "supabase_operations_ms",
              performance.now() - startedAt,
            );
          }
        }
      }

      const people = usePeopleStore.getState().items;
      const tasks = useTasksStore.getState().items;
      const userEmail = useAuthStore.getState().user?.email ?? null;

      const taskControlResolution = resolveVoiceTaskControl(
        rawInstruction,
        tasks,
        currentTaskContextRef.current,
      );
      if (taskControlResolution.status !== "not_task_control") {
        const result = await controlTaskTool({ instruction: rawInstruction });
        if (/^Done\./i.test(result)) {
          lastDirectToolSuccessRef.current = {
            toolName: "execute_instruction",
            resultText: result,
            at: new Date().toISOString(),
            inputSummary: { kind: "task_control", instruction: rawInstruction },
          };
        }
        return result;
      }

      // ── Parser diagnostic gate ─────────────────────────────────────────────
      // Activated by saying a phrase containing "parser diagnostic only" or
      // "diagnose direct message parser". Returns immediately with zero side
      // effects — no Anthropic call, no DB writes, no WhatsApp sends.
      const DIAG_PHRASES = ["parser diagnostic only", "diagnose direct message parser"];
      const isDiagnosticRun = DIAG_PHRASES.some((p) =>
        rawInstruction.toLowerCase().includes(p),
      );
      if (isDiagnosticRun) {
        const parseResult = parseSimpleDirectMessage(rawInstruction, people);
        const fastPathResult = parseResult
          ? { matched: true, recipientName: parseResult.recipientName, messageText: parseResult.messageText }
          : { matched: false, reason: "no_match" };
        console.log("[execute_instruction_raw_instruction]", instruction?.trim() ?? null);
        console.log("[execute_instruction_transcript_value]", lastUserMessage ?? null);
        console.log("[execute_instruction_fast_path_input]", rawInstruction);
        console.log("[execute_instruction_fast_path_result]", fastPathResult);
        console.log("[execute_instruction_diagnostic_full]", {
          execute_instruction_raw_instruction: instruction?.trim() ?? null,
          execute_instruction_transcript_value: lastUserMessage ?? null,
          execute_instruction_fast_path_input: rawInstruction,
          execute_instruction_fast_path_result: fastPathResult,
          people_count: people.length,
          people_names: people.map((p) => p.name),
        });
        return "Captured. Nothing was sent.";
      }

      // Snapshot the pending photos — prefer live ref, fall back to the session
      // snapshot captured at startCall time (before the idle UI unmounted the
      // file input, which can invalidate File objects on iOS Safari).
      const imagePhotos =
        pendingPhotosRef.current.length > 0
          ? pendingPhotosRef.current
          : sessionPhotosRef.current;
      const firstImageFile = imagePhotos[0]?.file ?? null;
      const photoContext = sessionPhotoContextRef.current;

      // ── Phase 3: wrap production in _runProductionExec for audit ─────────
      // All production logic is unchanged — the async closure captures the same
      // scope. _runProductionExec never throws: its inner catch returns a string.
      const _runProductionExec = async (): Promise<string> => {
      try {
        // Validate the first image synchronously before starting the voice pipeline.
        // WhatsApp V1 sends only the first image; all photos still reach Carson
        // as descriptions.
        // resizeImage throws for files > 15 MB; catch here so the error
        // surfaces as a spoken response rather than a silent crash.
        if (firstImageFile) {
          try {
            await resizeImage(firstImageFile); // dry-run validation only
          } catch (imgErr) {
            const reason = imgErr instanceof Error ? imgErr.message : "Image too large.";
            return `Could not attach the image: ${reason}`;
          }
        }

        // ── Operations Intelligence — confirmation / rejection leg ─────────
        // Decide from the verbatim reply sources (transcript + tool arg), never
        // a re-derived instruction, so EL's rephrasing of a bare "Yes" cannot
        // silently abandon a stored plan. Empty/noisy input holds the plan.
        const pendingDecision = resolvePendingPlanDecision(lastUserMessage, instruction ?? null);
        let activePlan = pendingPlanRef.current;
        if (!activePlan && pendingDecision !== "hold") {
          const startedAt = performance.now();
          try {
            activePlan = await loadLatestPendingPlan().catch(() => null);
          } finally {
            const active = activeExecuteLatencyRef.current;
            if (active) {
              addLatencyStageDuration(
                active.trace,
                "supabase_operations_ms",
                performance.now() - startedAt,
              );
            }
          }
          if (activePlan) pendingPlanRef.current = activePlan;
        }

        if (activePlan) {
          const turn = await handlePendingPlanTurn([lastUserMessage, instruction ?? null], activePlan, {
            displayName: displayName ?? null,
            userId: authUserId,
            people,
          });
          if (turn.clearPlan) pendingPlanRef.current = null;

          if (turn.action === "executed") {
            sessionActionsRef.current.push(`Ops plan executed: ${activePlan.sourceText}`);
            useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
            return turn.summary ?? "";
          }
          if (turn.action === "cancelled") {
            return turn.summary ?? "";
          }
          // held: plan preserved for a later turn (or discarded on expiry).
          // Fall through to normal handling below.
        }

        // Guard: a confirmation/rejection with no active plan returns a graceful
        // acknowledgement. Do NOT fall through to executeDelegationFromText —
        // feeding "Yes"/"No" to extraction returns empty results and propagates
        // failure wording back to EL's speech even when a prior delegation
        // succeeded (the double-call pattern).
        if (pendingDecision !== "hold") {
          console.log("[execute_instruction] confirmation/rejection with no active plan — returning graceful ack");
          return pendingDecision === "reject"
            ? "Understood. Let me know if there's anything else."
            : "You're all set.";
        }

        // ── Operations Intelligence — outcome leg ──────────────────────────
        // Operating authority ("handle what you can", "make sure everything is
        // ready", …) → EXECUTE immediately and report the tool-confirmed result.
        // A hosting event WITHOUT operating authority → propose (confirm-before-
        // send). Approval-required sensitive actions are gated at the prompt.
        const outcomeAction = resolveGuestOutcomeAction(rawInstruction);
        if (outcomeAction !== "none") {
          pendingPlanRef.current = null;
          const plan = await buildOperationalPlanFromOutcome(rawInstruction, people);
          if (plan) {
            if (outcomeAction === "execute") {
              const execSummary = await executeProposedPlan(plan, {
                displayName: displayName ?? null,
                userId: authUserId,
                people,
              });
              sessionActionsRef.current.push(`Ops plan executed: ${plan.sourceText}`);
              useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
              lastDirectToolSuccessRef.current = {
                toolName: "execute_instruction",
                resultText: execSummary,
                at: new Date().toISOString(),
                inputSummary: {
                  kind: "guest_plan_execute",
                  instruction: rawInstruction.slice(0, 80),
                },
              };
              return execSummary;
            }
            pendingPlanRef.current = plan;
            lastDirectToolSuccessRef.current = {
              toolName: "execute_instruction",
              resultText: plan.proposalSpeech,
              at: new Date().toISOString(),
              inputSummary: {
                kind: "guest_plan_proposal",
                instruction: rawInstruction.slice(0, 80),
              },
            };
            return plan.proposalSpeech;
          }
          return "I couldn't put that guest plan together right now. Please try again.";
        }

        // ── Recurring-language detection ──────────────────────────────────
        // Check ALL three possible sources for recurring language and use the
        // first one that matches. This guards against ElevenLabs stripping
        // recurring words from the instruction param before it reaches here,
        // and against onMessage not firing for the user transcript role.
        //
        // Source priority (most verbatim first):
        //   1. recurringRawRef  — captured in onMessage before LLM processes
        //   2. lastUserMessage  — verbatim transcript (may be same as #1)
        //   3. instruction param — LLM-rewritten; last resort but still works
        //      when the LLM preserves "every morning" / "daily" etc.
        // Normalize the LLM-rewritten instruction to prevent hallucinated weekdays
        // (e.g. "every Sunday morning" when the user said "every morning").
        const normalizedInstruction = instruction?.trim()
          ? normalizeCadenceText(instruction.trim())
          : null;
        const candidateSources = [
          recurringRawRef.current,
          lastUserMessage ?? null,
          normalizedInstruction,
        ].filter((s): s is string => !!s);

        // Consume ref now regardless — prevents inheritance by later calls.
        const consumedRawRef = recurringRawRef.current;
        recurringRawRef.current = null;

        // Find the first source that contains recurring language.
        let recurringSource: string | null = null;
        let recurringSchedules: ReturnType<typeof detectAllRecurringSchedules> = [];
        for (const src of candidateSources) {
          const schedules = detectAllRecurringSchedules(src);
          if (schedules.length > 0) {
            recurringSource = src;
            recurringSchedules = schedules;
            break;
          }
        }

        console.log("[routine:TRACE] consumedRawRef=", (consumedRawRef ?? "null").slice(0, 120));
        console.log("[routine:TRACE] candidateSources_count=", candidateSources.length);
        console.log("[routine:RECURRING_DETECTED]", recurringSchedules.length > 0 ? recurringSchedules : "none");

        if (recurringSchedules.length > 0 && recurringSource) {
          // Use recurringSource as the raw instruction for person extraction since
          // it preserves the original phrasing the user spoke ("Madam", "Grace", etc.)
          const routineInstruction = recurringSource;
          console.log("[routine:VOICE_INPUT]", routineInstruction);

          // ── Get JWT once for all automation POSTs ────────────────────────
          const { data: execSessionData } = await supabase.auth.getSession();
          const execJwt = execSessionData?.session?.access_token;
          if (!execJwt) return "You are not signed in. Please sign in and try again.";

          // Create one automation per detected schedule (handles "every Monday and Thursday").
          const results = await Promise.all(
            recurringSchedules.map(async (sched) => {
              try {
                console.log("[automation:CREATE]", { sched, peopleCount: people.length });
                // Pass the full Carson tool param as originalInstruction so detectAutomationType
                // sees "message Loulya every morning…" rather than a cadence-only fragment.
                const originalInstr = instruction?.trim() || routineInstruction;
                const input = buildVoiceAutomationInput(routineInstruction, sched, people, undefined, originalInstr);

                if (!input) {
                  // No person in the instruction at all → this is a self-directed
                  // recurring reminder, not a WhatsApp automation missing a
                  // recipient. Route to the Carson-native reminder routine
                  // (push notification + task, no WhatsApp) instead of failing.
                  if (!findPersonInInstruction(routineInstruction, people)) {
                    const reminderSummary = await createReminderRoutineFromInstruction(routineInstruction, sched);
                    if (reminderSummary) return reminderSummary;
                  }
                  console.warn("[automation:NO_PERSON] no person found in instruction", { routineInstruction });
                  return "I could not find a person in your contacts for that recurring instruction. Check their name in People and try again.";
                }

                const { assigneeId, cleanMessage, cadenceType, cadenceValue, title, summary, automationType } = input;
                console.log("[automation:TYPE]", { automationType, title });

                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const [hh, mm] = (cadenceValue.time as string).split(":").map(Number);
                const todayAt = new Date();
                todayAt.setHours(hh, mm, 0, 0);
                const nextRunAt = todayAt > new Date()
                  ? todayAt.toISOString()
                  : new Date(todayAt.getTime() + 86_400_000).toISOString();

                const res = await fetch("/api/automations", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${execJwt}` },
                  body: JSON.stringify({
                    title, instruction: cleanMessage, cadence_type: cadenceType,
                    cadence_value: cadenceValue, next_run_at: nextRunAt, timezone: tz,
                    assignee_id: assigneeId, created_by: "carson",
                    proof_required: false, proof_type: null,
                    automation_type: automationType,
                  }),
                });

                if (!res.ok) {
                  const err = await res.json().catch(() => ({}));
                  console.error("[automation:CREATE_FAILED]", err);
                  return null;
                }

                const result = await res.json();
                console.log("[automation:CREATED]", { id: result.automation?.id, title, cadenceType });
                return summary;
              } catch (err) {
                console.error("[automation:CREATE_ERROR]", err);
                return null;
              }
            }),
          );

          const successes = results.filter(Boolean) as string[];
          if (successes.length > 0) {
            sessionActionsRef.current.push(`Automation(s) created: ${rawInstruction}`);
            // Signal Automations list to refresh.
            console.log("[automation:DISPATCH_REFRESH] dispatching ra7etbal:routine-created");
            window.dispatchEvent(new CustomEvent("ra7etbal:routine-created"));
            return successes.join(" ");
          }

          // Hard-block: recurring language detected but automation creation failed.
          // Never fall through to a one-time WhatsApp send.
          console.warn("[automation:HARD_BLOCK] all schedules failed — not sending as one-time", { rawInstruction });
          return "I could not create that automation. I may not have found the person in your contacts. Check their name in People and try again.";
        }

        // ── FINAL SAFETY BLOCK ────────────────────────────────────────────
        // If ANY source still contains recurring language at this point it means
        // the detection above failed to catch it (e.g. the source set was empty
        // when the ref was captured). Hard-block before savePending is ever called.
        const safetyCheck = candidateSources.some(
          (s) => detectAllRecurringSchedules(s).length > 0,
        );
        if (safetyCheck) {
          console.error(
            "[routine:SAFETY_BLOCK] executeDelegationFromText reached with recurring language — blocked.",
            { candidateSources: candidateSources.map((s) => s.slice(0, 80)) },
          );
          return "I detected recurring language but couldn't create the routine. Check your contacts in People and try again.";
        }

        // The direct-message fast path writes to `messages`, which has no
        // image column and no taskId to scope a storage upload under — it
        // cannot carry a photo. Skip it whenever a photo is pending so the
        // request falls through to a path that can (sendDelegation below,
        // or executeDelegationFromText), instead of silently sending text-only.
        const directMessageFastPath =
          imagePhotos.length > 0
            ? { handled: false as const, reason: "no_match" as const }
            : await executeDirectMessageFastPath(rawInstruction, {
                displayName,
                userId: authUserId,
                people,
              });
        if (directMessageFastPath.handled) {
          return directMessageFastPath.response;
        }

        // ── Single-person delegation fast-path ─────────────────────────────
        // Matches: "ask/tell/get [name] to [task]" | "have [name] [task]"
        // Calls sendDelegation directly — no Anthropic call, returns in ~2-4s.
        // sendDelegation itself reads pendingPhotosRef/sessionPhotosRef and
        // attaches an image when present (see createAndSendDelegation).
        // Falls through to executeDelegationFromText for multi-person, personal
        // notes, recurring, compound, or ambiguous instructions.
        const delegationFastPath = await executeDelegationFastPath(
          rawInstruction,
          { people, userId: authUserId, displayName },
          { sendDelegationFn: sendDelegation },
        );
        if (delegationFastPath.handled) {
          if (delegationFastPath.status === "sent") {
            sessionActionsRef.current.push(
              `Delegated to ${delegationFastPath.personName}: ${delegationFastPath.taskText}`,
            );
            useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
          }
          return delegationFastPath.response;
        }

        console.log("[routine:TRACE] executeDelegationFromText called →", rawInstruction.slice(0, 100));

        // Belt-and-suspenders: if the session-start injection somehow missed
        // (e.g. description resolved after sendContextualUpdate was called),
        // re-inject using the pre-computed descriptions. No new API call.
        if (imagePhotos.length > 0 && photoContext) {
          conversationRef.current?.sendContextualUpdate(
            `Reminder — the user has attached photos:\n${photoContext}`,
          );
        }

        let executedDelegationRecords: ExecutedDelegationRecord[] = [];
        const summary = await executeDelegationFromText(rawInstruction, {
          displayName,
          userEmail,
          userId: authUserId,
          dailyBrief: "",
          people,
          tasks,
          // Pass all pending images. The first sets image_path; all are stored in
          // task_attachments when count > 1. WhatsApp switches to text template with
          // an attachment note when multiple photos are attached.
          imageFile: firstImageFile,
          allImageFiles: imagePhotos.map((p) => p.file),
          imageDescription: photoContext,
          onSavedExecution: (saved) => {
            executedDelegationRecords = saved.tasks
              .filter((task) => task.type === "delegation" || task.type === "followup")
              .map((task) => ({
                type: "delegation",
                personName: task.assigned_to,
                actionText: task.description,
                status: "created",
              }));
          },
          latencyObserver: {
            addDuration: (stage, durationMs) => {
              const active = activeExecuteLatencyRef.current;
              if (!active) return;
              addLatencyStageDuration(active.trace, stage, durationMs);
            },
          },
        });

        // Clear pending photos after a successful delegation send.
        if (imagePhotos.length > 0) clearPendingImages();

        const delegationCoverage = checkDelegationCoverage(
          rawInstruction,
          people,
          executedDelegationRecords,
        );
        const partialSuccessResponse = buildDelegationCoveragePartialSuccessResponse(
          delegationCoverage.expected,
          delegationCoverage.missing,
        );
        if (partialSuccessResponse) {
          lastDirectToolSuccessRef.current = {
            toolName: "execute_instruction",
            resultText: partialSuccessResponse,
            at: new Date().toISOString(),
            inputSummary: {
              kind: "delegation_coverage_partial_success",
              missing: delegationCoverage.missing.map((candidate) => ({
                personName: candidate.personName,
                actionText: candidate.actionText,
              })),
            },
          };
          console.warn("[carson-action-coverage] missing delegation candidate", {
            missing: delegationCoverage.missing.map((candidate) => ({
              personName: candidate.personName,
              actionText: candidate.actionText,
            })),
          });
          return partialSuccessResponse;
        }

        sessionActionsRef.current.push(`Executed: ${rawInstruction}`);
        // Refresh task store so Voice Carson context reflects the new task.
        useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});

        // Record in sentDelegationsRef so status questions later in the session
        // ("Did you send it?", "Did it go through?") can answer from live state
        // without falling through to executeDelegationFromText again.
        for (const rec of executedDelegationRecords) {
          if (rec.personName && rec.actionText) {
            sentDelegationsRef.current.push({
              personName: rec.personName,
              taskText: rec.actionText,
              messageText: rec.actionText,
            });
          }
        }

        // Record success so resolveSanitizedCarsonDisplayMessage can override
        // any failure language in Carson's separately-generated spoken reply.
        lastDirectToolSuccessRef.current = {
          toolName: "execute_instruction",
          resultText: summary,
          at: new Date().toISOString(),
          inputSummary: { kind: "delegation", instruction: rawInstruction.slice(0, 80) },
        };

        // Inject a contextual update so EL's LLM has current-session task state.
        // Without this, {{ra7etbal_state}} (set once at session start) never shows
        // tasks created during the call, causing EL to hallucinate failure when the
        // user asks "Did you send it?" ("live state always overrides memory" rule
        // makes EL prefer the stale snapshot over conversation history).
        if (executedDelegationRecords.length > 0) {
          const names = executedDelegationRecords
            .filter((r) => r.personName)
            .map((r) => r.personName)
            .join(", ");
          if (names) {
            conversationRef.current?.sendContextualUpdate(
              `[Session update] Tasks created and WhatsApp sent to: ${names}. ` +
              `This happened during the current session. If the user asks whether ` +
              `a message was sent, confirm yes — it was sent. Do not ask whether to send now; ` +
              `the send already happened. Do not ask whether the user is still there.`,
            );
          }
        }

        return summary;
      } catch (err) {
        console.error("[executeInstruction:catch]", err);
        const detail = sanitizeCarsonErrorDetail(err);
        return `Could not process that. ${detail}`;
      }
      }; // close _runProductionExec

      // Run production — audit is passive and must never block or throw.
      const productionResult = await _runProductionExec();
      if (carsonPlan) {
        try {
          const audit = auditCarsonExecution({
            transcript: rawInstruction,
            plan: carsonPlan,
            productionResult,
          });
          console.log("[carson_plan_audit]", audit);
          try {
            recordCarsonDiagnostic(
              "carson-plan-audit",
              summarizeCarsonAuditDiagnostic(audit),
            );
          } catch (diagnosticErr) {
            console.warn("[carson_plan_audit:DIAGNOSTIC_ERROR]", diagnosticErr);
          }
        } catch (auditErr) {
          console.warn("[carson_plan_audit:ERROR]", auditErr);
        }
      }
      return productionResult;
    },
    [displayName, clearPendingImages, sendDelegation, controlTaskTool],
  );

  const clearCarsonSessionTimers = useCallback(() => {
    if (userTranscriptTimerRef.current) {
      clearTimeout(userTranscriptTimerRef.current);
      userTranscriptTimerRef.current = null;
    }
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    if (visibilityTimerRef.current) {
      clearTimeout(visibilityTimerRef.current);
      visibilityTimerRef.current = null;
    }
  }, []);

  const stopLocalAudioPlayback = useCallback(() => {
    if (typeof document === "undefined") return;
    document.querySelectorAll("audio, video").forEach((element) => {
      const media = element as HTMLMediaElement;
      try {
        media.pause();
        media.currentTime = 0;
      } catch {
        // Best-effort belt-and-suspenders cleanup only.
      }
    });
  }, []);

  const saveVoiceSessionSnapshot = useCallback(
    (userId: string | null, transcript: TranscriptMessage[]) => {
      const sessionActions = [...sessionActionsRef.current];
      if (userId) {
        (async () => {
          const recap = await summarizeSessionRecap(transcript);
          const recapWithActions = buildSessionRecapWithActions(recap, sessionActions);
          if (recapWithActions) {
            await saveSessionMemory(`${SESSION_RECAP_PREFIX} ${recapWithActions}`);
          }
        })().catch((err) => {
          console.error(
            "[carson-memory] session recap save failed:",
            err instanceof Error ? err.message : err,
          );
        });
      }

      (async () => {
        if (userId) {
          try {
            await maybeSendImpliedDinnerDelegation(userId);
          } catch (err) {
            console.error(
              "[carson] maybeSendImpliedDinnerDelegation failed:",
              err instanceof Error ? err.message : err,
            );
          }
          try {
            await savePeopleMemoryFromTranscript(userId, transcript);
          } catch (err) {
            console.error(
              "[carson] savePeopleMemoryFromTranscript failed:",
              err instanceof Error ? err.message : err,
            );
          }
          const transcriptText = transcript.map((m) => m.message).join(" ");
          const peopleNow = usePeopleStore.getState().items;
          const tasksNow = useTasksStore.getState().items;
          updatePeopleInsightsFromTasks(transcriptText, peopleNow, tasksNow).catch(() => {});
          try {
            const facts = await extractDurableFacts(transcript);
            await upsertUserFacts(userId, facts);
          } catch (err) {
            console.error(
              "[carson-facts] voice fact extraction failed",
              err instanceof Error ? err.message : err,
            );
          }
        }

        sessionActionsRef.current = [];
        sessionTranscriptRef.current = [];
        sentDelegationsRef.current = [];
        currentTaskContextRef.current = null;
        createdReminderKeysRef.current.clear();

        let conversationSummary: string | null = null;
        try {
          conversationSummary = await summarizeConversation(transcript);
        } catch {
          // Non-fatal — fall back to tool actions only.
        }

        if (conversationSummary && isSummaryWorthSaving(conversationSummary)) {
          saveSessionMemory(conversationSummary).catch(() => {
            // Non-fatal — don't surface to user.
          });
        }
      })();
    },
    [maybeSendImpliedDinnerDelegation, savePeopleMemoryFromTranscript],
  );

  const forceCleanupSession = useCallback(
    (teardownReason: string, options?: { showEndedMessage?: boolean; clearError?: boolean }) => {
      const previousGeneration = sessionGenerationRef.current;
      sessionGenerationRef.current = previousGeneration + 1;
      startInFlightRef.current = false;

      const teardownInfo = {
        cause: teardownReason,
        previousGeneration,
        nextGeneration: sessionGenerationRef.current,
        status: statusRef.current,
        toolInFlight: toolInFlightRef.current,
        hadConversation: Boolean(conversationRef.current),
        at: new Date().toISOString(),
      };
      console.warn("[carson-lifecycle] forced cleanup", teardownInfo);
      console.warn("[carson-teardown]", teardownInfo);
      recordCarsonDiagnostic("carson-teardown", teardownInfo);

      const userId = useAuthStore.getState().user?.id ?? null;
      const transcript = [...sessionTranscriptRef.current];
      const conv = conversationRef.current;
      conversationRef.current = null;

      clearCarsonSessionTimers();
      toolInFlightRef.current = null;
      activeExecuteLatencyRef.current = null;
      lastUserTranscriptTimingRef.current = null;
      recurringRawRef.current = null;

      if (conv) {
        try {
          conv.setMicMuted(true);
        } catch (err) {
          console.warn("[carson-lifecycle] microphone mute during cleanup failed", err);
        }
        void conv.endSession().catch((err) => {
          console.warn("[carson-lifecycle] endSession during cleanup failed", err);
        });
      }

      stopLocalAudioPlayback();
      clearPendingPhotoPreviews();

      setStatus("idle");
      setMode("listening");
      setLastUserTranscript(null);
      if (options?.clearError !== false) setErrorMsg(null);
      if (options?.showEndedMessage) {
        setSessionEndedMsg("Session ended.");
      }

      if (transcript.length > 0) {
        saveVoiceSessionSnapshot(userId, transcript);
      } else {
        sessionActionsRef.current = [];
        sessionTranscriptRef.current = [];
        sentDelegationsRef.current = [];
        currentTaskContextRef.current = null;
        createdReminderKeysRef.current.clear();
      }
    },
    [
      clearCarsonSessionTimers,
      clearPendingPhotoPreviews,
      saveVoiceSessionSnapshot,
      stopLocalAudioPlayback,
    ],
  );

  // ------------------------------------------------------------------
  // Call management
  // ------------------------------------------------------------------
  const startCall = useCallback(async () => {
    if (!agentId) return;
    if (startInFlightRef.current || statusRef.current !== "idle" || conversationRef.current) {
      console.warn("[carson-lifecycle] reconnect attempt blocked", {
        status: statusRef.current,
        startInFlight: startInFlightRef.current,
        hasConversation: Boolean(conversationRef.current),
        at: new Date().toISOString(),
      });
      return;
    }

    startInFlightRef.current = true;
    const sessionGeneration = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = sessionGeneration;
    const isCurrentSession = () => sessionGenerationRef.current === sessionGeneration;
    const ignoreStaleCallback = (callbackName: string) => {
      if (isCurrentSession()) return false;
      console.info("[carson-lifecycle] stale callback ignored", {
        callbackName,
        callbackGeneration: sessionGeneration,
        activeGeneration: sessionGenerationRef.current,
        at: new Date().toISOString(),
      });
      return true;
    };

    console.info("[carson-lifecycle] connect attempt", {
      sessionGeneration,
      at: new Date().toISOString(),
    });

    // Snapshot pending photos NOW — before setStatus("connecting") causes any
    // potential DOM changes. On iOS Safari, a File from <input type="file"> can
    // become inaccessible if its source input unmounts.
    sessionPhotosRef.current = [...pendingPhotosRef.current];
    sessionPhotoContextRef.current = null;

    // If photos are attached, kick off description generation immediately —
    // in parallel with memory/weather loads below. We await the result just
    // before opening the ElevenLabs session so the descriptions are ready to
    // inject the moment Carson connects, before the user speaks a word.
    const photoContextPromise: Promise<string | null> =
      sessionPhotosRef.current.length > 0
        ? describePhotosForCarson(sessionPhotosRef.current).catch(() => null)
        : Promise.resolve(null);

    setStatus("connecting");
    setErrorMsg(null);
    setSessionEndedMsg(null);

    // Reset session state for this new session.
    sessionActionsRef.current = [];
    sessionTranscriptRef.current = [];
    sentDelegationsRef.current = [];
    currentTaskContextRef.current = null;
    createdReminderKeysRef.current.clear();
    recurringRawRef.current = null;
    setLastCarsonMessage(null);
    setLastUserTranscript(null);
    if (userTranscriptTimerRef.current) {
      clearTimeout(userTranscriptTimerRef.current);
      userTranscriptTimerRef.current = null;
    }

    // Load structured user memory and recent session summaries before opening
    // the ElevenLabs connection. Failures are non-fatal.
    let userMemory = "";
    try {
      userMemory = await loadUserMemory(50);
    } catch {
      // Non-fatal — Carson simply starts without structured memory.
    }
    if (!isCurrentSession()) return;

    let recentMemory = "No previous sessions.";
    try {
      recentMemory = await loadRecentMemory(20);
    } catch {
      // Non-fatal — Carson simply starts without prior memory.
    }
    if (!isCurrentSession()) return;

    let persistentInstructions = "";
    try {
      persistentInstructions = await loadPersistentMemory();
    } catch {
      // Non-fatal — Carson starts without persistent instructions.
    }
    if (!isCurrentSession()) return;

    // Load saved notes into ref for in-call act_on_note lookups — non-fatal.
    try {
      notesRef.current = await loadRecentNotes(100);
    } catch {
      notesRef.current = [];
    }
    if (!isCurrentSession()) return;

    // Load active to-dos into ref for in-call complete_todo lookups — non-fatal.
    try {
      todosRef.current = await listActiveTodos(100);
    } catch {
      todosRef.current = [];
    }
    if (!isCurrentSession()) return;

    // Fetch live weather for the user's saved city — non-fatal.
    // If city is not set, current_weather is "" and Carson will ask.
    let currentWeather = "";
    const savedCity = useProfileStore.getState().weatherCity;
    if (savedCity) {
      try {
        const wxRes = await fetch(`/api/weather?city=${encodeURIComponent(savedCity)}`);
        if (wxRes.ok) {
          const wxData = await wxRes.json().catch(() => null);
          if (wxData?.ok && wxData.spoken) {
            currentWeather = sanitizeForCarsonSpeech(wxData.spoken);
          }
        }
      } catch {
        // Non-fatal: Carson can continue without live weather.
      }
    }
    if (!isCurrentSession()) return;

    // Fetch live task/message state from Supabase before opening the session.
    const freshVars = onBeforeCallStart ? await onBeforeCallStart() : null;
    if (!isCurrentSession()) return;
    const liveBriefStateText = freshVars?.briefStateText ?? briefStateText;
    const liveSpokenBrief = freshVars?.spokenBrief ?? (spokenBrief ?? "");

    // Compute opening_line — proactive brief on first session of the day,
    // short status line on subsequent sessions.
    // Uses localStorage key "carson_brief_date" (YYYY-MM-DD) to track.
    const nowForOpening = new Date();
    const todayStr = (() => {
      const d = nowForOpening;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
    const isFirstSessionToday = localStorage.getItem("carson_brief_date") !== todayStr;
    if (isFirstSessionToday) {
      localStorage.setItem("carson_brief_date", todayStr);
    }
    const openingVariantIndex = Number(localStorage.getItem("carson_opening_variant") ?? "0");
    localStorage.setItem("carson_opening_variant", String(openingVariantIndex + 1));
    const openingLine = buildCarsonOpeningLine({
      isFirstSessionToday,
      displayName,
      spokenBrief: liveSpokenBrief,
      now: nowForOpening,
      variantIndex: openingVariantIndex,
    });

    // Await the photo descriptions now — they have been running concurrently with
    // the memory/weather loads above, so in most cases it is already resolved.
    sessionPhotoContextRef.current = await photoContextPromise;
    if (!isCurrentSession()) return;

    // Build state text. If photos are attached and described, append their
    // context here so Carson's LLM receives it at the system-variable level —
    // not just as a contextual update. This prevents the dashboard-prompt
    // fallback ("I can't see photos") from overriding the known photo context.
    const baseStateText = userMemory
      ? `${userMemory}\n\n${liveBriefStateText}`
      : liveBriefStateText;
    const carsonStateText = sessionPhotoContextRef.current
      ? `${baseStateText}\n\nAttached photos context (use this for the conversation):\n${sessionPhotoContextRef.current}`
      : baseStateText;

    try {
      // ── ElevenLabs connection safety rule ────────────────────────────────
      // Do NOT pass agent.prompt.prompt (or any prompt overrides) here.
      // Experimental overrides can break the ElevenLabs session handshake and
      // silently prevent Voice Carson from connecting.
      // Voice prompt changes belong in the ElevenLabs dashboard only,
      // unless SDK support for a specific field has been verified in staging.
      // ─────────────────────────────────────────────────────────────────────
      connectTimeoutRef.current = setTimeout(() => {
        if (!isCurrentSession()) return;
        console.warn("[carson-lifecycle] timeout", {
          sessionGeneration,
          status: statusRef.current,
          at: new Date().toISOString(),
        });
        forceCleanupSession("connect-timeout", { showEndedMessage: true });
      }, 60_000);
      const conv = await Conversation.startSession({
        agentId,
        dynamicVariables: {
          // Sanitize all speech-bound text so ElevenLabs never receives the
          // Latin "Ra7etBal" string — it mispronounces it. Arabic is correct.
          ra7etbal_state: sanitizeForCarsonSpeech(carsonStateText),
          daily_brief: sanitizeForCarsonSpeech(liveSpokenBrief),
          opening_line: sanitizeForCarsonSpeech(openingLine),
          // Local date/time + timezone label so Carson anchors "now" to the
          // user's actual clock and can reason about how long ago a session
          // was. UTC ISO is kept at the end for unambiguous machine reference.
          current_time: buildCurrentTimeLabel(),
          user_name: displayName ?? "",
          recent_memory: sanitizeForCarsonSpeech(recentMemory),
          current_weather: currentWeather,
          persistent_instructions: sanitizeForCarsonSpeech(
            [CARSON_STATUS_POLICY, CARSON_VOICE_SESSION_GUARD, persistentInstructions].filter(Boolean).join("\n\n"),
          ),
        },
        clientTools: {
          // ── Preferred path for delegation/messaging ──────────────────────
          // execute_instruction takes the raw spoken instruction and routes it
          // through the same shared pipeline as Text Carson. Use this for all
          // compound instructions, personal notes, and ambiguous cases.
          execute_instruction: async (params: ExecuteInstructionParams) => {
            toolInFlightRef.current = "execute_instruction";
            const toolStartedPerf = performance.now();
            const toolStartedAt = new Date().toISOString();
            const transcriptTiming = lastUserTranscriptTimingRef.current;
            const trace = createExecuteInstructionLatencyTrace({
              transcriptEventId: transcriptTiming?.eventId ?? null,
              transcriptReceivedAt: transcriptTiming?.receivedAt ?? null,
              transcriptReceivedPerf: transcriptTiming?.receivedPerf ?? null,
              toolStartedAt,
              toolStartedPerf,
            });
            activeExecuteLatencyRef.current = {
              trace,
              toolStartedPerf,
              toolCompletedPerf: null,
            };
            try {
              const result = await executeInstruction(params);
              trace.outcome = "success";
              return result;
            } catch (err) {
              trace.outcome = "error";
              console.error("[executeInstruction:catch]", err);
              const detail = sanitizeCarsonErrorDetail(err);
              return `Could not process that. ${detail}`;
            } finally {
              const toolCompletedPerf = performance.now();
              trace.tool_completed_at = new Date().toISOString();
              trace.stages.execute_instruction_ms = roundDuration(
                toolCompletedPerf - toolStartedPerf,
              );
              if (activeExecuteLatencyRef.current?.trace.trace_id === trace.trace_id) {
                activeExecuteLatencyRef.current.toolCompletedPerf = toolCompletedPerf;
              }
              toolInFlightRef.current = null;
            }
          },
          // ── Legacy/simple fallbacks ──────────────────────────────────────
          // send_delegation and send_followup are kept for backward compat with
          // existing ElevenLabs dashboard prompts that call them directly.
          // For new dashboard prompt versions, prefer execute_instruction.
          // Diagnostic wrappers only set/clear toolInFlightRef — behavior is
          // identical to calling sendFollowup / sendDelegation directly.
          send_followup: async (params: Parameters<typeof sendFollowup>[0]) => {
            toolInFlightRef.current = "send_followup";
            try {
              return await runDirectToolWithDiagnostic("send_followup", params, () =>
                sendFollowup(params),
              );
            } finally {
              toolInFlightRef.current = null;
            }
          },
          send_delegation: async (params: Parameters<typeof sendDelegation>[0]) => {
            toolInFlightRef.current = "send_delegation";
            try {
              return await runDirectToolWithDiagnostic("send_delegation", params, () =>
                sendDelegation(params),
              );
            } finally {
              toolInFlightRef.current = null;
            }
          },
          create_reminder: (params: Parameters<typeof createReminder>[0]) =>
            runDirectToolWithDiagnostic("create_reminder", params, () =>
              createReminder(params),
            ),
          create_automation: createAutomation,
          send_direct_whatsapp_message: async (params: { recipient_name: string; message: string }) => {
            toolInFlightRef.current = "send_direct_whatsapp_message";
            try {
              return await runDirectToolWithDiagnostic("send_direct_whatsapp_message", params, () =>
                sendDirectWhatsAppMessage(params),
              );
            } finally {
              toolInFlightRef.current = null;
            }
          },
          save_city: (params: Parameters<typeof saveCity>[0]) =>
            runDirectToolWithDiagnostic("save_city", params, () => saveCity(params)),
          save_note: (params: Parameters<typeof saveNote>[0]) =>
            runDirectToolWithDiagnostic("save_note", params, () => saveNote(params)),
          act_on_note: (params: Parameters<typeof actOnNote>[0]) =>
            runDirectToolWithDiagnostic("act_on_note", params, () => actOnNote(params)),
          list_inbox_items: () =>
            runDirectToolWithDiagnostic("list_inbox_items", {}, () => getInboxItems()),
          act_on_inbox_item: (params: Parameters<typeof actOnInboxItem>[0]) =>
            runDirectToolWithDiagnostic("act_on_inbox_item", params, () => actOnInboxItem(params)),
          create_todo: (params: Parameters<typeof createTodoTool>[0]) =>
            runDirectToolWithDiagnostic("create_todo", params, () => createTodoTool(params)),
          complete_todo: (params: Parameters<typeof completeTodoTool>[0]) =>
            runDirectToolWithDiagnostic("complete_todo", params, () => completeTodoTool(params)),
          control_task: (params: Parameters<typeof controlTaskTool>[0]) =>
            runDirectToolWithDiagnostic("control_task", params, () => controlTaskTool(params)),
          get_calendar_events: (params: Parameters<typeof getCalendarEvents>[0]) =>
            runDirectToolWithDiagnostic("get_calendar_events", params, () =>
              getCalendarEvents(params),
            ),
          create_calendar_event: (params: Parameters<typeof createCalendarEvent>[0]) =>
            runDirectToolWithDiagnostic("create_calendar_event", params, () =>
              createCalendarEvent(params),
            ),
          update_calendar_event: (params: Parameters<typeof updateCalendarEventTool>[0]) =>
            runDirectToolWithDiagnostic("update_calendar_event", params, () =>
              updateCalendarEventTool(params),
            ),
          delete_calendar_event: (params: Parameters<typeof deleteCalendarEventTool>[0]) =>
            runDirectToolWithDiagnostic("delete_calendar_event", params, () =>
              deleteCalendarEventTool(params),
            ),
          save_instruction: async ({
            instruction,
            category,
          }: {
            instruction: string;
            category?: string;
          }) =>
            runDirectToolWithDiagnostic(
              "save_instruction",
              { instruction, category },
              async () => {
                try {
                  await savePersistentInstruction(category ?? "general", instruction);
                  return "Got it. I'll remember that from now on.";
                } catch {
                  return "I couldn't save that instruction right now. Please try again.";
                }
              },
            ),
        },
        onModeChange: ({ mode: m }) => {
          if (ignoreStaleCallback("mode-change")) return;
          if (m === "speaking") {
            const active = activeExecuteLatencyRef.current;
            if (active?.toolCompletedPerf != null) {
              active.trace.first_response_at = new Date().toISOString();
              active.trace.stages.tool_completion_to_first_response_ms = roundDuration(
                performance.now() - active.toolCompletedPerf,
              );
              console.info("[carson-latency]", active.trace);
              recordCarsonDiagnostic("carson-latency", active.trace);
              activeExecuteLatencyRef.current = null;
            }
          }
          try {
            conversationRef.current?.setMicMuted(m === "speaking");
          } catch (err) {
            console.warn("[carson-audio] failed to update microphone mute state:", err);
          }
          setMode(m === "speaking" ? "speaking" : "listening");
        },
        onMessage: ({ role, message, event_id }) => {
          if (ignoreStaleCallback("message")) return;
          // Accumulate both sides of the conversation for end-of-session
          // summarisation. Only finalized messages arrive here.
          sessionTranscriptRef.current.push({ role, message });
          if (role === "user") {
            const receivedAt = new Date().toISOString();
            lastUserTranscriptTimingRef.current = {
              eventId: event_id ?? null,
              receivedAt,
              receivedPerf: performance.now(),
            };
            console.log("[voice-transcript:user]", {
              eventId: event_id ?? null,
              timestamp: receivedAt,
              message,
            });
            setLastUserTranscript(message);
            if (userTranscriptTimerRef.current) {
              clearTimeout(userTranscriptTimerRef.current);
            }
            userTranscriptTimerRef.current = setTimeout(() => {
              setLastUserTranscript(null);
              userTranscriptTimerRef.current = null;
            }, 8_000);

            // Capture recurring language from the raw user utterance BEFORE the
            // LLM processes it. The ElevenLabs dashboard LLM often strips recurring
            // language ("every Saturday", "weekly", etc.) when it rewrites the
            // instruction passed to execute_instruction. Storing the original here
            // lets executeInstruction use the verbatim text for detection.
            if (detectAllRecurringSchedules(message).length > 0) {
              recurringRawRef.current = message;
              console.log("[routine:RAW_CAPTURE]", message);
            }
          } else if (role === "agent") {
            // "agent" is the ElevenLabs SDK role for Carson's spoken turns.
            // If the role value ever changes, this silently stops updating — check
            // the console log below if the transcript bubble stops appearing.
            const previousUserMessage =
              [...sessionTranscriptRef.current]
                .slice(0, -1)
                .reverse()
                .find((entry) => entry.role === "user")?.message ?? "";
            // This onMessage callback delivers the agent's own separately-generated
            // reply — it can contradict a direct tool call that just succeeded
            // (create_todo P0). Prefer the tool's own success result when the
            // agent's message reads as a failure shortly after that tool ran.
            const displayMessage = resolveSanitizedCarsonDisplayMessage({
              agentMessage: message,
              previousUserMessage,
              lastSuccess: lastDirectToolSuccessRef.current,
            });
            if (!displayMessage || shouldSuppressCarsonIdlePrompt(message)) {
              sessionTranscriptRef.current.pop();
              console.log("[carson-idle] suppressed idle prompt", {
                eventId: event_id ?? null,
              });
              return;
            }
            if (displayMessage !== message) {
              sessionTranscriptRef.current[sessionTranscriptRef.current.length - 1] = {
                role,
                message: displayMessage,
              };
              console.log("[carson-text] sanitized Carson reply text", {
                eventId: event_id ?? null,
              });
            }
            console.log("[transcript] agent role confirmed, message len=%d", displayMessage.length);
            setLastCarsonMessage(displayMessage);
          } else {
            // Unexpected role — surface in dev console so it can be caught.
            console.warn("[transcript] unexpected onMessage role:", role);
          }
        },
        onDisconnect: (details?: {
          reason?: string;
          message?: string;
          context?: unknown;
        }) => {
          if (ignoreStaleCallback("disconnect")) return;
          // Diagnostic: surface WHY the session ended (SDK reason: user | agent |
          // error) and whether a client tool was mid-flight at disconnect time.
          const disconnectInfo = {
            reason: details?.reason ?? "unknown",
            message: details?.message ?? null,
            context: details?.context ?? null,
            toolInFlight: toolInFlightRef.current,
            at: new Date().toISOString(),
          };
          console.warn("[carson-disconnect]", disconnectInfo);
          console.info("[carson-lifecycle] disconnect", disconnectInfo);
          recordCarsonDiagnostic("carson-disconnect", disconnectInfo);

          // Capture refs before any async work so they can be reset immediately.
          const userId = useAuthStore.getState().user?.id ?? null;
          const transcript = [...sessionTranscriptRef.current];
          sessionGenerationRef.current += 1;
          conversationRef.current = null;
          startInFlightRef.current = false;
          clearCarsonSessionTimers();
          currentTaskContextRef.current = null;
          setStatus("idle");
          setMode("listening");
          setSessionEndedMsg("Session ended.");
          setLastUserTranscript(null);
          clearPendingPhotoPreviews();
          saveVoiceSessionSnapshot(userId, transcript);
        },
        onError: (msg, context?: unknown) => {
          if (ignoreStaleCallback("error")) return;
          // Diagnostic: log the error message + context before it is reduced to
          // UI state (which only shows when status flips to "error").
          const errorInfo = {
            message: msg ?? null,
            context: context ?? null,
            toolInFlight: toolInFlightRef.current,
            at: new Date().toISOString(),
          };
          console.error("[carson-error]", errorInfo);
          console.info("[carson-lifecycle] disconnect", errorInfo);
          recordCarsonDiagnostic("carson-error", errorInfo);

          // Keep error visible until the user closes it.
          sessionGenerationRef.current += 1;
          conversationRef.current = null;
          startInFlightRef.current = false;
          clearCarsonSessionTimers();
          currentTaskContextRef.current = null;
          setStatus("error");
          setErrorMsg(sanitizeCarsonReplyText(msg || "Connection lost.") || "Connection lost.");

          // Save whatever transcript we have so the session isn't lost.
          // Mirror the onDisconnect memory-save path but run fire-and-forget.
          const userId = useAuthStore.getState().user?.id ?? null;
          const transcript = [...sessionTranscriptRef.current];
          if (userId && transcript.length > 0) {
            saveVoiceSessionSnapshot(userId, transcript);
          }
        },
        onConnect: () => {
          if (ignoreStaleCallback("connect")) return;
          startInFlightRef.current = false;
          if (connectTimeoutRef.current) {
            clearTimeout(connectTimeoutRef.current);
            connectTimeoutRef.current = null;
          }
          console.info("[carson-lifecycle] connect", {
            sessionGeneration,
            at: new Date().toISOString(),
          });
          setStatus("connected");
        },
        // Diagnostic: fires when the agent invokes a tool the client has NOT
        // registered (e.g. a dashboard tool name that doesn't match any client
        // tool). Directly surfaces tool-registration regressions.
        onUnhandledClientToolCall: (params?: unknown) => {
          if (ignoreStaleCallback("unhandled-tool")) return;
          const unhandledInfo = {
            params: params ?? null,
            at: new Date().toISOString(),
          };
          console.warn("[carson-unhandled-tool]", unhandledInfo);
          recordCarsonDiagnostic("carson-unhandled-tool", unhandledInfo);
        },
      });
      if (!isCurrentSession()) {
        console.info("[carson-lifecycle] stale connection cleaned up", {
          sessionGeneration,
          activeGeneration: sessionGenerationRef.current,
          at: new Date().toISOString(),
        });
        try {
          conv.setMicMuted(true);
        } catch {
          // Best-effort stale connection cleanup.
        }
        void conv.endSession().catch((err) => {
          console.warn("[carson-lifecycle] stale endSession failed", err);
        });
        return;
      }

      conversationRef.current = conv;

      conv.sendContextualUpdate(
        `[Voice behavior guard]\n${CARSON_VOICE_SESSION_GUARD}`,
      );

      // Inject photo descriptions immediately after session opens — before the
      // user speaks. This is the critical path: Carson must know about the photos
      // from the first word, not only when execute_instruction fires later.
      if (sessionPhotoContextRef.current) {
        conv.sendContextualUpdate(
          `The user has attached photos. Here are descriptions:\n${sessionPhotoContextRef.current}\nKeep this in mind for the entire conversation.`,
        );
      }
    } catch (err) {
      if (!isCurrentSession()) return;
      startInFlightRef.current = false;
      clearCarsonSessionTimers();
      // Show the real error message so the user knows what went wrong.
      // Do not auto-dismiss — the error persists until the user closes it.
      setStatus("error");
      setErrorMsg(`Couldn't connect. ${sanitizeCarsonErrorDetail(err)}`);
    }
  }, [agentId, briefStateText, spokenBrief, displayName, createReminder, sendDelegation, sendFollowup, saveCity, saveNote, actOnNote, executeInstruction, forceCleanupSession, clearCarsonSessionTimers, clearPendingPhotoPreviews, onBeforeCallStart, runDirectToolWithDiagnostic, saveVoiceSessionSnapshot]);

  // ------------------------------------------------------------------
  // Session teardown
  // ------------------------------------------------------------------
  const stopSession = useCallback((teardownReason: string = "manual-end") => {
    forceCleanupSession(teardownReason);
  }, [forceCleanupSession]);

  // Wrap so the button's click event is never passed as the teardown reason.
  const endCall = useCallback(() => stopSession("manual-end-button"), [stopSession]);

  useEffect(() => {
    if ((status === "idle" || status === "error") && conversationRef.current) {
      console.warn("[carson-lifecycle] invalid state detected", {
        status,
        hasConversation: true,
        at: new Date().toISOString(),
      });
      forceCleanupSession(`invalid-${status}-with-active-session`);
    }
  }, [forceCleanupSession, status]);

  // ------------------------------------------------------------------
  // Lifecycle cleanup
  // ------------------------------------------------------------------
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        visibilityTimerRef.current = setTimeout(() => stopSession("visibility-hidden-30s"), 30_000);
      } else {
        if (visibilityTimerRef.current !== null) {
          clearTimeout(visibilityTimerRef.current);
          visibilityTimerRef.current = null;
        }
      }
    }
    function handlePageHide() { stopSession("pagehide"); }
    function handleBeforeUnload() { stopSession("beforeunload"); }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      if (visibilityTimerRef.current !== null) clearTimeout(visibilityTimerRef.current);
      stopSession("effect-cleanup-unmount");
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [stopSession]);

  if (!agentId) return null;

  return (
    <div
      className={inline ? "" : "fixed z-40 right-4"}
      style={inline ? undefined : { top: "240px" }}
    >
      {/*
       * File input is ALWAYS mounted so iOS Safari never invalidates the File
       * object by removing the input from the DOM. It is visually hidden at all
       * times; the attach button below triggers it programmatically.
       */}
      <input
        ref={imageFileInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageFileChange}
        className="sr-only"
        aria-label="Attach photo"
      />

      {/*
       * Photo thumbnails — rendered whenever photos are queued, regardless of
       * call status. This keeps the preview visible to the user during the
       * voice session and, critically, prevents the File object from being
       * garbage-collected by iOS when the idle section unmounts.
       */}
      {pendingPhotoPreviews.length > 0 && (
        <div className="mb-1.5 rounded-2xl border border-sage/25 bg-white/90 px-2.5 py-2 shadow-sm">
          <div className="flex items-center gap-1.5">
            {pendingPhotoPreviews.map((photo, index) => (
              <div key={photo.id} className="relative">
                <img
                  src={photo.previewUrl}
                  alt={`Attached photo ${index + 1}`}
                  className="h-9 w-9 rounded-lg border border-sage/20 object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePendingPhoto(photo.id)}
                  aria-label="Remove attached photo"
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-ink/70 text-white shadow transition hover:bg-ink"
                >
                  <svg width="6" height="6" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          <span className="mt-1 block text-[11px] text-ink/55">
            {status === "idle" ? "Photo ready" : "Photo attached"}
          </span>
        </div>
      )}

      {status === "idle" && sessionEndedMsg && (
        <p className="mb-2 text-center text-[11px] text-ink/45">{sessionEndedMsg}</p>
      )}

      {status === "idle" && (
        <div className="flex items-center gap-2">
          {/* Image attach button */}
          <button
            type="button"
            onClick={() => imageFileInputRef.current?.click()}
            aria-label={pendingPhotoPreviews.length > 0 ? "Replace photo for Carson" : "Attach photo for Carson"}
            title={pendingPhotoPreviews.length > 0 ? "Replace photo" : "Attach photo"}
            className={
              "flex h-10 w-10 items-center justify-center rounded-full border shadow-sm transition active:scale-95 " +
              (pendingPhotoPreviews.length > 0
                ? "border-sage/40 bg-sage/10 text-sage"
                : "border-charcoal/15 bg-white text-ink/40 hover:border-charcoal/25 hover:text-ink/65")
            }
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>

          {/* Talk to Carson button */}
          <button
            type="button"
            onClick={startCall}
            aria-label="Talk to Carson"
            className="flex items-center gap-2 rounded-full border border-charcoal/20 bg-white px-4 py-2.5 shadow-[0_6px_20px_-4px_rgba(20,20,20,0.30)] transition hover:shadow-[0_8px_24px_-4px_rgba(20,20,20,0.36)] active:scale-95"
          >
            <MicIcon className="h-4 w-4 text-charcoal" />
            <span className="text-[13px] font-semibold text-charcoal">
              Talk to Carson
            </span>
          </button>
        </div>
      )}

      {status === "connecting" && (
        <div className="flex items-center gap-2 rounded-full border border-charcoal/15 bg-warm-white px-4 py-2.5 shadow-[0_4px_16px_-4px_rgba(20,20,20,0.22)]">
          <PulsingDot color="bg-sage" />
          <span className="text-[13px] font-medium text-text">Connecting…</span>
        </div>
      )}

      {status === "connected" && (
        <div className="flex items-center gap-2">
          {/* Image attach button — lets the user attach a photo Carson asked
              for without ending the call. The file input is always mounted,
              so this is safe to show mid-session; handleImageFileChange
              pushes the new photo into the live session context above. */}
          <button
            type="button"
            onClick={() => imageFileInputRef.current?.click()}
            aria-label={pendingPhotoPreviews.length > 0 ? "Replace photo for Carson" : "Attach photo for Carson"}
            title={pendingPhotoPreviews.length > 0 ? "Replace photo" : "Attach photo"}
            className={
              "flex h-10 w-10 items-center justify-center rounded-full border shadow-sm transition active:scale-95 " +
              (pendingPhotoPreviews.length > 0
                ? "border-sage/40 bg-sage/10 text-sage"
                : "border-charcoal/15 bg-warm-white text-ink/40 hover:border-charcoal/25 hover:text-ink/65")
            }
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>

          <button
            type="button"
            onClick={endCall}
            aria-label="End call"
            className="flex items-center gap-2.5 rounded-full border border-charcoal/20 bg-warm-white px-4 py-2.5 shadow-[0_4px_16px_-4px_rgba(20,20,20,0.28)] transition hover:bg-white active:scale-95"
          >
            {mode === "speaking" ? (
              <PulsingDot color="bg-gold" />
            ) : (
              <PulsingDot color="bg-sage" />
            )}
            <span className="text-[13px] font-semibold text-charcoal">
              {mode === "speaking" ? "Speaking…" : "Listening…"}
            </span>
            <span className="ml-0.5 text-[11px] font-bold uppercase tracking-[0.16em] text-text">
              End
            </span>
          </button>
        </div>
      )}

      {status === "error" && (
        <button
          type="button"
          onClick={() => { stopSession("error-dismiss-button"); onRequestClose?.(); }}
          aria-label="Connection failed"
          className="flex items-center gap-2 rounded-full border border-danger/30 bg-warm-white/95 px-4 py-2.5 shadow-sm backdrop-blur-sm transition hover:bg-white active:scale-95"
        >
          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-danger" />
          <span className="max-w-[180px] truncate text-[12px] font-medium text-danger">
            {errorMsg ?? "Couldn't connect."}
          </span>
        </button>
      )}

      {lastUserTranscript && (
        <p className="mt-1 max-w-[280px] truncate px-2 text-[11px] text-ink/45">
          Carson heard: “{lastUserTranscript}”
        </p>
      )}

      {/* Latest Carson response — persists after session ends, clears on next session start */}
      {lastCarsonMessage && (
        <div className="mt-2 max-w-[280px] rounded-2xl border border-charcoal/10 bg-white/90 px-3.5 py-2.5 shadow-sm">
          <p className="text-[12px] leading-relaxed text-ink/70">{lastCarsonMessage}</p>
        </div>
      )}
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="9" y1="22" x2="15" y2="22" />
    </svg>
  );
}

function PulsingDot({ color }: { color: string }) {
  return (
    <span
      className="relative flex h-2.5 w-2.5 items-center justify-center"
      aria-hidden
    >
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${color}`}
      />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}
