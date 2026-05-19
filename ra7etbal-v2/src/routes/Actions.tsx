import { useMemo, useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import RefreshButton from "../components/RefreshButton";
import Spinner from "../components/Spinner";
import TaskCard from "../components/tasks/TaskCard";
import { useTaskList } from "../hooks/useTaskList";
import { useTasksStore } from "../stores/tasks";
import type { Task } from "../types/task";

type Filter = "open" | "done" | "all";

export default function Actions() {
  const { tasks, tasksStatus, tasksError, messages, reload } = useTaskList();
  const tasksStore = useTasksStore;
  const [filter, setFilter] = useState<Filter>("open");

  // Map task_id -> linked message (the delegation send payload).
  const messageByTaskId = useMemo(() => {
    const m = new Map<string, { content: string }>();
    for (const msg of messages) {
      if (msg.task_id) m.set(msg.task_id, { content: msg.content });
    }
    return m;
  }, [messages]);

  const filtered = useMemo(() => {
    if (filter === "all") return tasks;
    if (filter === "done") return tasks.filter((t) => t.status === "done");
    return tasks.filter((t) => t.status !== "done");
  }, [tasks, filter]);

  async function handleToggleDone(task: Task) {
    const action =
      task.status === "done"
        ? tasksStore.getState().markPending
        : tasksStore.getState().markDone;
    try {
      await action(task.id);
    } catch (e) {
      console.error(e);
    }
  }

  async function handleDelete(task: Task) {
    if (!window.confirm("Delete this task?")) return;
    try {
      await tasksStore.getState().remove(task.id);
    } catch (e) {
      console.error(e);
    }
  }

  const initialLoading = tasksStatus === "loading" && tasks.length === 0;

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Actions</h1>
          <p className="text-sm text-ink/60">Everything Ra7etBal is tracking for you.</p>
        </div>
        <RefreshButton onClick={reload} />
      </header>

      <div role="tablist" aria-label="Filter" className="grid grid-cols-3 gap-1 rounded-full border border-sage/30 bg-cream/60 p-1">
        {(["open", "done", "all"] as const).map((f) => (
          <button
            key={f}
            role="tab"
            type="button"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={
              "rounded-full px-3 py-2 text-sm font-medium transition " +
              (filter === f ? "bg-sage text-white shadow-sm" : "text-ink/70 hover:text-ink")
            }
          >
            {f === "open" ? "Open" : f === "done" ? "Done" : "All"}
          </button>
        ))}
      </div>

      {tasksError && tasksStatus !== "loading" && (
        <AuthNotice kind="error">
          {tasksError}{" "}
          <button type="button" onClick={reload} className="ml-1 underline">
            Try again
          </button>
        </AuthNotice>
      )}

      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading actions" />
        </div>
      )}

      {!initialLoading && filtered.length === 0 && tasksStatus === "ready" && (
        <div className="rounded-2xl border border-dashed border-sage/40 bg-white/60 p-8 text-center text-sm text-ink/70">
          {filter === "done"
            ? "Nothing marked done yet."
            : filter === "open"
              ? "No open actions. Head to Home to capture what's on your mind."
              : "Nothing here yet."}
        </div>
      )}

      {filtered.length > 0 && (
        <ul className="space-y-3">
          {filtered.map((t) => (
            <li key={t.id}>
              <TaskCard
                task={t}
                message={messageByTaskId.get(t.id) ?? null}
                onToggleDone={handleToggleDone}
                onDelete={handleDelete}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
