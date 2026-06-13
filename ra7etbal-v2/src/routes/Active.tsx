import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import RefreshButton from "../components/RefreshButton";
import Spinner from "../components/Spinner";
import TaskCard from "../components/tasks/TaskCard";
import { useTaskList } from "../hooks/useTaskList";
import { buildDailyBrief } from "../lib/daily-brief";
import { usePeopleStore } from "../stores/people";
import { useTasksStore } from "../stores/tasks";
import type { Task } from "../types/task";

/**
 * Active — merged task view.
 * Sections: Needs Your Attention / Waiting on Others / Later / Done (collapsed).
 * Replaces: Actions, FollowUps, Messages/Waiting.
 */
export default function Active() {
  const { userId, tasks, tasksStatus, tasksError, messages, reload } = useTaskList();
  const tasksStore = useTasksStore;
  const [now, setNow] = useState(() => new Date());
  const { people, loadedForUserId: peopleLoadedForUserId, loadPeople } =
    usePeopleStore(
      useShallow((s) => ({
        people: s.items,
        loadedForUserId: s.loadedForUserId,
        loadPeople: s.loadFor,
      })),
    );

  useEffect(() => {
    if (!userId) return;
    if (peopleLoadedForUserId !== userId) void loadPeople(userId);
  }, [userId, peopleLoadedForUserId, loadPeople]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const messageByTaskId = useMemo(() => {
    const m = new Map<string, { content: string }>();
    for (const msg of messages) {
      if (msg.task_id) m.set(msg.task_id, { content: msg.content });
    }
    return m;
  }, [messages]);

  const phoneByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const person of people) {
      const key = person.name.trim().toLowerCase();
      if (key && person.phone) m.set(key, person.phone);
    }
    return m;
  }, [people]);

  const brief = useMemo(() => buildDailyBrief(tasks, now), [tasks, now]);
  const doneTasks = useMemo(() => tasks.filter((t) => t.status === "done"), [tasks]);
  const initialLoading = tasksStatus === "loading" && tasks.length === 0;

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
    try {
      await tasksStore.getState().remove(task.id);
    } catch (e) {
      console.error(e);
    }
  }

  const sharedProps = { now, messageByTaskId, phoneByName, onToggleDone: handleToggleDone, onDelete: handleDelete };

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Active</h1>
          <p className="text-sm text-ink/60">What needs your attention right now.</p>
        </div>
        <RefreshButton onClick={reload} />
      </header>

      {tasksError && tasksStatus !== "loading" && (
        <AuthNotice kind="error">
          {tasksError}{" "}
          <button type="button" onClick={reload} className="ml-1 underline">Try again</button>
        </AuthNotice>
      )}

      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading" />
        </div>
      )}

      {!initialLoading && tasksStatus === "ready" && (
        <div className="space-y-6">
          <TaskSection
            title="Needs your attention"
            tasks={brief.needsAttention}
            empty="Nothing needs your attention right now."
            tone="rose"
            {...sharedProps}
          />
          <TaskSection
            title="Waiting on others"
            tasks={brief.waitingOnOthers}
            empty="Nothing is waiting on others."
            tone="amber"
            {...sharedProps}
          />
          <TaskSection
            title="Later"
            tasks={brief.later}
            empty="Nothing for later."
            tone="sage"
            {...sharedProps}
          />

          {/* Done — collapsed by default */}
          {doneTasks.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer select-none list-none items-center justify-between rounded-2xl border border-sage/15 bg-white/60 px-4 py-3">
                <span className="text-sm font-semibold uppercase tracking-wide text-ink/50">Done</span>
                <span className="text-xs text-ink/40">{doneTasks.length}</span>
              </summary>
              <ul className="mt-3 space-y-3">
                {doneTasks.map((task) => (
                  <li key={task.id}>
                    <TaskCard
                      task={task}
                      now={now}
                      message={messageByTaskId.get(task.id) ?? null}
                      recipientPhone={task.assigned_to ? phoneByName.get(task.assigned_to.trim().toLowerCase()) ?? null : null}
                      onToggleDone={handleToggleDone}
                      onDelete={handleDelete}
                    />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

interface TaskSectionProps {
  title: string;
  tasks: Task[];
  empty: string;
  tone: "rose" | "amber" | "sage";
  now: Date;
  messageByTaskId: Map<string, { content: string }>;
  phoneByName: Map<string, string>;
  onToggleDone: (task: Task) => Promise<unknown>;
  onDelete: (task: Task) => Promise<unknown>;
}

function TaskSection({ title, tasks, empty, tone, now, messageByTaskId, phoneByName, onToggleDone, onDelete }: TaskSectionProps) {
  const countClass =
    tone === "rose" ? "text-rose-700" :
    tone === "amber" ? "text-amber-700" :
    "text-sage";

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/60">{title}</h2>
        {tasks.length > 0 && (
          <span className={"text-xs font-medium " + countClass}>{tasks.length}</span>
        )}
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-sage/25 bg-white/50 px-4 py-5 text-sm text-ink/55">
          {empty}
        </div>
      ) : (
        <ul className="space-y-3">
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskCard
                task={task}
                now={now}
                message={messageByTaskId.get(task.id) ?? null}
                recipientPhone={task.assigned_to ? phoneByName.get(task.assigned_to.trim().toLowerCase()) ?? null : null}
                onToggleDone={onToggleDone}
                onDelete={onDelete}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
