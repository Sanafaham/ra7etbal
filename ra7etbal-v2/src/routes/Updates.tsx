/**
 * Updates — Carson operations center.
 * Tabs: Needs You / Waiting / To-do / Notes / Automations / History
 * Deep-link: /updates?tab=needs-you (default)
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import TaskCard from "../components/tasks/TaskCard";
import { useTaskList } from "../hooks/useTaskList";
import { buildDailyBrief } from "../lib/daily-brief";
import { usePeopleStore } from "../stores/people";
import { useTasksStore } from "../stores/tasks";
import type { Task } from "../types/task";
import Inbox from "./Inbox";
import Todos from "./Todos";
import Routines from "./Routines";

type Tab = "needs-you" | "waiting" | "todo" | "inbox" | "routines" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "needs-you",  label: "Needs You" },
  { id: "waiting",    label: "Waiting"   },
  { id: "todo",       label: "To-do"     },
  { id: "inbox",      label: "Notes"     },
  { id: "routines",   label: "Automations"  },
  { id: "history",    label: "History"   },
];

function isValidTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v);
}

export default function Updates() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const activeTab: Tab = isValidTab(rawTab) ? rawTab : "needs-you";

  function setTab(tab: Tab) {
    setSearchParams({ tab }, { replace: true });
  }

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

  // Pending reminders due in the next 14 days (not today, not overdue — those
  // already appear in needsAttention). Sorted by due date ascending.
  const MS_14_DAYS = 14 * 24 * 60 * 60 * 1000;
  const upcomingReminders = useMemo(() => {
    const nowMs = now.getTime();
    return tasks
      .filter((t) => {
        if (t.archived_at != null) return false;
        if (t.status !== "pending") return false;
        if (t.type !== "reminder") return false;
        if (!t.due_at) return false;
        const dueMs = new Date(t.due_at).getTime();
        if (Number.isNaN(dueMs)) return false;
        // Future only, within 14 days, not today (today/overdue live in needsAttention)
        return dueMs > nowMs && dueMs <= nowMs + MS_14_DAYS;
      })
      .sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime());
  }, [tasks, now]);

  // IDs already shown in upcomingReminders — exclude from brief.later to avoid duplication
  const upcomingReminderIds = useMemo(
    () => new Set(upcomingReminders.map((t) => t.id)),
    [upcomingReminders],
  );

  const laterFiltered = useMemo(
    () => brief.later.filter((t) => !upcomingReminderIds.has(t.id)),
    [brief.later, upcomingReminderIds],
  );

  async function handleToggleDone(task: Task) {
    const action =
      task.status === "done"
        ? tasksStore.getState().markPending
        : tasksStore.getState().markDone;
    try { await action(task.id); } catch (e) { console.error(e); }
  }

  async function handleDelete(task: Task) {
    try { await tasksStore.getState().remove(task.id); } catch (e) { console.error(e); }
  }

  const sharedTaskProps = {
    now,
    messageByTaskId,
    phoneByName,
    onToggleDone: handleToggleDone,
    onDelete: handleDelete,
  };

  return (
    <section className="space-y-4">
      {/* ── Header ── */}
      <header>
        <h1 className="text-xl font-semibold text-ink">Updates</h1>
        <p className="text-xs text-ink/55">What Carson is managing for you.</p>
      </header>

      {/* ── Segmented control ── */}
      <div
        className="flex gap-1 overflow-x-auto rounded-2xl border border-sage/15 bg-white/60 p-1"
        role="tablist"
        aria-label="Updates sections"
        style={{ scrollbarWidth: "none" }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setTab(tab.id)}
            className={
              "shrink-0 rounded-xl px-3 py-1.5 text-xs font-medium transition " +
              (activeTab === tab.id
                ? "bg-sage text-white shadow-sm"
                : "text-ink/65 hover:text-ink/80 hover:bg-sage/8")
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Error ── */}
      {tasksError && tasksStatus !== "loading" && activeTab !== "inbox" && activeTab !== "routines" && activeTab !== "todo" && (
        <AuthNotice kind="error">
          {tasksError}{" "}
          <button type="button" onClick={reload} className="ml-1 underline">
            Try again
          </button>
        </AuthNotice>
      )}

      {/* ── Initial loading (task-based tabs only) ── */}
      {initialLoading && activeTab !== "inbox" && activeTab !== "routines" && activeTab !== "todo" && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading" />
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          NEEDS YOU
      ══════════════════════════════════════════════════════════════ */}
      {activeTab === "needs-you" && !initialLoading && tasksStatus === "ready" && (
        <div className="space-y-3">
          {brief.needsAttention.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-sage/20 bg-white/40 px-4 py-6 text-sm text-ink/45">
              Nothing needs your attention right now.
            </div>
          ) : (
            <ul className="space-y-3">
              {brief.needsAttention.map((task) => (
                <li key={task.id}>
                  <TaskCard
                    task={task}
                    message={messageByTaskId.get(task.id) ?? null}
                    recipientPhone={task.assigned_to ? phoneByName.get(task.assigned_to.trim().toLowerCase()) ?? null : null}
                    {...sharedTaskProps}
                  />
                </li>
              ))}
            </ul>
          )}

          {/* Upcoming reminders — future pending reminders within 14 days */}
          {upcomingReminders.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <span className="text-[12px] font-medium text-ink/55">
                  Upcoming reminders
                </span>
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                  {upcomingReminders.length}
                </span>
              </div>
              <ul className="space-y-3">
                {upcomingReminders.map((task) => (
                  <li key={task.id}>
                    <TaskCard
                      task={task}
                      message={messageByTaskId.get(task.id) ?? null}
                      recipientPhone={null}
                      {...sharedTaskProps}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Later — muted, hidden when empty */}
          {laterFiltered.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer select-none list-none items-center gap-2 py-1 px-1">
                <span className="text-xs font-medium uppercase tracking-wide text-ink/55">Later</span>
                <span className="text-xs text-ink/55">{laterFiltered.length}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink/40 transition-transform group-open:rotate-180" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
              </summary>
              <ul className="mt-2 space-y-3">
                {laterFiltered.map((task) => (
                  <li key={task.id}>
                    <TaskCard
                      task={task}
                      message={messageByTaskId.get(task.id) ?? null}
                      recipientPhone={task.assigned_to ? phoneByName.get(task.assigned_to.trim().toLowerCase()) ?? null : null}
                      {...sharedTaskProps}
                    />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          WAITING
      ══════════════════════════════════════════════════════════════ */}
      {activeTab === "waiting" && !initialLoading && tasksStatus === "ready" && (
        <div className="space-y-3">
          {brief.waitingOnOthers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-sage/20 bg-white/40 px-4 py-6 text-sm text-ink/45">
              Nothing is waiting on others right now.
            </div>
          ) : (
            <ul className="space-y-3">
              {brief.waitingOnOthers.map((task) => (
                <li key={task.id}>
                  <TaskCard
                    task={task}
                    message={messageByTaskId.get(task.id) ?? null}
                    recipientPhone={task.assigned_to ? phoneByName.get(task.assigned_to.trim().toLowerCase()) ?? null : null}
                    {...sharedTaskProps}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          TO-DO
      ══════════════════════════════════════════════════════════════ */}
      {activeTab === "todo" && <Todos headerless />}

      {/* ══════════════════════════════════════════════════════════════
          INBOX
      ══════════════════════════════════════════════════════════════ */}
      {activeTab === "inbox" && <Inbox headerless />}

      {/* ══════════════════════════════════════════════════════════════
          ROUTINES
      ══════════════════════════════════════════════════════════════ */}
      {activeTab === "routines" && <Routines headerless />}

      {/* ══════════════════════════════════════════════════════════════
          HISTORY
      ══════════════════════════════════════════════════════════════ */}
      {activeTab === "history" && !initialLoading && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1 py-0.5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink/60">Completed</h2>
            {doneTasks.length > 0 && (
              <span className="text-xs text-ink/30">{doneTasks.length}</span>
            )}
          </div>

          {doneTasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-sage/20 bg-white/40 px-4 py-6 text-sm text-ink/45">
              No completed items yet.
            </div>
          ) : (
            <ul className="space-y-3">
              {doneTasks.map((task) => (
                <li key={task.id}>
                  <TaskCard
                    task={task}
                    message={messageByTaskId.get(task.id) ?? null}
                    recipientPhone={task.assigned_to ? phoneByName.get(task.assigned_to.trim().toLowerCase()) ?? null : null}
                    {...sharedTaskProps}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
