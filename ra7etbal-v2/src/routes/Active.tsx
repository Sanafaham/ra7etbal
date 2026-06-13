import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import TaskCard from "../components/tasks/TaskCard";
import { useTaskList } from "../hooks/useTaskList";
import { buildDailyBrief } from "../lib/daily-brief";
import { isReminderOverdue } from "../lib/reminder-time";
import { usePeopleStore } from "../stores/people";
import { useTasksStore } from "../stores/tasks";
import type { Task } from "../types/task";

/**
 * Active — merged task view.
 * Sections: Needs Your Attention (rose) / Waiting on Others (amber) / Later (muted) / Done (collapsed).
 * Refresh happens on mount; no visible refresh button.
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

  const overdueCount = useMemo(() =>
    brief.needsAttention.filter(
      (t) => t.type === "reminder" && t.due_at && isReminderOverdue(t.due_at, now)
    ).length,
  [brief.needsAttention, now]);

  async function handleToggleDone(task: Task) {
    const action = task.status === "done"
      ? tasksStore.getState().markPending
      : tasksStore.getState().markDone;
    try { await action(task.id); } catch (e) { console.error(e); }
  }

  async function handleDelete(task: Task) {
    try { await tasksStore.getState().remove(task.id); } catch (e) { console.error(e); }
  }

  const sharedProps = { now, messageByTaskId, phoneByName, onToggleDone: handleToggleDone, onDelete: handleDelete };

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Active</h1>
        <p className="text-sm text-ink/55">What needs your attention right now.</p>
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
        <div className="space-y-5">
          {/* ── Needs Your Attention — high emphasis ── */}
          <PrioritySection
            title="Needs your attention"
            tasks={brief.needsAttention}
            empty="Nothing needs your attention right now."
            variant="urgent"
            overdueCount={overdueCount}
            {...sharedProps}
          />

          {/* ── Waiting on Others — medium emphasis ── */}
          <PrioritySection
            title="Waiting on others"
            tasks={brief.waitingOnOthers}
            empty="Nothing is waiting on others."
            variant="waiting"
            {...sharedProps}
          />

          {/* ── Later — low emphasis ── */}
          <PrioritySection
            title="Later"
            tasks={brief.later}
            empty="Nothing for later."
            variant="later"
            {...sharedProps}
          />

          {/* ── Done — collapsed ── */}
          {doneTasks.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer select-none list-none items-center gap-2 py-1">
                <span className="text-xs font-medium uppercase tracking-wide text-ink/35">Done</span>
                <span className="rounded-full bg-ink/8 px-2 py-0.5 text-[10px] font-medium text-ink/40">{doneTasks.length}</span>
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

interface PrioritySectionProps {
  title: string;
  tasks: Task[];
  empty: string;
  variant: "urgent" | "waiting" | "later";
  overdueCount?: number;
  now: Date;
  messageByTaskId: Map<string, { content: string }>;
  phoneByName: Map<string, string>;
  onToggleDone: (task: Task) => Promise<unknown>;
  onDelete: (task: Task) => Promise<unknown>;
}

function PrioritySection({
  title, tasks, empty, variant, overdueCount = 0,
  now, messageByTaskId, phoneByName, onToggleDone, onDelete,
}: PrioritySectionProps) {
  if (tasks.length === 0 && variant === "later") return null; // hide Later when empty

  const headerStyles = {
    urgent: "rounded-xl border border-rose-100 bg-rose-50/70 px-3 py-2",
    waiting: "rounded-xl border border-amber-100/60 bg-amber-50/40 px-3 py-2",
    later:   "px-1 py-0.5",
  };

  const titleStyles = {
    urgent:  "text-sm font-semibold text-rose-900",
    waiting: "text-sm font-semibold text-amber-900/80",
    later:   "text-xs font-medium uppercase tracking-wide text-ink/40",
  };

  const countStyles = {
    urgent:  "rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700",
    waiting: "rounded-full bg-amber-100/70 px-2 py-0.5 text-[11px] font-medium text-amber-700",
    later:   "text-xs text-ink/30",
  };

  return (
    <section className="space-y-2.5">
      <div className={headerStyles[variant]}>
        <div className="flex items-center gap-2">
          {variant === "urgent" && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
          )}
          <h2 className={titleStyles[variant]}>{title}</h2>
          {tasks.length > 0 && (
            <span className={countStyles[variant]}>{tasks.length}</span>
          )}
          {variant === "urgent" && overdueCount > 0 && (
            <span className="ml-auto rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold text-white">
              {overdueCount} overdue
            </span>
          )}
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-sage/20 bg-white/40 px-4 py-4 text-sm text-ink/45">
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
