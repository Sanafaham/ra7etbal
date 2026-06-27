/**
 * Todos — active personal commitments.
 * Mirrors Inbox.tsx's note-card pattern, reusing the same Remind Me /
 * Delegate / Add to Calendar conversion flows. Distinct from Notes
 * (passive information) — see carson-todos.ts header comment.
 */
import { useEffect, useMemo, useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import {
  archiveTodo,
  completeTodo,
  createTodo,
  deleteTodo,
  listAllTodos,
  reopenTodo,
  type CarsonTodo,
} from "../lib/carson-todos";
import { saveCarsonNote } from "../lib/carson-notes";
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

function rewriteOwnerPronouns(text: string, ownerName?: string | null): string {
  const name = ownerName?.trim() || "the sender";
  return text
    .replace(/\bmy\b/gi, `${name}'s`)
    .replace(/\bmyself\b/gi, name)
    .replace(/\bme\b/gi, name)
    .replace(/\bI\b/g, name);
}

export default function Todos({ headerless = false }: { headerless?: boolean } = {}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [todos, setTodos] = useState<CarsonTodo[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [movingNoteId, setMovingNoteId] = useState<string | null>(null);
  const [movedToNotesIds, setMovedToNotesIds] = useState<Set<string>>(new Set());
  const [openOverflowId, setOpenOverflowId] = useState<string | null>(null);

  // ── Remind Me ────────────────────────────────────────────────────────────
  const [remindingId, setRemindingId] = useState<string | null>(null);
  const [remindTimeText, setRemindTimeText] = useState("");
  const [settingReminderId, setSettingReminderId] = useState<string | null>(null);
  const [reminderInputError, setReminderInputError] = useState<string | null>(null);
  const [reminderSetIds, setReminderSetIds] = useState<Set<string>>(new Set());

  // ── Delegate ─────────────────────────────────────────────────────────────
  const [delegatingId, setDelegatingId] = useState<string | null>(null);
  const [delegatePersonId, setDelegatePersonId] = useState<string>("");
  const [sendingDelegateId, setSendingDelegateId] = useState<string | null>(null);
  const [delegateError, setDelegateError] = useState<string | null>(null);
  const [delegatedMap, setDelegatedMap] = useState<Map<string, string>>(new Map());

  // ── Calendar ─────────────────────────────────────────────────────────────
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [calendarTimeText, setCalendarTimeText] = useState("");
  const [settingCalendarId, setSettingCalendarId] = useState<string | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarAddedIds, setCalendarAddedIds] = useState<Set<string>>(new Set());

  const peopleItems = usePeopleStore((state) => state.items);
  const trimmedDraft = draft.trim();
  const canSave = !!userId && trimmedDraft.length > 0 && !saving;
  const initialLoading = status === "loading" && todos.length === 0;

  const activeTodos = useMemo(() => todos.filter((t) => t.status === "active"), [todos]);
  const completedTodos = useMemo(() => todos.filter((t) => t.status === "completed"), [todos]);

  async function reload() {
    if (!userId) return;
    setStatus((s) => (s === "ready" ? "ready" : "loading"));
    setError(null);
    try {
      const loaded = await listAllTodos(100);
      setTodos(loaded);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load to-dos.");
      setStatus("error");
    }
  }

  useEffect(() => {
    if (!userId) { setTodos([]); setStatus("idle"); return; }
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await createTodo(trimmedDraft, null, "manual");
      setDraft("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save to-do.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleDone(todo: CarsonTodo) {
    if (togglingId) return;
    setTogglingId(todo.id);
    setError(null);
    try {
      if (todo.status === "completed") await reopenTodo(todo.id);
      else await completeTodo(todo.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update to-do.");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(todo: CarsonTodo) {
    if (deletingId) return;
    if (confirmingDeleteId !== todo.id) {
      setConfirmingDeleteId(todo.id);
      window.setTimeout(() => setConfirmingDeleteId((c) => (c === todo.id ? null : c)), 3000);
      return;
    }
    setConfirmingDeleteId(null);
    setDeletingId(todo.id);
    setError(null);
    try {
      await deleteTodo(todo.id);
      setTodos((prev) => prev.filter((i) => i.id !== todo.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete to-do.");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleArchive(todo: CarsonTodo) {
    setError(null);
    try {
      await archiveTodo(todo.id);
      setTodos((prev) => prev.filter((i) => i.id !== todo.id));
      setOpenOverflowId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive to-do.");
    }
  }

  // ── Move to Notes ────────────────────────────────────────────────────────

  async function handleMoveToNotes(todo: CarsonTodo) {
    if (movingNoteId) return;
    setMovingNoteId(todo.id);
    setError(null);
    try {
      const noteText = todo.description ? `${todo.title} — ${todo.description}` : todo.title;
      await saveCarsonNote(noteText, "general", "todo_conversion");
      await archiveTodo(todo.id);
      setMovedToNotesIds((prev) => new Set(prev).add(todo.id));
      setTodos((prev) => prev.filter((i) => i.id !== todo.id));
      setOpenOverflowId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move to Notes.");
    } finally {
      setMovingNoteId(null);
    }
  }

  // ── Delegate handlers ─────────────────────────────────────────────────────

  async function handleOpenDelegate(todo: CarsonTodo) {
    const authUserId = useAuthStore.getState().user?.id ?? userId;
    if (authUserId) {
      const ps = usePeopleStore.getState();
      if (ps.status === "idle" || ps.items.length === 0) await usePeopleStore.getState().loadFor(authUserId);
    }
    setDelegatingId(todo.id);
    setDelegatePersonId("");
    setDelegateError(null);
  }
  function handleCancelDelegate() { setDelegatingId(null); setDelegatePersonId(""); setDelegateError(null); }

  async function handleDelegateSubmit(todo: CarsonTodo) {
    if (!delegatePersonId || sendingDelegateId) return;
    const people = usePeopleStore.getState().items;
    const person = people.find((p) => p.id === delegatePersonId);
    if (!person) { setDelegateError("Person not found."); return; }
    if (!person.phone) { setDelegateError(`${person.name} has no phone number saved.`); return; }
    const authUserId = useAuthStore.getState().user?.id ?? userId;
    if (!authUserId) return;
    const ownerName = useProfileStore.getState().displayName ?? undefined;
    setSendingDelegateId(todo.id);
    setDelegateError(null);
    try {
      const messageText = stripClosingLine(rewriteOwnerPronouns(buildDelegationMessage({ personName: person.name, taskText: todo.title, personNotes: person.notes ?? null, ownerName: ownerName ?? null }), ownerName));
      const taskId = crypto.randomUUID();
      const confirmationUrl = `${window.location.origin}/confirm?task=${taskId}`;
      const task = await createTask({ id: taskId, user_id: authUserId, description: todo.title, type: "delegation", assigned_to: person.name, status: "pending", needs_follow_up: true, confirmation_url: confirmationUrl, due_at: null });
      let messageRecord;
      try { messageRecord = await createMessage({ user_id: authUserId, task_id: task.id, recipient: person.name, content: messageText, confirmation_url: confirmationUrl }); } catch { /* non-fatal */ }
      await sendWhatsAppTask({ to: person.phone, messageText, confirmationLink: confirmationUrl, messageRecordId: messageRecord?.id ?? null, taskId: task.id, recipientName: person.name, ownerName: ownerName ?? null });
      if (task.created_at) scheduleEscalationMessages(task.id, task.created_at).catch((err) => console.error("[todos] escalation schedule failed:", err));
      useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
      setDelegatedMap((prev) => new Map(prev).set(todo.id, person.name));
      setDelegatingId(null);
      setDelegatePersonId("");
    } catch (err) {
      setDelegateError(err instanceof Error ? err.message : "Could not send delegation.");
    } finally {
      setSendingDelegateId(null);
    }
  }

  // ── Calendar handlers ─────────────────────────────────────────────────────

  function handleOpenCalendar(todo: CarsonTodo) { setCalendarId(todo.id); setCalendarTimeText(""); setCalendarError(null); setOpenOverflowId(null); }
  function handleCancelCalendar() { setCalendarId(null); setCalendarTimeText(""); setCalendarError(null); }

  async function handleCalendarSubmit(todo: CarsonTodo) {
    const phrase = calendarTimeText.trim();
    if (!phrase) { setCalendarError("Enter a time, e.g. tomorrow at 11"); return; }
    if (settingCalendarId) return;
    const parsed = parseVoiceTime(phrase);
    if (parsed.error || !parsed.dueAt) { setCalendarError(`Couldn't parse "${phrase}". Try: tomorrow at 11am`); return; }
    const d = new Date(parsed.dueAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setSettingCalendarId(todo.id);
    setCalendarError(null);
    try {
      const result = await createCalendarEvent(todo.title, date, time);
      if (!result.ok) { setCalendarError(result.code === "reconnect_required" ? "Google Calendar is not connected. Reconnect in Settings." : "Couldn't add the event."); return; }
      setCalendarAddedIds((prev) => new Set(prev).add(todo.id));
      setCalendarId(null);
      setCalendarTimeText("");
    } catch (err) {
      setCalendarError(err instanceof Error ? err.message : "Couldn't add the event.");
    } finally {
      setSettingCalendarId(null);
    }
  }

  // ── Remind Me handlers ────────────────────────────────────────────────────

  function handleOpenRemind(todo: CarsonTodo) { setRemindingId(todo.id); setRemindTimeText(""); setReminderInputError(null); }
  function handleCancelRemind() { setRemindingId(null); setRemindTimeText(""); setReminderInputError(null); }

  async function handleRemindSubmit(todo: CarsonTodo) {
    const phrase = remindTimeText.trim();
    if (!phrase) { setReminderInputError("Enter a time, e.g. tomorrow at 5pm"); return; }
    if (settingReminderId) return;
    const authUserId = useAuthStore.getState().user?.id ?? userId;
    if (!authUserId) return;
    const parsed = parseVoiceTime(phrase);
    if (parsed.error || !parsed.dueAt) { setReminderInputError(`Couldn't parse "${phrase}". Try: tomorrow at 5pm`); return; }
    setSettingReminderId(todo.id);
    setReminderInputError(null);
    try {
      const task = await createTask({ user_id: authUserId, description: todo.title, type: "reminder", assigned_to: null, status: "pending", needs_follow_up: false, confirmation_url: null, due_at: parsed.dueAt });
      scheduleReminderPush(task.id, parsed.dueAt).catch((err) => console.error("[todos] QStash reminder schedule failed:", err));
      useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
      setReminderSetIds((prev) => new Set(prev).add(todo.id));
      setRemindingId(null);
      setRemindTimeText("");
    } catch (err) {
      setReminderInputError(err instanceof Error ? err.message : "Could not set reminder.");
    } finally {
      setSettingReminderId(null);
    }
  }

  return (
    <section className="space-y-4">
      {!headerless && (
        <header>
          <h1 className="text-2xl font-semibold text-ink">To-do</h1>
          <p className="text-sm text-ink/55">Active personal commitments.</p>
        </header>
      )}

      {/* ── Add a to-do ── */}
      <section className="rounded-2xl border border-sage/20 bg-white/70 p-4 shadow-sm">
        <label htmlFor="manual-todo" className="text-xs font-medium uppercase tracking-wide text-ink/60">
          Add a to-do
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="manual-todo"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); }}
            placeholder="Buy flowers, renew passport…"
            className="flex-1 rounded-xl border border-sage/20 bg-cream/30 px-3 py-2 text-base text-ink outline-none placeholder:text-ink/30 focus:border-sage focus:bg-white"
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            aria-busy={saving}
            className="inline-flex min-h-[38px] shrink-0 items-center justify-center gap-2 rounded-full bg-sage px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:bg-sage/35"
          >
            {saving && <Spinner size={13} />}
            <span>{saving ? "Adding..." : "Add"}</span>
          </button>
        </div>
      </section>

      {error && (
        <AuthNotice kind="error">
          {error}{" "}
          {userId && <button type="button" onClick={() => void reload()} className="ml-1 underline">Try again</button>}
        </AuthNotice>
      )}

      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading to-dos" />
        </div>
      )}

      {status === "ready" && (
        <>
          <section className="space-y-2.5">
            {activeTodos.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-sage/30 bg-white/50 p-8 text-center text-sm text-ink/60">
                Nothing on your to-do list. Ask Carson to add one.
              </div>
            ) : (
              <ul className="space-y-3">
                {activeTodos.map((todo) => (
                  <li key={todo.id}>
                    <TodoCard
                      todo={todo}
                      toggling={togglingId === todo.id}
                      onToggleDone={handleToggleDone}
                      deleting={deletingId === todo.id}
                      confirmingDelete={confirmingDeleteId === todo.id}
                      onDelete={handleDelete}
                      onArchive={handleArchive}
                      movingNote={movingNoteId === todo.id}
                      movedToNotes={movedToNotesIds.has(todo.id)}
                      onMoveToNotes={handleMoveToNotes}
                      reminding={remindingId === todo.id}
                      remindTimeText={remindingId === todo.id ? remindTimeText : ""}
                      onRemindTimeChange={setRemindTimeText}
                      settingReminder={settingReminderId === todo.id}
                      reminderSet={reminderSetIds.has(todo.id)}
                      reminderInputError={remindingId === todo.id ? reminderInputError : null}
                      onRemindMe={handleOpenRemind}
                      onRemindSubmit={handleRemindSubmit}
                      onRemindCancel={handleCancelRemind}
                      delegating={delegatingId === todo.id}
                      delegatePersonId={delegatingId === todo.id ? delegatePersonId : ""}
                      onDelegatePersonChange={setDelegatePersonId}
                      sendingDelegate={sendingDelegateId === todo.id}
                      delegatedName={delegatedMap.get(todo.id) ?? null}
                      delegateError={delegatingId === todo.id ? delegateError : null}
                      onDelegate={handleOpenDelegate}
                      onDelegateSubmit={handleDelegateSubmit}
                      onDelegateCancel={handleCancelDelegate}
                      peopleItems={peopleItems}
                      addingToCalendar={calendarId === todo.id}
                      calendarTimeText={calendarId === todo.id ? calendarTimeText : ""}
                      onCalendarTimeChange={setCalendarTimeText}
                      settingCalendar={settingCalendarId === todo.id}
                      calendarAdded={calendarAddedIds.has(todo.id)}
                      calendarError={calendarId === todo.id ? calendarError : null}
                      onAddToCalendar={handleOpenCalendar}
                      onCalendarSubmit={handleCalendarSubmit}
                      onCalendarCancel={handleCancelCalendar}
                      overflowOpen={openOverflowId === todo.id}
                      onToggleOverflow={() => setOpenOverflowId((id) => (id === todo.id ? null : todo.id))}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {completedTodos.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer select-none list-none items-center gap-2 py-1 px-1">
                <span className="text-xs font-medium uppercase tracking-wide text-ink/55">Done</span>
                <span className="text-xs text-ink/55">{completedTodos.length}</span>
              </summary>
              <ul className="mt-2 space-y-2">
                {completedTodos.map((todo) => (
                  <li key={todo.id} className="flex items-center justify-between rounded-xl border border-sage/15 bg-white/50 px-3 py-2">
                    <span className="text-sm text-ink/50 line-through">{todo.title}</span>
                    <button type="button" onClick={() => void handleToggleDone(todo)} disabled={togglingId === todo.id} className="text-xs font-medium text-sage underline disabled:opacity-50">
                      Reopen
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

// ── TodoCard ─────────────────────────────────────────────────────────────────

function TodoCard({
  todo, toggling, onToggleDone,
  deleting, confirmingDelete, onDelete, onArchive,
  movingNote, movedToNotes, onMoveToNotes,
  reminding, remindTimeText, onRemindTimeChange, settingReminder, reminderSet, reminderInputError,
  onRemindMe, onRemindSubmit, onRemindCancel,
  delegating, delegatePersonId, onDelegatePersonChange, sendingDelegate, delegatedName, delegateError,
  onDelegate, onDelegateSubmit, onDelegateCancel, peopleItems,
  addingToCalendar, calendarTimeText, onCalendarTimeChange, settingCalendar, calendarAdded, calendarError,
  onAddToCalendar, onCalendarSubmit, onCalendarCancel,
  overflowOpen, onToggleOverflow,
}: {
  todo: CarsonTodo;
  toggling: boolean; onToggleDone: (todo: CarsonTodo) => Promise<void>;
  deleting: boolean; confirmingDelete: boolean; onDelete: (todo: CarsonTodo) => Promise<void>;
  onArchive: (todo: CarsonTodo) => Promise<void>;
  movingNote: boolean; movedToNotes: boolean; onMoveToNotes: (todo: CarsonTodo) => Promise<void>;
  reminding: boolean; remindTimeText: string; onRemindTimeChange: (v: string) => void;
  settingReminder: boolean; reminderSet: boolean; reminderInputError: string | null;
  onRemindMe: (todo: CarsonTodo) => void; onRemindSubmit: (todo: CarsonTodo) => Promise<void>; onRemindCancel: () => void;
  delegating: boolean; delegatePersonId: string; onDelegatePersonChange: (id: string) => void;
  sendingDelegate: boolean; delegatedName: string | null; delegateError: string | null;
  onDelegate: (todo: CarsonTodo) => Promise<void>; onDelegateSubmit: (todo: CarsonTodo) => Promise<void>; onDelegateCancel: () => void;
  peopleItems: import("../types/person").Person[];
  addingToCalendar: boolean; calendarTimeText: string; onCalendarTimeChange: (v: string) => void;
  settingCalendar: boolean; calendarAdded: boolean; calendarError: string | null;
  onAddToCalendar: (todo: CarsonTodo) => void; onCalendarSubmit: (todo: CarsonTodo) => Promise<void>; onCalendarCancel: () => void;
  overflowOpen: boolean; onToggleOverflow: () => void;
}) {
  const busy = toggling || deleting || movingNote || settingReminder || sendingDelegate || settingCalendar;

  return (
    <article className="rounded-2xl border border-sage/20 bg-white/85 p-4 shadow-sm">
      <header className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => void onToggleDone(todo)}
          disabled={toggling}
          aria-label="Mark done"
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-sage/40 text-sage transition hover:border-sage hover:bg-sage/10 disabled:opacity-50"
        >
          {toggling && <Spinner size={11} />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{todo.title}</p>
          {todo.description && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink/60">{todo.description}</p>
          )}
        </div>
        <time className="shrink-0 text-xs text-ink/40" dateTime={todo.created_at}>
          {formatTodoTime(todo.created_at)}
        </time>
      </header>

      {/* ── Remind Me inline ── */}
      {reminding && (
        <div className="mt-3 space-y-2 rounded-xl border border-gold/25 bg-amber-50/50 p-3">
          <label className="text-xs font-medium text-ink/55">When? (e.g. tomorrow at 5pm)</label>
          <div className="flex gap-2">
            <input type="text" value={remindTimeText} onChange={(e) => onRemindTimeChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void onRemindSubmit(todo); if (e.key === "Escape") onRemindCancel(); }}
              placeholder="tomorrow at 5pm"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus disabled={settingReminder}
              className="flex-1 rounded-lg border border-sage/25 bg-white px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-sage disabled:opacity-50" />
            <button type="button" onClick={() => void onRemindSubmit(todo)} disabled={settingReminder || !remindTimeText.trim()}
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
            <button type="button" onClick={() => void onDelegateSubmit(todo)} disabled={sendingDelegate || !delegatePersonId}
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
              onKeyDown={(e) => { if (e.key === "Enter") void onCalendarSubmit(todo); if (e.key === "Escape") onCalendarCancel(); }}
              placeholder="tomorrow at 11am"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus disabled={settingCalendar}
              className="flex-1 rounded-lg border border-sage/25 bg-white px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-sky-400 disabled:opacity-50" />
            <button type="button" onClick={() => void onCalendarSubmit(todo)} disabled={settingCalendar || !calendarTimeText.trim()}
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
          <button type="button" onClick={() => onRemindMe(todo)} disabled={busy || delegating || addingToCalendar}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-100 disabled:opacity-50">
            Remind Me
          </button>
        ) : null}

        {/* Delegate */}
        {delegatedName ? (
          <span className="text-xs font-medium text-ink/60">Sent to {delegatedName} ✓</span>
        ) : !delegating ? (
          <button type="button" onClick={() => void onDelegate(todo)} disabled={busy || reminding || addingToCalendar}
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
            <div className="absolute right-0 bottom-full mb-1.5 z-20 min-w-[170px] rounded-2xl border border-sage/20 bg-white shadow-xl">
              {/* Add to Calendar */}
              {calendarAdded ? (
                <div className="px-4 py-3 text-xs font-medium text-sky-700">Added to calendar ✓</div>
              ) : (
                <button type="button" onClick={() => onAddToCalendar(todo)} disabled={busy}
                  className="flex w-full items-center gap-3 px-4 py-3 text-sm text-ink transition hover:bg-sage/5 rounded-t-2xl disabled:opacity-50">
                  Add to Calendar
                </button>
              )}

              {/* Move to Notes */}
              {movedToNotes ? (
                <div className="px-4 py-3 text-xs font-medium text-sage">Moved to Notes ✓</div>
              ) : (
                <button type="button" onClick={() => void onMoveToNotes(todo)} disabled={busy}
                  className="flex w-full items-center gap-3 border-t border-sage/10 px-4 py-3 text-sm text-ink transition hover:bg-sage/5 disabled:opacity-50">
                  {movingNote && <Spinner size={12} />}
                  <span>{movingNote ? "Moving…" : "Move to Notes"}</span>
                </button>
              )}

              {/* Archive */}
              <button type="button" onClick={() => void onArchive(todo)} disabled={busy}
                className="flex w-full items-center gap-3 border-t border-sage/10 px-4 py-3 text-sm text-ink transition hover:bg-sage/5 disabled:opacity-50">
                Archive
              </button>

              {/* Delete */}
              <button type="button" onClick={() => void onDelete(todo)} disabled={deleting || reminding || delegating || addingToCalendar}
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

function formatTodoTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
