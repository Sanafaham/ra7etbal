import { Conversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import { resizeImage, uploadTaskImage } from "../../lib/image-upload";
import { extractDurableFacts } from "../../lib/carson-fact-extract";
import { loadUserMemory, upsertUserFacts } from "../../lib/carson-facts";
import { loadRecentMemory, saveSessionMemory } from "../../lib/carson-memory";
import { loadPersistentMemory, savePersistentInstruction } from "../../lib/carson-persistent-memory";
import { saveCarsonNote, loadRecentNotes, type CarsonNote } from "../../lib/carson-notes";
import { filterCalendarEventsByRange } from "../../lib/calendar";
import type { CalendarEvent, CalendarRange } from "../../lib/calendar";
import { sanitizeForCarsonSpeech } from "../../lib/speech-sanitize";
import { summarizeConversation, isSummaryWorthSaving, type TranscriptMessage } from "../../lib/carson-summarize";
import { parseVoiceTime } from "../../lib/parse-voice-time";
import { scheduleReminderPush } from "../../lib/qstash-reminder";
import { scheduleEscalationMessages } from "../../lib/qstash-escalation";
import { buildDelegationMessage } from "../../lib/delegation-message";
import { executeDelegationFromText } from "../../lib/text-carson";
import { mergePersonNotes, updatePeopleInsightsFromTasks } from "../../lib/people-behavior";
import { injectPersonalNote, normalizePersonalNote, stripClosingLine } from "../../lib/personal-note";
import { composeMergedMessage } from "../../lib/ai/compose-message";
import { createMessage } from "../../lib/messages";
import { createTask } from "../../lib/tasks";
import { sendWhatsAppTask } from "../../lib/whatsapp";
import { useAuthStore } from "../../stores/auth";
import type { Person } from "../../types/person";
import { usePeopleStore } from "../../stores/people";
import { useProfileStore } from "../../stores/profile";
import { useTasksStore } from "../../stores/tasks";

type CallStatus = "idle" | "connecting" | "connected" | "error";
type AgentMode = "listening" | "speaking";

interface PendingPhoto {
  id: string;
  file: File;
  previewUrl: string;
  name: string;
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
    const arrayBuffer = await file.arrayBuffer();
    console.log("[img-diag] arrayBuffer size:", arrayBuffer.byteLength);
    if (arrayBuffer.byteLength === 0) {
      console.warn("[img-diag] arrayBuffer is empty — File object may have been invalidated by iOS");
      return null;
    }
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
      if (!description) return null;
      return `Photo ${index + 1}${photo.name ? ` (${photo.name})` : ""}: ${description}`;
    }),
  );

  const lines = descriptions.filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : null;
}

// ---------------------------------------------------------------------------
// Pronoun rewriter — delegated messages are sent on behalf of the owner.
// "call me" from the owner's mouth becomes "call Sana" in the outgoing
// message so the recipient knows who to contact.
// ---------------------------------------------------------------------------

/**
 * Replace first-person owner pronouns with the owner's display name.
 * Used for Carson-generated delegation messages before they are sent.
 *
 * Falls back to "the sender" when no name is available so the message
 * remains natural: "Can you please call the sender when you arrive."
 */
function rewriteOwnerPronouns(text: string, ownerName?: string | null): string {
  const name = ownerName?.trim() || "the sender";
  return text
    .replace(/\bmy\b/gi, `${name}'s`)
    .replace(/\bmyself\b/gi, name)
    .replace(/\bme\b/gi, name)
    .replace(/\bI\b/g, name); // capital I only — avoids altering mid-word "i"
}


interface SentDelegationRecord {
  personName: string;
  taskText: string;
  messageText: string;
}

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
}

async function createAndSendDelegation({
  userId,
  person,
  taskText,
  message,
  personalNote,
  ownerName,
  imageFile,
}: DelegationSendOptions): Promise<DelegationSendResult> {
  // Always build the base message with buildDelegationMessage so personality
  // notes (bossy, reliable, etc.) are applied consistently — never skip this
  // step for known people even when the agent provides its own message text.
  //
  // Personal/informational notes are injected AFTER the base message is built,
  // so they appear before the closing confirmation sentence:
  //   "Hi Grace, could you call Sana? [Sana says she misses you.] Confirm when done."
  //
  // Note resolution order:
  //   1. personalNote param (explicit — from updated dashboard prompt or execute_instruction)
  //   2. extracted from agent-provided message (best-effort, current dashboard compat)
  //   3. null — no note injected
  const rawNote =
    personalNote?.trim() ||
    extractNoteFromAgentMessage(message, taskText) ||
    null;
  // Normalize the raw note into natural recipient-facing language before
  // composition — ensures bare expressions like "Thank you" become
  // "Sana says thank you." and avoids dropping or mangling the note.
  const resolvedNote = rawNote
    ? normalizePersonalNote(rawNote, ownerName)
    : null;

  // When a note is present, use LLM composition to produce one natural
  // sentence. Falls back to the append path if composition fails.
  let messageText: string;
  if (resolvedNote) {
    const merged = await composeMergedMessage({
      personName: person.name,
      taskText,
      personalNote: resolvedNote,
      ownerName,
    });
    messageText = merged ?? injectPersonalNote(
      stripClosingLine(
        rewriteOwnerPronouns(
          buildDelegationMessage({
            personName: person.name,
            taskText,
            personNotes: person.notes ?? null,
            ownerName,
          }),
          ownerName,
        ),
      ),
      resolvedNote,
    );
  } else {
    messageText = stripClosingLine(
      rewriteOwnerPronouns(
        buildDelegationMessage({
          personName: person.name,
          taskText,
          personNotes: person.notes ?? null,
          ownerName,
        }),
        ownerName,
      ),
    );
  }

  const taskRowId = crypto.randomUUID();
  const confirmationUrl = `${window.location.origin}/confirm?task=${taskRowId}`;

  // Upload image before createTask so image_path is set atomically on insert.
  // Non-fatal: if upload fails, delegation still sends without image.
  let imagePath: string | null = null;
  if (imageFile) {
    try {
      const blob = await resizeImage(imageFile);
      imagePath = await uploadTaskImage(userId, taskRowId, blob);
    } catch (err) {
      console.error("[send_delegation] image upload failed, sending without image:", err);
      imagePath = null;
    }
  }

  const taskRow = await createTask({
    id: taskRowId,
    user_id: userId,
    description: taskText,
    type: "delegation",
    assigned_to: person.name,
    status: "pending",
    needs_follow_up: true,
    confirmation_url: confirmationUrl,
    due_at: null,
    image_path: imagePath,
  });

  let messageRecord;
  try {
    messageRecord = await createMessage({
      user_id: userId,
      task_id: taskRow.id,
      recipient: person.name,
      content: messageText,
      confirmation_url: confirmationUrl,
    });
  } catch {
    // Non-fatal: the WhatsApp send can still proceed with task metadata.
  }

  await sendWhatsAppTask({
    to: person.phone,
    messageText,
    confirmationLink: confirmationUrl,
    messageRecordId: messageRecord?.id ?? null,
    taskId: taskRow.id,
    recipientName: person.name,
    ownerName: ownerName ?? null,
    imagePath,
  });

  if (taskRow.created_at) {
    scheduleEscalationMessages(taskRow.id, taskRow.created_at).catch((err) =>
      console.error("[send_delegation] QStash scheduleEscalationMessages failed for task", taskRow.id, err),
    );
  }

  return { taskId: taskRow.id, messageText };
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

  // Notify parent whenever call status changes.
  useEffect(() => { onCallStatusChange?.(status); }, [status, onCallStatusChange]);
  /** Latest finalized spoken response from Carson. Cleared at session start, persists after disconnect. */
  const [lastCarsonMessage, setLastCarsonMessage] = useState<string | null>(null);
  const conversationRef = useRef<Awaited<
    ReturnType<typeof Conversation.startSession>
  > | null>(null);

  // Pending photos for the next voice delegation.
  // Stored in a ref (not state) to avoid triggering re-renders and to ensure
  // executeInstruction always reads the latest value without stale closure issues.
  const pendingPhotosRef = useRef<PendingPhoto[]>([]);
  // Preview metadata is state so thumbnails re-render correctly.
  const [pendingPhotoPreviews, setPendingPhotoPreviews] = useState<PendingPhoto[]>([]);
  const imageFileInputRef = useRef<HTMLInputElement>(null);

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
    const file = Array.from(e.target.files ?? [])[0];
    e.target.value = ""; // allow reselecting same file
    if (!file) return;

    // Revoke previous preview URL before replacing
    for (const photo of pendingPhotosRef.current) {
      URL.revokeObjectURL(photo.previewUrl);
    }

    syncPendingPhotoState([{
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
    }]);
  }

  function removePendingPhoto(id: string) {
    if (status !== "idle") return;
    const removed = pendingPhotosRef.current.find((photo) => photo.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    syncPendingPhotoState(pendingPhotosRef.current.filter((photo) => photo.id !== id));
  }

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      for (const photo of pendingPhotosRef.current) {
        URL.revokeObjectURL(photo.previewUrl);
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

  /** Snapshot of saved notes loaded at startCall. Used by act_on_note for
   *  in-memory keyword lookup without hitting Supabase during the call. */
  const notesRef = useRef<CarsonNote[]>([]);

  /** Accumulates finalized transcript messages (both user and agent) for
   *  this session. Summarised by Haiku at disconnect for conversational memory. */
  const sessionTranscriptRef = useRef<TranscriptMessage[]>([]);

  // Tracks latest planning calendar cache for stable useCallback closure.
  const planningCalendarEventsRef = useRef<CalendarEvent[]>(planningCalendarEvents);
  useEffect(() => {
    planningCalendarEventsRef.current = planningCalendarEvents;
  }, [planningCalendarEvents]);

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
    async ({
      name,
      message,
      allowNewFollowup = false,
    }: {
      name: string;
      message?: string;
      allowNewFollowup?: boolean;
    }): Promise<string> => {
      const normalizedName = name.trim();
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
        return `Could not save the follow-up task. ${err instanceof Error ? err.message : "Please try again."}`;
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
        return `Could not send the WhatsApp message to ${person.name}. ${err instanceof Error ? err.message : "Please try again."}`;
      }

      lastSentRef.current.set(cooldownKey, Date.now());
      sessionActionsRef.current.push(`Sent follow-up to ${person.name} about ${topicLabel}`);
      return `Sent follow-up to ${person.name} about ${topicLabel}.`;
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: send_delegation
  // ------------------------------------------------------------------
  const sendDelegation = useCallback(
    async ({
      name,
      task,
      message,
      note,
    }: {
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
      const normalizedName = name.trim();
      if (!normalizedName) {
        return "I did not receive a person name. Ask the user who to delegate to.";
      }

      const taskText = task.trim();
      if (!taskText || taskText.length < 4) {
        return "The task description is too vague. Ask the user what exactly they should do.";
      }

      // 1. Ensure stores are loaded
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

      // 2. Resolve person
      const people = usePeopleStore.getState().items;
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
      if (!userId) return "You are not signed in. Please sign in and try again.";

      // Snapshot pending photos — prefer live ref, fall back to session snapshot.
      const delegationPhotos =
        pendingPhotosRef.current.length > 0
          ? pendingPhotosRef.current
          : sessionPhotosRef.current;
      const delegationImageFile = delegationPhotos[0]?.file ?? null;

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
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Please try again.";
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
      sessionActionsRef.current.push(`Delegated to ${person.name}: ${taskText}`);

      await maybeSendImpliedDinnerDelegation(userId);

      return `Sent delegation to ${person.name}: ${taskText}.`;
    },
    [displayName, maybeSendImpliedDinnerDelegation, clearPendingImages],
  );

  // ------------------------------------------------------------------
  // Client tool: create_reminder
  // ------------------------------------------------------------------
  const createReminder = useCallback(
    async ({
      description,
      time_text,
      due_at,
    }: {
      description: string;
      /** Raw time phrase from the user, e.g. "tomorrow at 5 PM", "in 30 minutes". */
      time_text?: string;
      /** ISO fallback — only used when time_text is absent. */
      due_at?: string;
    }): Promise<string> => {
      const text = description?.trim();
      if (!text) {
        return "I did not receive a reminder description. Ask the user what they want to be reminded about.";
      }

      // ── Resolve due time ──────────────────────────────────────────────────
      // Prefer parsing the raw phrase; fall back to agent-supplied ISO only when
      // time_text is absent. This ensures "tomorrow at 5 PM" always resolves
      // using the browser's local clock, not the agent's arithmetic.
      let resolvedDueAt: string;

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

      // Create the task through the store — identical to the UI save path.
      let task;
      try {
        task = await useTasksStore.getState().add({
          user_id: userId,
          description: text,
          type: "reminder",
          assigned_to: null,
          status: "pending",
          needs_follow_up: false,
          confirmation_url: null,
          due_at: resolvedDueAt,
        });
      } catch (err) {
        return `Could not save the reminder. ${err instanceof Error ? err.message : "Please try again."}`;
      }

      // Schedule QStash — identical to save.ts.
      scheduleReminderPush(task.id, resolvedDueAt).catch((err) =>
        console.error("[create_reminder] QStash schedule failed", task.id, err),
      );

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
      sessionActionsRef.current.push(`Created reminder: ${text} (${dateLabel} at ${timeStr})`);
      return `CREATED: Reminder saved — "${text}" on ${dateLabel} at ${timeStr}.`;
    },
    [],
  );

  // ------------------------------------------------------------------
  // Client tool: save_city
  // Carson calls this when the user tells it their city for the first time.
  // Persists to profiles.weather_city so future sessions have weather.
  // ------------------------------------------------------------------
  const saveCity = useCallback(
    async ({ city }: { city: string }): Promise<string> => {
      const trimmed = city.trim();
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
    async ({
      note,
      category,
    }: {
      note: string;
      category?: string;
    }): Promise<string> => {
      const trimmed = note?.trim();
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
        if (!cached || cached.length === 0) return "No calendar events are loaded. If Google Calendar is not connected, the user should connect it in Settings.";
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

        const title: string = (params?.title ?? "").trim();
        const date: string  = (params?.date  ?? "").trim();
        const time: string  = (params?.time  ?? "").trim();
        const durationMinutes: number = Number(params?.duration_minutes) > 0
          ? Number(params.duration_minutes)
          : 60;
        const description: string = (params?.description ?? "").trim();

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

        const { data: sessionData } = await supabase.auth.getSession();
        const jwt = sessionData?.session?.access_token;
        if (!jwt) return "You're not signed in. Please sign in and try again.";

        const body: Record<string, unknown> = { title, date, time, duration_minutes: durationMinutes };
        if (description) body.description = description;

        const res = await fetch("/api/google-calendar", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          cache: "no-store",
        });

        const data = await res.json().catch(() => null);
        console.log("[calendar-create-debug] server response httpStatus=%d ok=%s code=%s",
          res.status, data?.ok ?? "null", data?.code ?? "none");
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
        const eventId: string = (params?.event_id ?? "").trim();
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

        const { data: sessionData } = await supabase.auth.getSession();
        const jwt = sessionData?.session?.access_token;
        if (!jwt) return "You're not signed in. Please sign in and try again.";

        const res = await fetch("/api/google-calendar", {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ event_id: eventId, ...patch }),
          cache: "no-store",
        });

        console.log("[calendar:update_tool_called] backend_status=%d", res.status);
        const data = await res.json().catch(() => null);
        console.log("[calendar:update_tool_called] backend_ok=%s code=%s", data?.ok, data?.code ?? "none");
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

        return `Done. ${data.title} is now on your calendar${parts.length ? " " + parts.join(" ") : ""}.`;
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
        const eventId: string = (params?.event_id ?? "").trim();
        if (!eventId) {
          return "I need the event ID to delete it. Please call get_calendar_events first to find the event.";
        }

        // Capture the event title for the confirmation message before removing from cache
        const eventEntry = planningCalendarEventsRef.current.find((ev) => ev.id === eventId);
        const eventTitle = eventEntry?.title ?? "that event";

        const { data: sessionData } = await supabase.auth.getSession();
        const jwt = sessionData?.session?.access_token;
        if (!jwt) return "You're not signed in. Please sign in and try again.";

        const res = await fetch("/api/google-calendar", {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ event_id: eventId }),
          cache: "no-store",
        });

        console.log("[calendar:delete_tool_called] backend_status=%d", res.status);
        const data = await res.json().catch(() => null);
        console.log("[calendar:delete_tool_called] backend_ok=%s code=%s", data?.ok, data?.code ?? "none");
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
            return `Done. ${eventTitle} has been removed from your calendar.`;
          }
          return "I couldn't delete that event. Please try again.";
        }

        // Remove from in-session cache so conflict detection and get_calendar_events stay accurate
        planningCalendarEventsRef.current = planningCalendarEventsRef.current.filter(
          (ev) => ev.id !== eventId,
        );

        return `Done. ${eventTitle} has been removed from your calendar.`;
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
    async ({
      query,
      action,
      time_text,
      person_name,
    }: {
      /** Keyword(s) to match against note text — case-insensitive substring. */
      query: string;
      action: "task" | "reminder" | "delegate" | "calendar";
      /** Required for reminder + calendar. Raw time phrase as spoken, e.g. "tomorrow at 5pm". */
      time_text?: string;
      /** Required for delegate. Exact person name. */
      person_name?: string;
    }): Promise<string> => {
      const q = query?.trim();
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
          return `Done. I've turned that note into a task: "${note.note.slice(0, 60)}${note.note.length > 60 ? "…" : ""}".`;
        } catch (err) {
          return `Couldn't create the task. ${err instanceof Error ? err.message : "Please try again."}`;
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
          const task = await createTask({
            user_id: authUserId,
            description: note.note,
            type: "reminder",
            assigned_to: null,
            status: "pending",
            needs_follow_up: false,
            confirmation_url: null,
            due_at: parsed.dueAt,
          });
          scheduleReminderPush(task.id, parsed.dueAt).catch((err) =>
            console.error("[act_on_note] QStash reminder schedule failed:", err),
          );
          useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
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
          return `Reminder set for "${note.note.slice(0, 50)}${note.note.length > 50 ? "…" : ""}" — ${dateLabel} at ${timeStr}.`;
        } catch (err) {
          return `Couldn't set the reminder. ${err instanceof Error ? err.message : "Please try again."}`;
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
          sessionActionsRef.current.push(`Delegated note to ${person.name}: ${note.note}`);
          console.log("[act_on_note] delegation sent:", result.taskId, "→", person.name);
          return `Done. Sent to ${person.name}: "${note.note.slice(0, 50)}${note.note.length > 50 ? "…" : ""}".`;
        } catch (err) {
          return `Couldn't send the delegation. ${err instanceof Error ? err.message : "Please try again."}`;
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
    async ({ instruction }: { instruction: string }): Promise<string> => {
      // Prefer the exact user transcript from sessionTranscriptRef over the
      // agent-provided instruction parameter. The ElevenLabs agent may rephrase
      // the user's spoken words before passing them here — dropping personal notes,
      // altering names, or collapsing compound requests into a single sentence.
      // The last user message in sessionTranscriptRef is the verbatim transcript.
      const lastUserMessage = [...sessionTranscriptRef.current]
        .reverse()
        .find((m) => m.role === "user")?.message?.trim();
      const rawInstruction = (lastUserMessage || instruction?.trim() || "").trim();
      if (!rawInstruction) {
        return "I did not receive an instruction. Ask the user what they want to do.";
      }

      const authUserId = useAuthStore.getState().user?.id;
      if (!authUserId) return "You are not signed in. Please sign in and try again.";

      // Ensure stores are fresh before extraction so person data is current.
      const peopleState = usePeopleStore.getState();
      if (peopleState.status === "idle" || peopleState.items.length === 0) {
        await usePeopleStore.getState().loadFor(authUserId);
      }
      const tasksState = useTasksStore.getState();
      if (tasksState.status === "idle" || tasksState.items.length === 0) {
        await useTasksStore.getState().loadFor(authUserId);
      }

      const people = usePeopleStore.getState().items;
      const tasks = useTasksStore.getState().items;
      const userEmail = useAuthStore.getState().user?.email ?? null;

      // Snapshot the pending photos — prefer live ref, fall back to the session
      // snapshot captured at startCall time (before the idle UI unmounted the
      // file input, which can invalidate File objects on iOS Safari).
      const imagePhotos =
        pendingPhotosRef.current.length > 0
          ? pendingPhotosRef.current
          : sessionPhotosRef.current;
      const firstImageFile = imagePhotos[0]?.file ?? null;
      const photoContext = sessionPhotoContextRef.current;

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

        // Belt-and-suspenders: if the session-start injection somehow missed
        // (e.g. description resolved after sendContextualUpdate was called),
        // re-inject using the pre-computed descriptions. No new API call.
        if (imagePhotos.length > 0 && photoContext) {
          conversationRef.current?.sendContextualUpdate(
            `Reminder — the user has attached photos:\n${photoContext}`,
          );
        }

        const summary = await executeDelegationFromText(rawInstruction, {
          displayName,
          userEmail,
          userId: authUserId,
          dailyBrief: "",
          people,
          tasks,
          // Pass the first pending image so savePending uploads it and sets image_path.
          // ra7etbal_task_image template fires automatically when imagePath is set.
          // Multiple photos are represented through imageDescription context.
          imageFile: firstImageFile,
          imageDescription: photoContext,
        });

        // Capture photo descriptions before clearPendingImages wipes them.
        const capturedPhotoContext = sessionPhotoContextRef.current;

        // Clear pending photos after a successful delegation send.
        if (imagePhotos.length > 0) clearPendingImages();

        sessionActionsRef.current.push(`Executed: ${rawInstruction}`);
        // Refresh task store so Voice Carson context reflects the new task.
        useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});

        // When photos were attached, prepend the descriptions to the return
        // string so Carson speaks from it instead of saying he cannot see photos.
        if (capturedPhotoContext) {
          return `Based on the attached photos (${capturedPhotoContext}): ${summary}`;
        }
        return summary;
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Please try again.";
        return `Could not process that. ${detail}`;
      }
    },
    [displayName, clearPendingImages],
  );

  // ------------------------------------------------------------------
  // Call management
  // ------------------------------------------------------------------
  const startCall = useCallback(async () => {
    if (!agentId || status !== "idle") return;

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

    // Reset session state for this new session.
    sessionActionsRef.current = [];
    sessionTranscriptRef.current = [];
    sentDelegationsRef.current = [];
    setLastCarsonMessage(null);

    // Load structured user memory and recent session summaries before opening
    // the ElevenLabs connection. Failures are non-fatal.
    let userMemory = "";
    try {
      userMemory = await loadUserMemory(50);
    } catch {
      // Non-fatal — Carson simply starts without structured memory.
    }

    let recentMemory = "No previous sessions.";
    try {
      recentMemory = await loadRecentMemory(20);
    } catch {
      // Non-fatal — Carson simply starts without prior memory.
    }

    let persistentInstructions = "";
    try {
      persistentInstructions = await loadPersistentMemory();
    } catch {
      // Non-fatal — Carson starts without persistent instructions.
    }

    // Load saved notes into ref for in-call act_on_note lookups — non-fatal.
    try {
      notesRef.current = await loadRecentNotes(100);
    } catch {
      notesRef.current = [];
    }

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

    // Fetch live task/message state from Supabase before opening the session.
    const freshVars = onBeforeCallStart ? await onBeforeCallStart() : null;
    const liveBriefStateText = freshVars?.briefStateText ?? briefStateText;
    const liveSpokenBrief = freshVars?.spokenBrief ?? (spokenBrief ?? "");

    // Compute opening_line — proactive brief on first session of the day,
    // short status line on subsequent sessions.
    // Uses localStorage key "carson_brief_date" (YYYY-MM-DD) to track.
    const todayStr = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
    const isFirstSessionToday = localStorage.getItem("carson_brief_date") !== todayStr;
    if (isFirstSessionToday) {
      localStorage.setItem("carson_brief_date", todayStr);
    }
    const openingLine = (() => {
      if (!isFirstSessionToday) return "I'm here. What are we looking at?";
      const hour = new Date().getHours();
      const greeting =
        hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
      const name = displayName?.trim();
      const greeterPrefix = name ? `${greeting}, ${name}.` : `${greeting}.`;
      const briefBody = liveSpokenBrief
        ? sanitizeForCarsonSpeech(liveSpokenBrief)
        : "You're all set.";
      // Strip any greeting already prepended by buildMorningBriefSpoken so we
      // don't say "Good morning" twice. The spoken brief always starts with a
      // greeting sentence ending in "." — remove it if present.
      const briefWithoutGreeting = briefBody.replace(/^(Good morning|Good afternoon|Good evening)[^.]*\.\s*/i, "");
      return `${greeterPrefix} ${briefWithoutGreeting} Anything you want me to handle first?`;
    })();

    // Await the photo descriptions now — they have been running concurrently with
    // the memory/weather loads above, so in most cases it is already resolved.
    sessionPhotoContextRef.current = await photoContextPromise;

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
      const conv = await Conversation.startSession({
        agentId,
        dynamicVariables: {
          // Sanitize all speech-bound text so ElevenLabs never receives the
          // Latin "Ra7etBal" string — it mispronounces it. Arabic is correct.
          ra7etbal_state: sanitizeForCarsonSpeech(carsonStateText),
          daily_brief: sanitizeForCarsonSpeech(liveSpokenBrief),
          opening_line: openingLine,
          current_time: new Date().toISOString(),
          user_name: displayName ?? "",
          recent_memory: sanitizeForCarsonSpeech(recentMemory),
          current_weather: currentWeather,
          persistent_instructions: sanitizeForCarsonSpeech(persistentInstructions),
        },
        clientTools: {
          // ── Preferred path for delegation/messaging ──────────────────────
          // execute_instruction takes the raw spoken instruction and routes it
          // through the same shared pipeline as Text Carson. Use this for all
          // compound instructions, personal notes, and ambiguous cases.
          execute_instruction: executeInstruction,
          // ── Legacy/simple fallbacks ──────────────────────────────────────
          // send_delegation and send_followup are kept for backward compat with
          // existing ElevenLabs dashboard prompts that call them directly.
          // For new dashboard prompt versions, prefer execute_instruction.
          send_followup: sendFollowup,
          send_delegation: sendDelegation,
          create_reminder: createReminder,
          save_city: saveCity,
          save_note: saveNote,
          act_on_note: actOnNote,
          get_calendar_events: getCalendarEvents,
          create_calendar_event: createCalendarEvent,
          update_calendar_event: updateCalendarEventTool,
          delete_calendar_event: deleteCalendarEventTool,
          save_instruction: async ({
            instruction,
            category,
          }: {
            instruction: string;
            category?: string;
          }) => {
            try {
              await savePersistentInstruction(category ?? "general", instruction);
              return "Got it. I'll remember that from now on.";
            } catch {
              return "I couldn't save that instruction right now. Please try again.";
            }
          },
        },
        onModeChange: ({ mode: m }) => {
          setMode(m === "speaking" ? "speaking" : "listening");
        },
        onMessage: ({ role, message }) => {
          // Accumulate both sides of the conversation for end-of-session
          // summarisation. Only finalized messages arrive here.
          sessionTranscriptRef.current.push({ role, message });
          // "agent" is the ElevenLabs SDK role for Carson's spoken turns.
          // If the role value ever changes, this silently stops updating — check
          // the console log below if the transcript bubble stops appearing.
          if (role === "agent") {
            console.log("[transcript] agent role confirmed, message len=%d", message.length);
            setLastCarsonMessage(message);
          } else if (role !== "user") {
            // Unexpected role — surface in dev console so it can be caught.
            console.warn("[transcript] unexpected onMessage role:", role);
          }
        },
        onDisconnect: () => {
          // Capture refs before any async work so they can be reset immediately.
          const userId = useAuthStore.getState().user?.id ?? null;
          const transcript = [...sessionTranscriptRef.current];
          conversationRef.current = null;
          setStatus("idle");
          setMode("listening");
          clearPendingPhotoPreviews();

          // Build and save session memory asynchronously — non-blocking.
          // The UI is already back to idle while this runs in the background.
          (async () => {
            if (userId) {
              await maybeSendImpliedDinnerDelegation(userId);
              await savePeopleMemoryFromTranscript(userId, transcript);
              // Behavioral insight: update people.notes based on task history.
              // Uses the full transcript as the "input text" for name detection.
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

            // Try LLM summarisation of the conversational content.
            let conversationSummary: string | null = null;
            try {
              conversationSummary = await summarizeConversation(transcript);
            } catch {
              // Non-fatal — fall back to tool actions only.
            }

            // Save only durable conversational memory — and only when the
            // summary meets the quality threshold (≥2 bullets, or a single
            // Correction/preference bullet). Thin housekeeping rows would
            // otherwise become the [Most recent session] label and displace
            // meaningful memory from previous sessions.
            if (conversationSummary && isSummaryWorthSaving(conversationSummary)) {
              saveSessionMemory(conversationSummary).catch(() => {
                // Non-fatal — don't surface to user.
              });
            }
          })();
        },
        onError: (msg) => {
          // Keep error visible — user must tap to retry. No silent auto-dismiss.
          conversationRef.current = null;
          setStatus("error");
          setErrorMsg(msg || "Connection lost. Tap to retry.");
        },
        onConnect: () => {
          setStatus("connected");
        },
      });
      conversationRef.current = conv;

      // Inject photo descriptions immediately after session opens — before the
      // user speaks. This is the critical path: Carson must know about the photos
      // from the first word, not only when execute_instruction fires later.
      if (sessionPhotoContextRef.current) {
        conv.sendContextualUpdate(
          `The user has attached photos. Here are descriptions:\n${sessionPhotoContextRef.current}\nKeep this in mind for the entire conversation.`,
        );
      }
    } catch (err) {
      // Show the real error message so the user knows what went wrong.
      // Do not auto-dismiss — the error persists until the user taps to retry.
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Couldn't connect. Tap to retry.");
    }
  }, [agentId, briefStateText, spokenBrief, displayName, createReminder, sendDelegation, sendFollowup, saveCity, saveNote, actOnNote, executeInstruction, maybeSendImpliedDinnerDelegation, savePeopleMemoryFromTranscript, clearPendingPhotoPreviews, onBeforeCallStart, status]);

  // ------------------------------------------------------------------
  // Session teardown
  // ------------------------------------------------------------------
  const stopSession = useCallback(() => {
    if (conversationRef.current) {
      conversationRef.current.endSession();
      conversationRef.current = null;
    }
    clearPendingPhotoPreviews();
    setStatus("idle");
    setMode("listening");
  }, [clearPendingPhotoPreviews]);

  const endCall = stopSession;

  // ------------------------------------------------------------------
  // Lifecycle cleanup
  // ------------------------------------------------------------------
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") stopSession();
    }
    function handlePageHide() { stopSession(); }
    function handleBeforeUnload() { stopSession(); }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      stopSession();
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
        aria-label="Attach photos"
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
                {status === "idle" && (
                  <button
                    type="button"
                    onClick={() => removePendingPhoto(photo.id)}
                    aria-label={`Remove attached photo ${index + 1}`}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-ink/70 text-white shadow transition hover:bg-ink"
                  >
                    <svg width="6" height="6" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                      <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
          <span className="mt-1 block text-[11px] text-ink/55">
            {status === "idle" ? "Photo ready" : "Photo attached"}
          </span>
        </div>
      )}

      {status === "idle" && (
        <div className="flex items-center gap-2">
          {/* Image attach button */}
          <button
            type="button"
            onClick={() => imageFileInputRef.current?.click()}
            aria-label="Attach photos for Carson"
            title="Attach photos"
            disabled={pendingPhotoPreviews.length >= 1}
            className={
              "flex h-10 w-10 items-center justify-center rounded-full border shadow-sm transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 " +
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
      )}

      {status === "error" && (
        <button
          type="button"
          onClick={() => { setStatus("idle"); setErrorMsg(null); onRequestClose?.(); }}
          aria-label="Connection failed — tap to retry"
          className="flex items-center gap-2 rounded-full border border-danger/30 bg-warm-white/95 px-4 py-2.5 shadow-sm backdrop-blur-sm transition hover:bg-white active:scale-95"
        >
          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-danger" />
          <span className="max-w-[180px] truncate text-[12px] font-medium text-danger">
            {errorMsg ?? "Couldn't connect — tap to retry"}
          </span>
        </button>
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
