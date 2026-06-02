import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import RefreshButton from "../components/RefreshButton";
import Spinner from "../components/Spinner";
import TaskCard from "../components/tasks/TaskCard";
import { useTaskList } from "../hooks/useTaskList";
import { buildDailyBrief } from "../lib/daily-brief";
import { isReminderOverdue } from "../lib/reminder-time";
import { usePeopleStore } from "../stores/people";
import { useTasksStore } from "../stores/tasks";
import type { Task } from "../types/task";

type Filter = "brief" | "open" | "done" | "all";

export default function Actions() {
  const location = useLocation();
  const { userId, tasks, tasksStatus, tasksError, messages, reload } = useTaskList();
  const tasksStore = useTasksStore;
  const [filter, setFilter] = useState<Filter>(() => getInitialFilter(location.state));
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
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  // Map task_id -> linked message (the delegation send payload).
  const messageByTaskId = useMemo(() => {
    const m = new Map<string, { content: string }>();
    for (const msg of messages) {
      if (msg.task_id) m.set(msg.task_id, { content: msg.content });
    }
    return m;
  }, [messages]);

  const filtered = useMemo(() => {
    if (filter === "brief") return [];
    if (filter === "all") return tasks;
    if (filter === "done") return tasks.filter((t) => t.status === "done");
    return sortOpenTasks(tasks.filter((t) => t.status !== "done"), now);
  }, [tasks, filter, now]);

  const brief = useMemo(() => buildDailyBrief(tasks, now), [tasks, now]);

  const phoneByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const person of people) {
      const key = person.name.trim().toLowerCase();
      if (key && person.phone) m.set(key, person.phone);
    }
    return m;
  }, [people]);

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

      <div role="tablist" aria-label="Filter" className="grid grid-cols-4 gap-1 rounded-full border border-sage/30 bg-cream/60 p-1">
        {(["brief", "open", "done", "all"] as const).map((f) => (
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
            {f === "brief" ? "Brief" : f === "open" ? "Open" : f === "done" ? "Done" : "All"}
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

      {!initialLoading && filter === "brief" && tasksStatus === "ready" && (
        <BriefView
          brief={brief}
          now={now}
          messageByTaskId={messageByTaskId}
          phoneByName={phoneByName}
          onToggleDone={handleToggleDone}
          onDelete={handleDelete}
        />
      )}

      {!initialLoading && filter !== "brief" && filtered.length === 0 && tasksStatus === "ready" && (
        <div className="rounded-2xl border border-dashed border-sage/40 bg-white/60 p-8 text-center text-sm text-ink/70">
          {filter === "done"
            ? "Nothing marked done yet."
            : filter === "open"
              ? "No open actions. Head to Home to capture what's on your mind."
              : "Nothing here yet."}
        </div>
      )}

      {filter !== "brief" && filtered.length > 0 && (
        <ul className="space-y-3">
          {filtered.map((t) => (
            <li key={t.id}>
              <TaskCard
                task={t}
                now={now}
                message={messageByTaskId.get(t.id) ?? null}
                recipientPhone={
                  t.assigned_to
                    ? phoneByName.get(t.assigned_to.trim().toLowerCase()) ?? null
                    : null
                }
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

function getInitialFilter(state: unknown): Filter {
  if (
    state &&
    typeof state === "object" &&
    "initialFilter" in state &&
    state.initialFilter === "brief"
  ) {
    return "brief";
  }

  return "open";
}

interface BriefViewProps {
  brief: ReturnType<typeof buildDailyBrief>;
  now: Date;
  messageByTaskId: Map<string, { content: string }>;
  phoneByName: Map<string, string>;
  onToggleDone: (task: Task) => Promise<unknown>;
  onDelete: (task: Task) => Promise<unknown>;
}

function BriefView({
  brief,
  now,
  messageByTaskId,
  phoneByName,
  onToggleDone,
  onDelete,
}: BriefViewProps) {
  const total =
    brief.needsAttention.length + brief.waitingOnOthers.length + brief.later.length;

  return (
    <div className="space-y-5">
      <BriefSummary summary={brief.summary} />

      <div className="grid grid-cols-3 gap-1.5">
        <BriefCount
          label="Needs your attention"
          value={brief.needsAttention.length}
          tone="rose"
        />
        <BriefCount
          label="Waiting on others"
          value={brief.waitingOnOthers.length}
          tone="amber"
        />
        <BriefCount label="Later" value={brief.later.length} tone="sage" />
      </div>

      {total === 0 && (
        <div className="rounded-2xl border border-dashed border-sage/40 bg-white/60 p-8 text-center text-sm text-ink/70">
          Nothing needs your attention right now.
        </div>
      )}

      <BriefSection
        title="Needs your attention"
        tasks={brief.needsAttention}
        empty="Nothing needs your attention right now."
        now={now}
        messageByTaskId={messageByTaskId}
        phoneByName={phoneByName}
        onToggleDone={onToggleDone}
        onDelete={onDelete}
      />
      <BriefSection
        title="Waiting on others"
        tasks={brief.waitingOnOthers}
        empty="Nothing is waiting on others."
        now={now}
        messageByTaskId={messageByTaskId}
        phoneByName={phoneByName}
        onToggleDone={onToggleDone}
        onDelete={onDelete}
      />
      <BriefSection
        title="Later"
        tasks={brief.later}
        empty="Nothing for later."
        now={now}
        messageByTaskId={messageByTaskId}
        phoneByName={phoneByName}
        onToggleDone={onToggleDone}
        onDelete={onDelete}
      />
    </div>
  );
}

function BriefSummary({
  summary,
}: {
  summary: ReturnType<typeof buildDailyBrief>["summary"];
}) {
  return (
    <section className="rounded-2xl border border-sage/30 bg-white/90 px-5 py-6 shadow-sm">
      <p className="text-lg font-semibold leading-relaxed text-ink">{summary.paragraph}</p>
    </section>
  );
}

function BriefCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "rose" | "amber" | "sage";
}) {
  const toneClass =
    tone === "rose"
      ? "border-rose-100 bg-white/45 text-rose-900/75"
      : tone === "amber"
        ? "border-amber-100 bg-white/45 text-amber-950/75"
        : "border-sage/20 bg-white/45 text-sage/80";

  return (
    <div className={"rounded-xl border px-2.5 py-1.5 text-center " + toneClass}>
      <p className="text-base font-semibold leading-none">{value}</p>
      <p className="mt-1 text-[10px] font-medium uppercase tracking-wide">{label}</p>
    </div>
  );
}

interface BriefSectionProps {
  title: string;
  tasks: Task[];
  empty: string;
  now: Date;
  messageByTaskId: Map<string, { content: string }>;
  phoneByName: Map<string, string>;
  onToggleDone: (task: Task) => Promise<unknown>;
  onDelete: (task: Task) => Promise<unknown>;
}

function BriefSection({
  title,
  tasks,
  empty,
  now,
  messageByTaskId,
  phoneByName,
  onToggleDone,
  onDelete,
}: BriefSectionProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/60">{title}</h2>
        <span className="text-xs text-ink/45">{tasks.length}</span>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-sage/30 bg-white/50 px-4 py-5 text-sm text-ink/60">
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
                recipientPhone={
                  task.assigned_to
                    ? phoneByName.get(task.assigned_to.trim().toLowerCase()) ?? null
                    : null
                }
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

function sortOpenTasks(tasks: Task[], now: Date): Task[] {
  return [...tasks].sort((a, b) => getOpenPriority(a, now) - getOpenPriority(b, now));
}

function getOpenPriority(task: Task, now: Date): number {
  if (task.type === "reminder" && task.due_at) {
    const due = new Date(task.due_at).getTime();
    if (!Number.isNaN(due)) {
      if (isReminderOverdue(task.due_at, now)) {
        return due;
      }

      return 10_000_000_000_000 + due;
    }
  }

  return 20_000_000_000_000 + new Date(task.created_at).getTime();
}
