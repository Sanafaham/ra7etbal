/**
 * Updates — Carson operations center.
 * Tabs: Needs You / Waiting / Inbox / Routines / History
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
import { isReminderOverdue } from "../lib/reminder-time";
import { usePeopleStore } from "../stores/people";
import { useTasksStore } from "../stores/tasks";
import type { Task } from "../types/task";
import Inbox from "./Inbox";
import Routines from "./Routines";

type Tab = "needs-you" | "waiting" | "inbox" | "routines" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "needs-you",  label: "Needs You" },
  { id: "waiting",    label: "Waiting"   },
  { id: "inbox",      label: "Inbox"     },
  { id: "routines",   label: "Routines"  },
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

  const overdueCount = useMemo(
    () =>
      brief.needsAttention.filter(
        (t) => t.type === "reminder" && t.due_at && isReminderOverdue(t.due_at, now),
      ).length,
    [brief.needsAttention, now],
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
        <h1 className="text-2xl font-semibold text-ink">Updates</h1>
        <p className="text-sm text-ink/55">What Carson is managing for you.</p>
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
                : "text-ink/50 hover:text-ink/75 hover:bg-sage/8")
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Error ── */}
      {tasksError && tasksStatus !== "loading" && activeTab !== "inbox" && activeTab !== "routines" && (
        <AuthNotice kind="error">
          {tasksError}{" "}
          <button type="button" onClick={reload} className="ml-1 underline">
            Try again
          </button>
        </AuthNotice>
      )}

      {/* ── Initial loading (task-based tabs only) ── */}
      {initialLoading && activeTab !== "inbox" && activeTab !== "routines" && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading" />
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          NEEDS YOU
      ══════════════════════════════════════════════════════════════ */}
      {activeTab === "needs-you" && !initialLoading && tasksStatus === "ready" && (
        <div className="space-y-3">
          {/* Section header */}
          <div className="flex items-center gap-2 rounded-xl border border-rose-100 bg-rose-50/70 px-3 py-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-rose-900">Needs your attention</h2>
            {brief.needsAttention.length > 0 && (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700">
                {brief.needsAttention.length}
              </span>
            )}
            {overdueCount > 0 && (
              <span className="ml-auto rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold text-white">
                {overdueCount} overdue
              </span>
            )}
          </div>

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

          {/* Later — muted, hidden when empty */}
          {brief.later.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer select-none list-none items-center gap-2 py-1 px-1">
                <span className="text-xs font-medium uppercase tracking-wide text-ink/40">Later</span>
                <span className="text-xs text-ink/30">{brief.later.length}</span>
              </summary>
              <ul className="mt-2 space-y-3">
                {brief.later.map((task) => (
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
          <div className="flex items-center gap-2 rounded-xl border border-amber-100/60 bg-amber-50/40 px-3 py-2">
            <h2 className="text-sm font-semibold text-amber-900/80">Waiting on others</h2>
            {brief.waitingOnOthers.length > 0 && (
              <span className="rounded-full bg-amber-100/70 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                {brief.waitingOnOthers.length}
              </span>
            )}
          </div>

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
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink/40">Completed</h2>
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
