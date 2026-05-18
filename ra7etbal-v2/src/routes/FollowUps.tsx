import { useMemo } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import TaskCard from "../components/tasks/TaskCard";
import { useTaskList } from "../hooks/useTaskList";
import { useTasksStore } from "../stores/tasks";
import type { Task } from "../types/task";

/**
 * Follow-ups — outstanding delegated/follow-up tasks awaiting confirmation.
 * When the recipient hits /confirm and marks done (or the host marks done),
 * the row drops off this list.
 */
export default function FollowUps() {
  const { tasks, tasksStatus, tasksError, messages, reload } = useTaskList();

  const messageByTaskId = useMemo(() => {
    const m = new Map<string, { content: string }>();
    for (const msg of messages) {
      if (msg.task_id) m.set(msg.task_id, { content: msg.content });
    }
    return m;
  }, [messages]);

  const outstanding = useMemo(
    () => tasks.filter((t) => t.needs_follow_up && t.status !== "done"),
    [tasks],
  );

  async function handleToggleDone(task: Task) {
    try {
      await useTasksStore.getState().markDone(task.id);
    } catch (e) {
      console.error(e);
    }
  }
  async function handleDelete(task: Task) {
    if (!window.confirm("Delete this follow-up?")) return;
    try {
      await useTasksStore.getState().remove(task.id);
    } catch (e) {
      console.error(e);
    }
  }

  const initialLoading = tasksStatus === "loading" && tasks.length === 0;

  return (
    <section className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Follow-ups</h1>
        <p className="text-sm text-ink/60">
          Delegations and follow-ups still waiting on confirmation.
        </p>
      </header>

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
          <Spinner size={20} label="Loading follow-ups" />
        </div>
      )}

      {!initialLoading && outstanding.length === 0 && tasksStatus === "ready" && (
        <div className="rounded-2xl border border-dashed border-sage/40 bg-white/60 p-8 text-center text-sm text-ink/70">
          You're all caught up. Nothing outstanding.
        </div>
      )}

      {outstanding.length > 0 && (
        <ul className="space-y-3">
          {outstanding.map((t) => (
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
