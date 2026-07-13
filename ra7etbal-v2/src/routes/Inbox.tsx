/**
 * Inbox — Notes (searchable).
 * Note actions: Remind Me + Delegate visible; Make Task / Add to Calendar / Delete in ··· overflow.
 * Refresh on mount only — no visible refresh button.
 */
import { useEffect, useMemo, useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
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
import { createReminderTask } from "../lib/reminders";
import { createCalendarEvent } from "../lib/calendar";
import { createDelegationTaskAndMessage } from "../lib/delegations";
import { sendWhatsAppTask } from "../lib/whatsapp";
import { usePeopleStore } from "../stores/people";
import { useProfileStore } from "../stores/profile";

export default function Inbox({ headerless = false }: { headerless?: boolean } = {}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [notes, setNotes] = useState<CarsonNote[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [makingTaskId, setMakingTaskId] = useState<string | null>(null);
  const [madeTaskIds, setMadeTaskIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  /** Which note has the ··· overflow menu open. */
  const [openOverflowId, setOpenOverflowId] = useState<string | null>(null);

  // ── Remind Me ────────────────────────────────────────────────────────────
  const [remindingNoteId, setRemindingNoteId] = useState<string | null>(null);
  const [remindTimeText, setRemindTimeText] = useState("");
  const [settingReminderId, setSettingReminderId] = useState<string | null>(null);
  const [reminderInputError, setReminderInputError] = useState<string | null>(null);
  const [reminderSetIds, setReminderSetIds] = useState<Set<string>>(new Set());

  // ── Delegate ─────────────────────────────────────────────────────────────
  const [delegatingNoteId, setDelegatingNoteId] = useState<string | null>(null);
  const [delegatePersonId, setDelegatePersonId] = useState<string>("");
  const [sendingDelegateId, setSendingDelegateId] = useState<string | null>(null);
  const [delegateError, setDelegateError] = useState<string | null>(null);
  const [delegatedMap, setDelegatedMap] = useState<Map<string, string>>(new Map());

  // ── Calendar ─────────────────────────────────────────────────────────────
  const [calendarNoteId, setCalendarNoteId] = useState<string | null>(null);
  const [calendarTimeText, setCalendarTimeText] = useState("");
  const [settingCalendarId, setSettingCalendarId] = useState<string | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarAddedIds, setCalendarAddedIds] = useState<Set<string>>(new Set());

  const peopleItems = usePeopleStore((state) => state.items);
  const trimmedDraft = draft.trim();
  const canSave = !!userId && trimmedDraft.length > 0 && !saving;
  const initialLoading = status === "loading" && notes.length === 0;

  const filteredNotes = useMemo(() => {
    if (!searchQuery.trim()) return notes;
    const q = searchQuery.toLowerCase();
    return notes.filter((n) => n.note.toLowerCase().includes(q) || (n.category ?? "").toLowerCase().includes(q));
  }, [notes, searchQuery]);

  async function reload() {
    if (!userId) return;
    setStatus((s) => s === "ready" ? "ready" : "loading");
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
      window.setTimeout(() => setConfirmingDeleteId((c) => c === note.id ? null : c), 3000);
      return;
    }
    setConfirmingDeleteId(null);
    setDeletingId(note.id);
    setError(null);
    try {
      await deleteCarsonNote(note.id);
      setNotes((prev) => prev.filter((i) => i.id !== note.id));
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
      const task = await createTask({ user_id: authUserId, description: note.note, type: "action", assigned_to: null, status: "pending", needs_follow_up: false, confirmation_url: null, due_at: null });
      useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
      setMadeTaskIds((prev) => new Set(prev).add(note.id));
      setOpenOverflowId(null);
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
      if (ps.status === "idle" || ps.items.length === 0) await usePeopleStore.getState().loadFor(authUserId);
    }
    setDelegatingNoteId(note.id);
    setDelegatePersonId("");
    setDelegateError(null);
  }
  function handleCancelDelegate() { setDelegatingNoteId(null); setDelegatePersonId(""); setDelegateError(null); }

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
      const created = await createDelegationTaskAndMessage({
        source: "inbox",
        userId: authUserId,
        assignee: person,
        taskText: note.note,
        ownerName: ownerName ?? null,
        onEscalationError: (err) => console.error("[inbox] escalation schedule failed:", err),
      });
      await sendWhatsAppTask({
        to: person.phone,
        messageText: created.messageText,
        confirmationLink: created.confirmationUrl,
        messageRecordId: created.message?.id ?? null,
        taskId: created.task.id,
        recipientName: person.name,
        ownerName: ownerName ?? null,
      });
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

  function handleOpenCalendar(note: CarsonNote) { setCalendarNoteId(note.id); setCalendarTimeText(""); setCalendarError(null); setOpenOverflowId(null); }
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
      if (!result.ok) { setCalendarError(result.code === "reconnect_required" ? "Google Calendar is not connected. Reconnect in Settings." : "Couldn't add the event."); return; }
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
      await createReminderTask({
        userId: authUserId,
        text: note.note,
        dueAt: parsed.dueAt,
        source: "inbox",
      });
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
    <section className="space-y-4">
      {/* ── Header (hidden when embedded in Updates) ── */}
      {!headerless && (
        <header>
          <h1 className="text-2xl font-semibold text-ink">Inbox</h1>
          <p className="text-sm text-ink/55">Ideas, thoughts, and items to process.</p>
        </header>
      )}

      {/* ── Search ── */}
      <div className="relative">
        <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/30" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search notes…"
          className="w-full rounded-2xl border border-sage/20 bg-white/70 py-2.5 pl-9 pr-4 text-sm text-ink placeholder:text-ink/35 outline-none focus:border-sage/40 focus:bg-white"
        />
      </div>

      {/* ── Add a note ── */}
      {!searchQuery && (
        <section className="rounded-2xl border border-sage/20 bg-white/70 p-4 shadow-sm">
          <label htmlFor="manual-note-inbox" className="text-xs font-medium uppercase tracking-wide text-ink/60">
            Add a note
          </label>
          <textarea
            id="manual-note-inbox"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a note, idea, or thought…"
            rows={3}
            className="mt-2 block min-h-[80px] w-full resize-y rounded-xl border border-sage/20 bg-cream/30 px-3 py-2 text-base leading-relaxed text-ink outline-none placeholder:text-ink/30 focus:border-sage focus:bg-white"
          />
          <div className="mt-2.5 flex justify-end">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave}
              aria-busy={saving}
              className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-full bg-sage px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:bg-sage/35"
            >
              {saving && <Spinner size={13} />}
              <span>{saving ? "Saving..." : "Save"}</span>
            </button>
          </div>
        </section>
      )}

      {error && (
        <AuthNotice kind="error">
          {error}{" "}
          {userId && <button type="button" onClick={() => void reload()} className="ml-1 underline">Try again</button>}
        </AuthNotice>
      )}

      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading notes" />
        </div>
      )}

      {/* ── Notes section ── */}
      {status === "ready" && (
        <section className="space-y-2.5">
          {filteredNotes.length > 0 && (
            <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-ink/50">
              Notes{searchQuery ? ` · ${filteredNotes.length} result${filteredNotes.length !== 1 ? "s" : ""}` : ""}
            </h2>
          )}

          {filteredNotes.length === 0 && searchQuery && (
            <div className="rounded-2xl border border-dashed border-sage/25 bg-white/50 px-4 py-6 text-center text-sm text-ink/45">
              No notes match "{searchQuery}"
            </div>
          )}

          {filteredNotes.length === 0 && !searchQuery && notes.length === 0 && (
            <div className="rounded-2xl border border-dashed border-sage/30 bg-white/50 p-8 text-center text-sm text-ink/60">
              No notes yet. Ask Carson to save an idea or thought.
            </div>
          )}

          <ul className="space-y-3">
            {filteredNotes.map((note) => (
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
                  overflowOpen={openOverflowId === note.id}
                  onToggleOverflow={() => setOpenOverflowId((id) => id === note.id ? null : note.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

// ── NoteCard ─────────────────────────────────────────────────────────────────

function NoteCard({
  note, deleting, confirmingDelete, onDelete,
  makingTask, taskMade, onMakeTask,
  reminding, remindTimeText, onRemindTimeChange, settingReminder, reminderSet, reminderInputError,
  onRemindMe, onRemindSubmit, onRemindCancel,
  delegating, delegatePersonId, onDelegatePersonChange, sendingDelegate, delegatedName, delegateError,
  onDelegate, onDelegateSubmit, onDelegateCancel, peopleItems,
  addingToCalendar, calendarTimeText, onCalendarTimeChange, settingCalendar, calendarAdded, calendarError,
  onAddToCalendar, onCalendarSubmit, onCalendarCancel,
  overflowOpen, onToggleOverflow,
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
  overflowOpen: boolean; onToggleOverflow: () => void;
}) {
  const busy = makingTask || deleting || settingReminder || sendingDelegate || settingCalendar;

  return (
    <article className="rounded-2xl border border-sage/20 bg-white/85 p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <span className="rounded-full border border-sage/25 bg-sage/8 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-sage">
          {note.category || "general"}
        </span>
        <time className="shrink-0 text-xs text-ink/40" dateTime={note.created_at}>
          {formatNoteTime(note.created_at)}
        </time>
      </header>

      <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{note.note}</p>

      {/* ── Remind Me inline ── */}
      {reminding && (
        <div className="mt-3 space-y-2 rounded-xl border border-gold/25 bg-amber-50/50 p-3">
          <label className="text-xs font-medium text-ink/55">When? (e.g. tomorrow at 5pm)</label>
          <div className="flex gap-2">
            <input type="text" value={remindTimeText} onChange={(e) => onRemindTimeChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void onRemindSubmit(note); if (e.key === "Escape") onRemindCancel(); }}
              placeholder="tomorrow at 5pm"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus disabled={settingReminder}
              className="flex-1 rounded-lg border border-sage/25 bg-white px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-sage disabled:opacity-50" />
            <button type="button" onClick={() => void onRemindSubmit(note)} disabled={settingReminder || !remindTimeText.trim()}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg bg-gold px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-105 disabled:opacity-50">
              {settingReminder && <Spinner size={11} />}
              <span>{settingReminder ? "Setting…" : "Set"}</span>
            </button>
            <button type="button" onClick={onRemindCancel} disabled={settingReminder}
              className="inline-flex min-h-[34px] items-center rounded-lg border border-ink/10 px-2.5 py-1.5 text-xs text-ink/50 transition hover:bg-ink/5 disabled:opacity-50">
              Cancel
            </button>
          </div>
          {reminderInputError && <p className="text-xs text-danger">{reminderInputError}</p>}
        </div>
      )}

      {/* ── Delegate inline ── */}
      {delegating && (
        <div className="mt-3 space-y-2 rounded-xl border border-charcoal/10 bg-charcoal/5 p-3">
          <label className="text-xs font-medium text-ink/55">Who should handle this?</label>
          <div className="flex gap-2">
            <select value={delegatePersonId} onChange={(e) => onDelegatePersonChange(e.target.value)} disabled={sendingDelegate}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="flex-1 rounded-lg border border-sage/25 bg-white px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sage disabled:opacity-50">
              <option value="">Select a person…</option>
              {peopleItems.map((p) => <option key={p.id} value={p.id}>{p.name}{p.phone ? "" : " (no phone)"}</option>)}
            </select>
            <button type="button" onClick={() => void onDelegateSubmit(note)} disabled={sendingDelegate || !delegatePersonId}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg bg-charcoal px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-50">
              {sendingDelegate && <Spinner size={11} />}
              <span>{sendingDelegate ? "Sending…" : "Send"}</span>
            </button>
            <button type="button" onClick={onDelegateCancel} disabled={sendingDelegate}
              className="inline-flex min-h-[34px] items-center rounded-lg border border-ink/10 px-2.5 py-1.5 text-xs text-ink/50 transition hover:bg-ink/5 disabled:opacity-50">
              Cancel
            </button>
          </div>
          {delegateError && <p className="text-xs text-danger">{delegateError}</p>}
        </div>
      )}

      {/* ── Calendar inline ── */}
      {addingToCalendar && (
        <div className="mt-3 space-y-2 rounded-xl border border-sky-200 bg-sky-50/50 p-3">
          <label className="text-xs font-medium text-ink/55">When? (e.g. tomorrow at 11, Monday at 2pm)</label>
          <div className="flex gap-2">
            <input type="text" value={calendarTimeText} onChange={(e) => onCalendarTimeChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void onCalendarSubmit(note); if (e.key === "Escape") onCalendarCancel(); }}
              placeholder="tomorrow at 11am"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus disabled={settingCalendar}
              className="flex-1 rounded-lg border border-sage/25 bg-white px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-sky-400 disabled:opacity-50" />
            <button type="button" onClick={() => void onCalendarSubmit(note)} disabled={settingCalendar || !calendarTimeText.trim()}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-105 disabled:opacity-50">
              {settingCalendar && <Spinner size={11} />}
              <span>{settingCalendar ? "Adding…" : "Add"}</span>
            </button>
            <button type="button" onClick={onCalendarCancel} disabled={settingCalendar}
              className="inline-flex min-h-[34px] items-center rounded-lg border border-ink/10 px-2.5 py-1.5 text-xs text-ink/50 transition hover:bg-ink/5 disabled:opacity-50">
              Cancel
            </button>
          </div>
          {calendarError && <p className="text-xs text-danger">{calendarError}</p>}
        </div>
      )}

      {/* ── Footer: primary actions + overflow ── */}
      <div className="mt-3 flex items-center gap-2 border-t border-sage/10 pt-3">
        {/* Remind Me */}
        {reminderSet ? (
          <span className="text-xs font-medium text-gold">Reminder set ✓</span>
        ) : !reminding ? (
          <button type="button" onClick={() => onRemindMe(note)} disabled={busy || delegating || addingToCalendar}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-100 disabled:opacity-50">
            Remind Me
          </button>
        ) : null}

        {/* Delegate */}
        {delegatedName ? (
          <span className="text-xs font-medium text-ink/60">Sent to {delegatedName} ✓</span>
        ) : !delegating ? (
          <button type="button" onClick={() => void onDelegate(note)} disabled={busy || reminding || addingToCalendar}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-charcoal/15 bg-charcoal/5 px-3 py-1 text-xs font-medium text-charcoal/75 transition hover:bg-charcoal/10 disabled:opacity-50">
            Delegate
          </button>
        ) : null}

        {/* Overflow ··· */}
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={onToggleOverflow}
            aria-label="More actions"
            aria-expanded={overflowOpen}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink/40 transition hover:bg-ink/5 hover:text-ink/60"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
            </svg>
          </button>

          {overflowOpen && (
            <div className="absolute right-0 bottom-full mb-1.5 z-20 min-w-[160px] rounded-2xl border border-sage/20 bg-white shadow-xl">
              {/* Make Task */}
              {taskMade ? (
                <div className="px-4 py-3 text-xs font-medium text-sage">Task created ✓</div>
              ) : (
                <button type="button" onClick={() => void onMakeTask(note)} disabled={busy}
                  className="flex w-full items-center gap-3 px-4 py-3 text-sm text-ink transition hover:bg-sage/5 rounded-t-2xl disabled:opacity-50">
                  {makingTask && <Spinner size={12} />}
                  <span>{makingTask ? "Creating…" : "Make Task"}</span>
                </button>
              )}

              {/* Add to Calendar */}
              {calendarAdded ? (
                <div className="px-4 py-3 text-xs font-medium text-sky-700">Added to calendar ✓</div>
              ) : (
                <button type="button" onClick={() => onAddToCalendar(note)} disabled={busy}
                  className="flex w-full items-center gap-3 border-t border-sage/10 px-4 py-3 text-sm text-ink transition hover:bg-sage/5 disabled:opacity-50">
                  Add to Calendar
                </button>
              )}

              {/* Delete */}
              <button type="button" onClick={() => void onDelete(note)} disabled={deleting || reminding || delegating || addingToCalendar}
                className="flex w-full items-center gap-3 border-t border-sage/10 px-4 py-3 text-sm text-danger transition hover:bg-rose-50 rounded-b-2xl disabled:opacity-50">
                {deleting ? <Spinner size={12} /> : null}
                <span>{deleting ? "Deleting..." : confirmingDelete ? "Tap again to confirm" : "Delete"}</span>
              </button>
            </div>
          )}
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
