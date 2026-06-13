import { useEffect, useMemo, useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
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

export default function Notes() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [notes, setNotes] = useState<CarsonNote[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  /** Which note is currently being converted to a task. */
  const [makingTaskId, setMakingTaskId] = useState<string | null>(null);
  /** Notes that have been successfully converted — show "Task created." feedback. */
  const [madeTaskIds, setMadeTaskIds] = useState<Set<string>>(new Set());

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
    if (!userId) {
      setNotes([]);
      setStatus("idle");
      return;
    }
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
      // Refresh the tasks store so the new item appears in the Actions tab.
      useTasksStore.getState().loadFor(authUserId, { force: true }).catch(() => {});
      setMadeTaskIds((prev) => new Set(prev).add(note.id));
      console.log("[notes] task created from note:", task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create task.");
    } finally {
      setMakingTaskId(null);
    }
  }

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Notes</h1>
          <p className="text-sm text-ink/60">
            Ideas and thoughts Carson is holding for you.
          </p>
        </div>
        <RefreshButton onClick={reload} />
      </header>

      <section className="rounded-2xl border border-sage/30 bg-white/75 p-4 shadow-sm">
        <label
          htmlFor="manual-note"
          className="text-xs font-medium uppercase tracking-wide text-ink/55"
        >
          Add a note
        </label>
        <textarea
          id="manual-note"
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
            <button type="button" onClick={() => void reload()} className="ml-1 underline">
              Try again
            </button>
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
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteCard({
  note,
  deleting,
  confirmingDelete,
  onDelete,
  makingTask,
  taskMade,
  onMakeTask,
}: {
  note: CarsonNote;
  deleting: boolean;
  confirmingDelete: boolean;
  onDelete: (note: CarsonNote) => Promise<void>;
  makingTask: boolean;
  taskMade: boolean;
  onMakeTask: (note: CarsonNote) => Promise<void>;
}) {
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

      <p className="mt-3 whitespace-pre-wrap text-base leading-relaxed text-ink">
        {note.note}
      </p>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-sage/15 pt-3">
        <div className="flex items-center gap-2">
          {/* Make Task — converts note text into a pending action task */}
          {taskMade ? (
            <span className="text-xs font-medium text-sage">Task created.</span>
          ) : (
            <button
              type="button"
              onClick={() => void onMakeTask(note)}
              disabled={makingTask || deleting}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-sage/35 bg-sage/8 px-3 py-1 text-xs font-medium text-sage transition hover:bg-sage/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {makingTask && <Spinner size={12} />}
              <span>{makingTask ? "Creating…" : "Make Task"}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-ink/45">
            {note.source === "manual" ? "Manual" : "Carson"}
          </span>
          <button
            type="button"
            onClick={() => void onDelete(note)}
            disabled={deleting}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-800 transition hover:bg-rose-100 disabled:opacity-50"
          >
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
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
