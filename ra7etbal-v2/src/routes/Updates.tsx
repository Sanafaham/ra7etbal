/**
 * Updates — Carson operations center.
 * Tabs: Needs You / Waiting / To-do / Notes / Automations / History
 * Deep-link: /updates?tab=needs-you (default)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import TaskCard from "../components/tasks/TaskCard";
import Modal from "../components/ui/Modal";
import { useTaskList } from "../hooks/useTaskList";
import { buildDailyBrief } from "../lib/daily-brief";
import { getUpcomingReminderTasks } from "../lib/updates-reminders";
import { usePeopleStore } from "../stores/people";
import { useTasksStore } from "../stores/tasks";
import type { Task } from "../types/task";
import Inbox from "./Inbox";
import Todos from "./Todos";
import Routines from "./Routines";
import { advanceChipScrollLeft, shouldAdvanceChipAutoScroll } from "../lib/chip-auto-scroll";

type Tab = "needs-you" | "waiting" | "todo" | "inbox" | "routines" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "needs-you",     label: "Needs You" },
  { id: "waiting",       label: "Waiting"   },
  { id: "todo",          label: "To-do"     },
  { id: "inbox",         label: "Notes"     },
  { id: "routines",      label: "Automations"  },
  { id: "history",       label: "History"   },
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

  // ── Category chip bar — slow idle auto-scroll, pauses on interaction ──
  // Selection/content is driven only by clicks (setTab above); auto-scroll
  // never changes which tab's content is shown.
  //
  // Uses requestAnimationFrame with delta-time movement rather than
  // setInterval: rAF is throttled/paused natively by the browser when the
  // page isn't visible and resumes cleanly, which setInterval does not
  // reliably do inside an iOS Home Screen (standalone) PWA. The
  // prefers-reduced-motion check is re-evaluated live via a change
  // listener instead of a one-time read at mount, because iOS standalone
  // mode has been observed to report that media query differently (and
  // sometimes belatedly) than a regular Safari tab — a one-time mount-time
  // check could permanently disable the whole loop on a false read.
  const chipScrollerRef = useRef<HTMLDivElement>(null);
  const chipAutoPausedRef = useRef(false);
  const chipResumeTimerRef = useRef<number | null>(null);
  const chipReducedMotionRef = useRef(false);
  // Setting scrollLeft below fires a native `scroll` event indistinguishable
  // from a user-driven one. Without this guard, the onScroll handler treated
  // the auto-scroll's own movement as user interaction and paused it on the
  // very next frame, every frame — net effect: the chip row nudged a
  // fraction of a pixel, stalled for the whole resume cooldown, and repeated,
  // which looked like (and was reported as) "moves once then stops," and
  // meant it never actually cycled the off-screen tabs (Inbox, Automations,
  // History) into view. This flag lets onScroll recognize and ignore scroll
  // events the auto-scroll itself caused, while still pausing for genuine
  // user interaction — including keyboard-driven scroll, which is the one
  // case the pointer/touch/wheel handlers below don't cover.
  const chipProgrammaticScrollRef = useRef(false);

  useEffect(() => {
    const el = chipScrollerRef.current;
    if (!el) return;

    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    chipReducedMotionRef.current = mq?.matches ?? false;
    const handleMotionPrefChange = (e: MediaQueryListEvent) => {
      chipReducedMotionRef.current = e.matches;
    };
    mq?.addEventListener?.("change", handleMotionPrefChange);

    // Raised from the original 0.03px/ms (0.6px/20ms, ~30px/s — a full loop
    // took ~25-30s) to ~0.09px/ms (~90px/s, a full loop in under 10s) after a
    // real-device report that the row "did not visibly auto-cycle" even
    // after the self-pause fix below: at the old speed, a few seconds of
    // observation genuinely produced too little movement to register as
    // motion rather than noise.
    const PIXELS_PER_MS = 0.09;
    let rafId: number;
    let lastTs: number | null = null;

    const tick = (ts: number) => {
      rafId = window.requestAnimationFrame(tick);
      const shouldAdvance = shouldAdvanceChipAutoScroll({
        hidden: document.hidden,
        reducedMotion: chipReducedMotionRef.current,
        paused: chipAutoPausedRef.current,
      });
      if (!shouldAdvance) {
        lastTs = null; // drop the stale delta so we don't jump on resume
        return;
      }
      if (lastTs == null) { lastTs = ts; return; }
      const dt = ts - lastTs;
      lastTs = ts;
      if (el.scrollWidth <= 0) return; // not laid out yet
      chipProgrammaticScrollRef.current = true;
      el.scrollLeft = advanceChipScrollLeft(el.scrollLeft, el.scrollWidth, dt, PIXELS_PER_MS);
    };
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      mq?.removeEventListener?.("change", handleMotionPrefChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (chipResumeTimerRef.current) window.clearTimeout(chipResumeTimerRef.current);
    };
  }, []);

  // Safety net: if a touch/pointer gesture gets interrupted (e.g. the app is
  // backgrounded mid-drag) without its matching end event ever firing, the
  // pause flag could otherwise stay stuck forever. Resuming whenever the app
  // becomes visible again guarantees it never stays silently frozen.
  useEffect(() => {
    function handleVisibility() {
      if (!document.hidden) scheduleChipAutoScrollResume();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  function pauseChipAutoScroll() {
    chipAutoPausedRef.current = true;
    if (chipResumeTimerRef.current) window.clearTimeout(chipResumeTimerRef.current);
  }

  function handleChipScroll() {
    if (chipProgrammaticScrollRef.current) {
      // Our own auto-scroll caused this event — not user interaction.
      chipProgrammaticScrollRef.current = false;
      return;
    }
    pauseChipAutoScroll();
    scheduleChipAutoScrollResume();
  }

  function scheduleChipAutoScrollResume() {
    if (chipResumeTimerRef.current) window.clearTimeout(chipResumeTimerRef.current);
    chipResumeTimerRef.current = window.setTimeout(() => {
      chipAutoPausedRef.current = false;
    }, 1200);
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
  // Background refreshes (15s/30s/60s polls, focus, visibilitychange, and the
  // post-decision refresh after a Needs You action) set tasksStatus back to
  // "loading" even though cached tasks are already on screen. Gating the list
  // on tasksStatus === "ready" alone unmounted and remounted it on every one
  // of those polls, resetting any in-progress local state inside a task card
  // (e.g. the Custom Instruction textarea) before the owner could finish
  // typing. Once we have cached tasks, keep the list mounted through a
  // background "loading" tick instead of tearing it down.
  const listReady = tasksStatus === "ready" || (tasksStatus === "loading" && tasks.length > 0);

  // Pending reminders due in the next 14 days. Reminders already shown in
  // Needs You stay there only, so one reminder never renders in both sections.
  const upcomingReminders = useMemo(() => {
    return getUpcomingReminderTasks(tasks, brief.needsAttention, now);
  }, [tasks, brief.needsAttention, now]);

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

  // ── Clear History — bulk-delete completed items only, never active ones ──
  const [confirmingClearHistory, setConfirmingClearHistory] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearHistoryError, setClearHistoryError] = useState<string | null>(null);

  async function handleClearHistory() {
    if (clearingHistory) return;
    setClearingHistory(true);
    setClearHistoryError(null);
    try {
      await tasksStore.getState().removeMany(doneTasks.map((t) => t.id));
      setConfirmingClearHistory(false);
    } catch (e) {
      setClearHistoryError(e instanceof Error ? e.message : "Could not clear history. Please try again.");
    } finally {
      setClearingHistory(false);
    }
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
        <h1 style={{ fontFamily: "var(--font-display)" }} className="text-[32px] font-semibold leading-none tracking-[-0.005em] text-ink">Updates</h1>
        <p className="mt-1.5 text-[13px] font-medium text-text-soft">What Carson is managing for you.</p>
      </header>

      {/* ── Category chips — auto-scrolls slowly when idle, loops, pauses on interaction ── */}
      <div className="relative -mx-5">
        <div
          ref={chipScrollerRef}
          className="flex gap-2 overflow-x-auto px-5 py-0.5"
          role="tablist"
          aria-label="Updates sections"
          style={{ scrollbarWidth: "none" }}
          onScroll={handleChipScroll}
          onPointerDown={pauseChipAutoScroll}
          onPointerUp={scheduleChipAutoScrollResume}
          onPointerCancel={scheduleChipAutoScrollResume}
          onPointerLeave={scheduleChipAutoScrollResume}
          onTouchStart={pauseChipAutoScroll}
          onTouchEnd={scheduleChipAutoScrollResume}
          onTouchCancel={scheduleChipAutoScrollResume}
          onWheel={() => { pauseChipAutoScroll(); scheduleChipAutoScrollResume(); }}
        >
          {[...TABS, ...TABS].map((tab, i) => (
            <button
              key={tab.id + "-" + i}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setTab(tab.id)}
              className={
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-4 py-2 text-[13.5px] font-semibold transition " +
                (activeTab === tab.id
                  ? "border-sage bg-sage text-white"
                  : "border-border text-ink hover:bg-ink/[0.03]")
              }
            >
              <span
                aria-hidden
                className={"h-[5px] w-[5px] shrink-0 rounded-full bg-gold " + (activeTab === tab.id ? "opacity-100" : "opacity-0")}
              />
              {tab.label}
            </button>
          ))}
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-cream to-transparent" />
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-cream to-transparent" />
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
      {activeTab === "needs-you" && !initialLoading && listReady && (
        <div className="space-y-3">
          {brief.needsAttention.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-white/40 px-4 py-6 text-sm text-ink/45">
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
                    isNeedsYouCard
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
      {activeTab === "waiting" && !initialLoading && listReady && (
        <div className="space-y-3">
          {brief.waitingOnOthers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-white/40 px-4 py-6 text-sm text-ink/45">
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
          NOTES
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
          <div className="flex items-center justify-between gap-2 px-1 py-0.5">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-ink/60">Completed</h2>
              {doneTasks.length > 0 && (
                <span className="text-xs text-ink/30">{doneTasks.length}</span>
              )}
            </div>
            {doneTasks.length > 0 && (
              <button
                type="button"
                onClick={() => { setClearHistoryError(null); setConfirmingClearHistory(true); }}
                className="text-xs font-medium text-danger transition hover:underline"
              >
                Clear History
              </button>
            )}
          </div>

          {doneTasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-white/40 px-4 py-6 text-sm text-ink/45">
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

      {/* ── Clear History confirmation ── */}
      <Modal
        open={confirmingClearHistory}
        onClose={() => { if (!clearingHistory) setConfirmingClearHistory(false); }}
        title="Clear all history?"
        dismissable={!clearingHistory}
      >
        <div className="space-y-4">
          <p className="text-sm leading-snug text-ink/70">
            This will remove confirmed/completed items from your history log.
          </p>

          {clearHistoryError && <AuthNotice kind="error">{clearHistoryError}</AuthNotice>}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setConfirmingClearHistory(false)}
              disabled={clearingHistory}
              className="rounded-full border border-border bg-white px-5 py-2.5 text-sm font-medium text-ink shadow-sm transition hover:bg-cream disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleClearHistory()}
              disabled={clearingHistory}
              aria-busy={clearingHistory}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {clearingHistory && <Spinner size={14} />}
              <span>{clearingHistory ? "Clearing…" : "Clear history"}</span>
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
