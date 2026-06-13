/**
 * Inbox — merged view of:
 *  - Unprocessed inbox items (InboxReviewPanel)
 *  - Carson notes (from Notes.tsx)
 *
 * All note logic is preserved verbatim from Notes.tsx.
 * Replaces: Notes, and the InboxReviewPanel section of Home.
 */
import { useEffect, useMemo, useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import InboxReviewPanel from "../components/home/InboxReviewPanel";
import RefreshButton from "../components/RefreshButton";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import {
  deleteCarsonNote,
  loadRecentNotes,
  saveCarsonNote,
  type CarsonNote,
} from "../lib/carson-notes";
import { createTask } from "../lib/tasks";
import { useTasksStore } from "../stores/tasks";
import { useAuthStore } from "../stores/auth";
import { parseVoiceTime } from "../lib/parse-voice-time";
import { scheduleReminderPush } from "../lib/qstash-reminder";
import { createCalendarEvent } from "../lib/calendar";
import { buildDelegationMessage } from "../lib/delegation-message";
import { stripClosingLine } from "../lib/personal-note";
import { createMessage } from "../lib/messages";
import { sendWhatsAppTask } from "../lib/whatsapp";
import { scheduleEscalationMessages } from "../lib/qstash-escalation";
import { usePeopleStore } from "../stores/people";
import { useProfileStore } from "../stores/profile";
import { useDraftStore } from "../stores/draft";
import { useNavigate } from "react-router-dom";

/** Replace first-person owner pronouns with the owner's display name. */
function rewriteOwnerPronouns(text: string, ownerName?: string | null): string {
  const name = ownerName?.trim() || "the sender";
  return text
    .replace(/\bmy\b/gi, `${name}'s`)
    .replace(/\bmyself\b/gi, name)
    .replace(/\bme\b/gi, name)
    .replace(/\bI\b/g, name);
}

export default function Inbox() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const [notes, setNotes] = useState<CarsonNote[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [makingTaskId, setMakingTaskId] = useState<string | null>(null);
  const [madeTaskIds, setMadeTaskIds] = useState<Set<string>>(new Set());

  // ── Remind Me state ────────────────────────────────────────────────────────
  const [remindingNoteId, setRemindingNoteId] = useState<string | null>(null);
  const [remindTimeText, setRemindTimeText] = useState("");
  const [settingReminderId, setSettingReminderId] = useState<string | null>(null);
  const [reminderInputError, setReminderInputError] = useState<string | null>(null);
  const [reminderSetIds, setReminderSetIds] = useState<Set<string>>(new Set());

  // ── Delegate state ─────────────────────────────────────────────────────────
  const [delegatingNoteId, setDelegatingNoteId] = useState<string | null>(null);
  const [delegatePersonId, setDelegatePersonId] = useState<string>("");
  const [sendingDelegateId, setSendingDelegateId] = useState<string | null>(null);
  const [delegateError, setDelegateError] = useState<string | null>(null);
  const [delegatedMap, setDelegatedMap] = useState<Map<string, string>>(new Map());

  // ── Add to Calendar state ──────────────────────────────────────────────────
  const [calendarNoteId, setCalendarNoteId] = useState<string | null>(null);
  const [calendarTimeText, setCalendarTimeText] = useState("");
  const [settingCalendarId, setSettingCalendarId] = useState<string | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarAddedIds, setCalendarAddedIds] = useState<Set<string>>(new Set());

  const peopleItems = usePeopleStore((state) => state.items);

  const trimmedDraft = draft.trim();
  const canSave = !!userId && trimmedDraft.length > 0 && !saving;
  const initialLoading = status === "loading" && notes.length === 0;
  const showEmpty = status === "ready" && notes.length === 0;

  const groupedNotes = useMemo(() => notes, [notes]);

  async function reload() {
    if (!userId) return;
    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    setError(null);
    try {
      const loaded = await loadRecentNotes(100);
      setNotes(loaded);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load notes.");
      setStatus("error");
    }
  }

  useEffect(() => {
    if (!userId) { setNotes([]); setStatus("idle"); return; }
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await saveCarsonNote(trimmedDraft, "general", "manual");
      setDraft("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save note.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(note: CarsonNote) {
    if (deletingId) return;
    if (confirmingDeleteId !== note.id) {
      setConfirmingDeleteId(note.id);
      window.setTimeout(() => {
        setConfirmingDeleteId((current) => (current === note.id ? null : current));
      }, 3000);
      return;
    }
    setConfirmingDeleteId(null);
    setDeletingId(note.id);
    setError(null);
    try {
      await deleteCarsonNote(note.id);
      setNotes((current) => current.filter((item) => item.id !== note.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete note.");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleMakeTask(note: CarsonNote) {
    if (makingTaskId) return;
    const authUserId = useAuthStore.getState().user?.id ?? userId;
    if (!authUserId) return;
    setMakingTaskId(note.id);
    setError(null);
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
      setMadeTaskIds((prev) => new Set(prev).add(note.id));
      console.log("[inbox] task created from note:", task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create task.");
    } finally {
      setMakingTaskId(null);
    }
  }

  // ── Delegate handlers ─────────────────────────────────────────────────────

  async function handleOpenDelegate(note: CarsonNote) {
    const authUserId = useAuthStore.getState().user?.id ?? userId;
    if (authUserId) {
      const ps = usePeopleStore.getState();
      if (ps.status === "idle" || ps.items.length === 0) {
        await usePeopleStore.getState().loadFor(authUserId);
      }
    }
    setDelegatingNoteId(note.id);
    setDelegatePersonId("");
    setDelegateError(null);
  }

  function handleCancelDelegate() {
    setDelegatingNoteId(null);
    setDelegatePersonId("");
    setDelegateError(null);
  }

  async function handleDelegateSubmit(note: CarsonNote) {
    if (!delegatePersonId || sendingDelegateId) return;
    const people = usePeopleStore.getState().items;
    const person = people.find((p) => p.id === delegatePersonId);
    if (!person) { setDelegateError("Person not found."); return; }
    if (!person.phone) { setDelegateError(`${person.name} has no phone number saved.`); return; }
    const authUserId = useAuthStore.getState().user?.id ?? userId;
    if (!authUserId) return;
    const ownerName = useProfileStore.getState().displayName ?? undefined;
    setSendingDelegateId(note.id);
    setDelegateError(null);
    try {
      const messageText = stripClosingLine(
        rewriteOwnerPronouns(
          buildDelegationMessage({ personName: person.name, taskText: note.note, personNotes: person.notes ?? null, ownerName: ownerName ?? null }),
          ownerName,
        ),
      );
      const taskId = crypto.randomUUID();
      const confirmationUrl = `${window.location.origin}/confirm?task=${taskId}`;
      const task = await createTask({ id: taskId, user_id: authUserId, description: note.note, type: "delegation", assigned_to: person.name, status: "pending", needs_follow_up: true, confirmation_url: confirmationUrl, due_at: null });
      let messageRecord;
      try {
        messageRecord = await createMessage({ user_id: authUserId, task_id: task.id, recipient: person.name, content: messageText, confirmation_url: confirmationUrl });
      } catch { /* non-fatal */ }
      await sendWhatsAppTask({ to: person.phone, messageText, confirmationLink: confirmationUrl, messageRecordId: messageRecord?.id ?? null, taskId: task.id, recipientName: person.name, ownerName: ownerName ?? null });
      if (task.created_at) scheduleEscalationMessages(task.id, task.created_at).catch((err) => console.error("[inbox] escalation schedule failed:", err));
      useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
      setDelegatedMap((prev) => new Map(prev).set(note.id, person.name));
      setDelegatingNoteId(null);
      setDelegatePersonId("");
    } catch (err) {
      setDelegateError(err instanceof Error ? err.message : "Could not send delegation.");
    } finally {
      setSendingDelegateId(null);
    }
  }

  // ── Calendar handlers ─────────────────────────────────────────────────────

  function handleOpenCalendar(note: CarsonNote) { setCalendarNoteId(note.id); setCalendarTimeText(""); setCalendarError(null); }
  function handleCancelCalendar() { setCalendarNoteId(null); setCalendarTimeText(""); setCalendarError(null); }

  async function handleCalendarSubmit(note: CarsonNote) {
    const phrase = calendarTimeText.trim();
    if (!phrase) { setCalendarError("Enter a time, e.g. tomorrow at 11"); return; }
    if (settingCalendarId) return;
    const parsed = parseVoiceTime(phrase);
    if (parsed.error || !parsed.dueAt) { setCalendarError(`Couldn't parse "${phrase}". Try: tomorrow at 11am`); return; }
    const d = new Date(parsed.dueAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setSettingCalendarId(note.id);
    setCalendarError(null);
    try {
      const result = await createCalendarEvent(note.note, date, time);
      if (!result.ok) {
        setCalendarError(result.code === "reconnect_required" ? "Google Calendar is not connected. Reconnect in Settings." : "Couldn't add the event. Please try again.");
        return;
      }
      setCalendarAddedIds((prev) => new Set(prev).add(note.id));
      setCalendarNoteId(null);
      setCalendarTimeText("");
    } catch (err) {
      setCalendarError(err instanceof Error ? err.message : "Couldn't add the event.");
    } finally {
      setSettingCalendarId(null);
    }
  }

  // ── Remind Me handlers ────────────────────────────────────────────────────

  function handleOpenRemind(note: CarsonNote) { setRemindingNoteId(note.id); setRemindTimeText(""); setReminderInputError(null); }
  function handleCancelRemind() { setRemindingNoteId(null); setRemindTimeText(""); setReminderInputError(null); }

  async function handleRemindSubmit(note: CarsonNote) {
    const phrase = remindTimeText.trim();
    if (!phrase) { setReminderInputError("Enter a time, e.g. tomorrow at 5pm"); return; }
    if (settingReminderId) return;
    const authUserId = useAuthStore.getState().user?.id ?? userId;
    if (!authUserId) return;
    const parsed = parseVoiceTime(phrase);
    if (parsed.error || !parsed.dueAt) { setReminderInputError(`Couldn't parse "${phrase}". Try: tomorrow at 5pm`); return; }
    setSettingReminderId(note.id);
    setReminderInputError(null);
    try {
      const task = await createTask({ user_id: authUserId, description: note.note, type: "reminder", assigned_to: null, status: "pending", needs_follow_up: false, confirmation_url: null, due_at: parsed.dueAt });
      scheduleReminderPush(task.id, parsed.dueAt).catch((err) => console.error("[inbox] QStash reminder schedule failed:", err));
      useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
      setReminderSetIds((prev) => new Set(prev).add(note.id));
      setRemindingNoteId(null);
      setRemindTimeText("");
    } catch (err) {
      setReminderInputError(err instanceof Error ? err.message : "Could not set reminder.");
    } finally {
      setSettingReminderId(null);
    }
  }

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Inbox</h1>
          <p className="text-sm text-ink/60">Ideas, thoughts, and items to process.</p>
        </div>
        <RefreshButton onClick={reload} />
      </header>

      {/* Unprocessed inbox items from Text Carson */}
      <InboxReviewPanel
        userId={userId}
        onPrefill={(text) => {
          useDraftStore.getState().setText(text);
          navigate("/");
        }}
      />

      {/* Manual note input */}
      <section className="rounded-2xl border border-sage/30 bg-white/75 p-4 shadow-sm">
        <label
          htmlFor="manual-note-inbox"
          className="text-xs font-medium uppercase tracking-wide text-ink/55"
        >
          Add a note
        </label>
        <textarea
          id="manual-note-inbox"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a note, idea, or thought…"
          rows={3}
          className="mt-2 block min-h-[92px] w-full resize-y rounded-xl border border-sage/25 bg-cream/35 px-3 py-2 text-base leading-relaxed text-ink outline-none placeholder:text-ink/35 focus:border-sage focus:bg-white"
        />
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            aria-busy={saving}
            className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-full bg-sage px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:bg-sage/35"
          >
            {saving && <Spinner size={14} />}
            <span>{saving ? "Saving..." : "Save Note"}</span>
          </button>
        </div>
      </section>

      {error && (
        <AuthNotice kind="error">
          {error}{" "}
          {userId && (
            <button type="button" onClick={() => void reload()} className="ml-1 underline">Try again</button>
          )}
        </AuthNotice>
      )}

      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading notes" />
        </div>
      )}

      {showEmpty && (
        <div className="rounded-2xl border border-dashed border-sage/40 bg-white/60 p-8 text-center text-sm text-ink/70">
          No notes yet. Ask Carson to save an idea or thought.
        </div>
      )}

      {groupedNotes.length > 0 && (
        <ul className="space-y-3">
          {groupedNotes.map((note) => (
            <li key={note.id}>
              <NoteCard
                note={note}
                deleting={deletingId === note.id}
                confirmingDelete={confirmingDeleteId === note.id}
                onDelete={handleDelete}
                makingTask={makingTaskId === note.id}
                taskMade={madeTaskIds.has(note.id)}
                onMakeTask={handleMakeTask}
                reminding={remindingNoteId === note.id}
                remindTimeText={remindingNoteId === note.id ? remindTimeText : ""}
                onRemindTimeChange={setRemindTimeText}
                settingReminder={settingReminderId === note.id}
                reminderSet={reminderSetIds.has(note.id)}
                reminderInputError={remindingNoteId === note.id ? reminderInputError : null}
                onRemindMe={handleOpenRemind}
                onRemindSubmit={handleRemindSubmit}
                onRemindCancel={handleCancelRemind}
                delegating={delegatingNoteId === note.id}
                delegatePersonId={delegatingNoteId === note.id ? delegatePersonId : ""}
                onDelegatePersonChange={setDelegatePersonId}
                sendingDelegate={sendingDelegateId === note.id}
                delegatedName={delegatedMap.get(note.id) ?? null}
                delegateError={delegatingNoteId === note.id ? delegateError : null}
                onDelegate={handleOpenDelegate}
                onDelegateSubmit={handleDelegateSubmit}
                onDelegateCancel={handleCancelDelegate}
                peopleItems={peopleItems}
                addingToCalendar={calendarNoteId === note.id}
                calendarTimeText={calendarNoteId === note.id ? calendarTimeText : ""}
                onCalendarTimeChange={setCalendarTimeText}
                settingCalendar={settingCalendarId === note.id}
                calendarAdded={calendarAddedIds.has(note.id)}
                calendarError={calendarNoteId === note.id ? calendarError : null}
                onAddToCalendar={handleOpenCalendar}
                onCalendarSubmit={handleCalendarSubmit}
                onCalendarCancel={handleCancelCalendar}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── NoteCard ──────────────────────────────────────────────────────────────────
// Preserved verbatim from Notes.tsx

function NoteCard({
  note, deleting, confirmingDelete, onDelete,
  makingTask, taskMade, onMakeTask,
  reminding, remindTimeText, onRemindTimeChange, settingReminder, reminderSet, reminderInputError,
  onRemindMe, onRemindSubmit, onRemindCancel,
  delegating, delegatePersonId, onDelegatePersonChange, sendingDelegate, delegatedName, delegateError,
  onDelegate, onDelegateSubmit, onDelegateCancel, peopleItems,
  addingToCalendar, calendarTimeText, onCalendarTimeChange, settingCalendar, calendarAdded, calendarError,
  onAddToCalendar, onCalendarSubmit, onCalendarCancel,
}: {
  note: CarsonNote;
  deleting: boolean; confirmingDelete: boolean; onDelete: (note: CarsonNote) => Promise<void>;
  makingTask: boolean; taskMade: boolean; onMakeTask: (note: CarsonNote) => Promise<void>;
  reminding: boolean; remindTimeText: string; onRemindTimeChange: (v: string) => void;
  settingReminder: boolean; reminderSet: boolean; reminderInputError: string | null;
  onRemindMe: (note: CarsonNote) => void; onRemindSubmit: (note: CarsonNote) => Promise<void>; onRemindCancel: () => void;
  delegating: boolean; delegatePersonId: string; onDelegatePersonChange: (id: string) => void;
  sendingDelegate: boolean; delegatedName: string | null; delegateError: string | null;
  onDelegate: (note: CarsonNote) => Promise<void>; onDelegateSubmit: (note: CarsonNote) => Promise<void>; onDelegateCancel: () => void;
  peopleItems: import("../types/person").Person[];
  addingToCalendar: boolean; calendarTimeText: string; onCalendarTimeChange: (v: string) => void;
  settingCalendar: boolean; calendarAdded: boolean; calendarError: string | null;
  onAddToCalendar: (note: CarsonNote) => void; onCalendarSubmit: (note: CarsonNote) => Promise<void>; onCalendarCancel: () => void;
}) {
  const busy = makingTask || deleting || settingReminder || sendingDelegate || settingCalendar;

  return (
    <article className="rounded-2xl border border-sage/25 bg-white/85 p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <span className="rounded-full border border-sage/30 bg-sage/10 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-sage">
          {note.category || "general"}
        </span>
        <time className="text-xs text-ink/45" dateTime={note.created_at}>
          {formatNoteTime(note.created_at)}
        </time>
      </header>

      <p className="mt-3 whitespace-pre-wrap text-base leading-relaxed text-ink">{note.note}</p>

      {reminding && (
        <div className="mt-3 space-y-2 rounded-xl border border-gold/30 bg-amber-50/60 p-3">
          <label className="text-xs font-medium text-ink/60">When? (e.g. tomorrow at 5pm, Monday at 10)</label>
          <div className="flex gap-2">
            <input type="text" value={remindTimeText} onChange={(e) => onRemindTimeChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void onRemindSubmit(note); if (e.key === "Escape") onRemindCancel(); }}
              placeholder="e.g. tomorrow at 5pm" disabled={settingReminder}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="flex-1 rounded-lg border border-sage/25 bg-white px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/35 focus:border-sage disabled:opacity-50" />
            <button type="button" onClick={() => void onRemindSubmit(note)} disabled={settingReminder || !remindTimeText.trim()}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg bg-gold px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50">
              {settingReminder && <Spinner size={11} />}
              <span>{settingReminder ? "Setting…" : "Set"}</span>
            </button>
            <button type="button" onClick={onRemindCancel} disabled={settingReminder}
              className="inline-flex min-h-[34px] items-center rounded-lg border border-charcoal/15 px-2.5 py-1.5 text-xs text-ink/55 transition hover:bg-charcoal/5 disabled:opacity-50">
              Cancel
            </button>
          </div>
          {reminderInputError && <p className="text-xs text-danger">{reminderInputError}</p>}
        </div>
      )}

      {delegating && (
        <div className="mt-3 space-y-2 rounded-xl border border-charcoal/15 bg-charcoal/5 p-3">
          <label className="text-xs font-medium text-ink/60">Who should handle this?</label>
          <div className="flex gap-2">
            <select value={delegatePersonId} onChange={(e) => onDelegatePersonChange(e.target.value)} disabled={sendingDelegate}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="flex-1 rounded-lg border border-sage/25 bg-white px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sage disabled:opacity-50">
              <option value="">Select a person…</option>
              {peopleItems.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.phone ? "" : " (no phone)"}</option>
              ))}
            </select>
            <button type="button" onClick={() => void onDelegateSubmit(note)} disabled={sendingDelegate || !delegatePersonId}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg bg-charcoal px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
              {sendingDelegate && <Spinner size={11} />}
              <span>{sendingDelegate ? "Sending…" : "Send"}</span>
            </button>
            <button type="button" onClick={onDelegateCancel} disabled={sendingDelegate}
              className="inline-flex min-h-[34px] items-center rounded-lg border border-charcoal/15 px-2.5 py-1.5 text-xs text-ink/55 transition hover:bg-charcoal/5 disabled:opacity-50">
              Cancel
            </button>
          </div>
          {delegateError && <p className="text-xs text-danger">{delegateError}</p>}
        </div>
      )}

      {addingToCalendar && (
        <div className="mt-3 space-y-2 rounded-xl border border-sky-200 bg-sky-50/60 p-3">
          <label className="text-xs font-medium text-ink/60">When? (e.g. tomorrow at 11, Monday at 2pm)</label>
          <div className="flex gap-2">
            <input type="text" value={calendarTimeText} onChange={(e) => onCalendarTimeChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void onCalendarSubmit(note); if (e.key === "Escape") onCalendarCancel(); }}
              placeholder="e.g. tomorrow at 11am" disabled={settingCalendar}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="flex-1 rounded-lg border border-sage/25 bg-white px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/35 focus:border-sky-400 disabled:opacity-50" />
            <button type="button" onClick={() => void onCalendarSubmit(note)} disabled={settingCalendar || !calendarTimeText.trim()}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50">
              {settingCalendar && <Spinner size={11} />}
              <span>{settingCalendar ? "Adding…" : "Add"}</span>
            </button>
            <button type="button" onClick={onCalendarCancel} disabled={settingCalendar}
              className="inline-flex min-h-[34px] items-center rounded-lg border border-charcoal/15 px-2.5 py-1.5 text-xs text-ink/55 transition hover:bg-charcoal/5 disabled:opacity-50">
              Cancel
            </button>
          </div>
          {calendarError && <p className="text-xs text-danger">{calendarError}</p>}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-sage/15 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {taskMade ? (
            <span className="text-xs font-medium text-sage">Task created.</span>
          ) : (
            <button type="button" onClick={() => void onMakeTask(note)} disabled={busy || reminding || delegating}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-sage/35 bg-sage/10 px-3 py-1 text-xs font-medium text-sage transition hover:bg-sage/15 disabled:cursor-not-allowed disabled:opacity-50">
              {makingTask && <Spinner size={12} />}
              <span>{makingTask ? "Creating…" : "Make Task"}</span>
            </button>
          )}

          {reminderSet ? (
            <span className="text-xs font-medium text-gold">Reminder set.</span>
          ) : !reminding ? (
            <button type="button" onClick={() => onRemindMe(note)} disabled={busy || delegating}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-gold/35 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50">
              <span>Remind Me</span>
            </button>
          ) : null}

          {delegatedName ? (
            <span className="text-xs font-medium text-charcoal/70">Sent to {delegatedName}.</span>
          ) : !delegating ? (
            <button type="button" onClick={() => void onDelegate(note)} disabled={busy || reminding || addingToCalendar}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-charcoal/20 bg-charcoal/5 px-3 py-1 text-xs font-medium text-charcoal/75 transition hover:bg-charcoal/10 disabled:cursor-not-allowed disabled:opacity-50">
              <span>Delegate</span>
            </button>
          ) : null}

          {calendarAdded ? (
            <span className="text-xs font-medium text-sky-700">Added to calendar.</span>
          ) : !addingToCalendar ? (
            <button type="button" onClick={() => onAddToCalendar(note)} disabled={busy || reminding || delegating}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50">
              <span>Add to Calendar</span>
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-ink/45">{note.source === "manual" ? "Manual" : "Carson"}</span>
          <button type="button" onClick={() => void onDelete(note)} disabled={deleting || reminding || delegating || addingToCalendar}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-800 transition hover:bg-rose-100 disabled:opacity-50">
            {deleting && <Spinner size={12} />}
            <span>{deleting ? "Deleting..." : confirmingDelete ? "Tap again" : "Delete"}</span>
          </button>
        </div>
      </div>
    </article>
  );
}

function formatNoteTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
