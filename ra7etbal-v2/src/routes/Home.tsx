import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useCarsonStore } from "../stores/carson";
import AwarenessCard from "../components/home/AwarenessCard";
import { useAuth } from "../hooks/useAuth";
import { fetchCalendarEvents, type CalendarEvent } from "../lib/calendar";
import { buildDailyBrief } from "../lib/daily-brief";
import { getUpcomingReminderTasks } from "../lib/updates-reminders";
import { usePeopleStore } from "../stores/people";
import { useProfileStore } from "../stores/profile";
import { useTasksStore } from "../stores/tasks";

export default function Home() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();

  const { loadPeople } = usePeopleStore(
    useShallow((s) => ({ loadPeople: s.loadFor })),
  );

  const { displayName, loadProfile } = useProfileStore(
    useShallow((s) => ({ displayName: s.displayName, loadProfile: s.loadFor })),
  );

  const { tasks, loadTasks } = useTasksStore(
    useShallow((s) => ({
      tasks: s.items,
      loadTasks: s.loadFor,
    })),
  );

  const [now, setNow] = useState(() => new Date());
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    if (!userId) return;
    void loadTasks(userId, { force: true });
  }, [userId, loadTasks]);

  useEffect(() => {
    if (!userId) return;
    void loadPeople(userId);
  }, [userId, loadPeople]);

  useEffect(() => {
    if (!userId) return;
    void loadProfile(userId);
  }, [userId, loadProfile]);

  useEffect(() => {
    if (!userId) {
      setCalendarEvents([]);
      return;
    }
    fetchCalendarEvents("next_7_days")
      .then((result) => setCalendarEvents(result.connected ? result.events : []))
      .catch(() => setCalendarEvents([]));
  }, [userId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const brief = useMemo(() => buildDailyBrief(tasks, now), [tasks, now]);
  const urgentCount = useMemo(
    () =>
      brief.needsAttention.filter(
        (task) =>
          task.type === "reminder" &&
          task.due_at &&
          new Date(task.due_at) <= now,
      ).length,
    [brief.needsAttention, now],
  );
  const statusTone = useMemo(() => {
    if (urgentCount > 0) return "urgent";
    if (brief.needsAttention.length > 0) return "attention";
    return "clear";
  }, [brief.needsAttention.length, urgentCount]);

  const greeting = useMemo(() => buildGreeting(now, displayName), [now, displayName]);
  const premiumStatus = buildPremiumStatus(statusTone);
  const briefSentence = useMemo(() => buildBriefSentence(brief, now), [brief, now]);
  const openCarson = useCarsonStore((s) => s.setOpen);

  // ── Stats grid — real counts, same sources as Updates ──────────────
  const upcomingReminders = useMemo(
    () => getUpcomingReminderTasks(tasks, brief.needsAttention, now),
    [tasks, brief.needsAttention, now],
  );
  const completedCount = useMemo(
    () => tasks.filter((t) => t.status === "done").length,
    [tasks],
  );

  return (
    <section
      data-testid="home-root"
      className="mx-auto max-w-2xl"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 36px)" }}
    >
      {/* ── Briefing — no card, text on page ────────────────────────── */}
      <div data-testid="home-briefing" className="mt-0 px-2 text-center sm:mt-4">
        <p data-testid="home-greeting" className="text-[13px] font-normal tracking-[0.01em] text-text-soft">{greeting}</p>
        <h1
          data-testid="home-status-headline"
          className="mx-auto mt-1 max-w-xs text-[26px] leading-[1.1] tracking-[-0.015em] text-text sm:text-[32px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {premiumStatus}
        </h1>
        <div className="mt-2.5 flex items-center justify-center gap-2">
          <span
            data-testid="home-status-indicator"
            aria-hidden
            className={
              "h-1.5 w-1.5 shrink-0 rounded-full " +
              (statusTone === "urgent"
                ? "bg-danger"
                : statusTone === "attention"
                  ? "bg-gold"
                  : "bg-sage")
            }
          />
          <p data-testid="home-brief-sentence" className="text-[13px] font-medium text-text-soft">{briefSentence}</p>
        </div>
      </div>

      {/* ── Stats grid — real counts, tap to jump to Updates ─────────── */}
      <div data-testid="home-stats-grid" className="mt-9 border-t border-border">
        <div className="grid grid-cols-2">
          <button
            type="button"
            onClick={() => navigate("/updates?tab=needs-you")}
            className="border-b border-r border-border py-[22px] pr-5 text-left"
          >
            <span className="mb-2.5 flex items-center gap-[7px]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gold" />
              <span className="text-[11.5px] font-bold uppercase tracking-[0.04em] text-text-soft">Needs You</span>
            </span>
            <span className="block text-[33px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {brief.needsAttention.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/updates?tab=waiting")}
            className="border-b border-border py-[22px] pl-5 text-left"
          >
            <span className="mb-2.5 flex items-center gap-[7px]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-soft" />
              <span className="text-[11.5px] font-bold uppercase tracking-[0.04em] text-text-soft">Waiting</span>
            </span>
            <span className="block text-[33px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {brief.waitingOnOthers.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/updates?tab=needs-you")}
            className="border-r border-border py-[22px] pr-5 text-left"
          >
            <span className="mb-2.5 flex items-center gap-[7px]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-soft" />
              <span className="text-[11.5px] font-bold uppercase tracking-[0.04em] text-text-soft">Upcoming</span>
            </span>
            <span className="block text-[33px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {upcomingReminders.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/updates?tab=history")}
            className="py-[22px] pl-5 text-left"
          >
            <span className="mb-2.5 flex items-center gap-[7px]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-soft" />
              <span className="text-[11.5px] font-bold uppercase tracking-[0.04em] text-text-soft">Completed</span>
            </span>
            <span className="block text-[33px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {completedCount}
            </span>
          </button>
        </div>
      </div>

      {/* ── Waiting preview — hidden entirely when nothing is waiting ── */}
      {brief.waitingOnOthers.length > 0 && (
        <div data-testid="home-waiting-preview" className="mt-7 border-t border-border pt-6">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-text-soft">Waiting</p>
          <button type="button" onClick={() => navigate("/updates?tab=waiting")} className="w-full text-left">
            {brief.waitingOnOthers.slice(0, 2).map((t) => (
              <span key={t.id} className="flex items-baseline gap-2 py-1.5">
                <span aria-hidden className="h-[5px] w-[5px] shrink-0 rounded-full bg-text-soft" />
                <span className="text-[14.5px] font-medium leading-snug text-ink">{t.description}</span>
              </span>
            ))}
            {brief.waitingOnOthers.length > 2 && (
              <span className="block pl-[13px] pt-0.5 text-[13px] font-semibold text-text-soft">
                +{brief.waitingOnOthers.length - 2} more waiting
              </span>
            )}
          </button>
        </div>
      )}

      {/* ── Needs You — top item ─────────────────────────────────────── */}
      {brief.needsAttention.length > 0 && (
        <div data-testid="home-needs-you-preview" className="mt-6">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-gold">Needs You</p>
          <button type="button" onClick={() => navigate("/updates?tab=needs-you")} className="w-full text-left">
            <span className="block text-[16.5px] font-bold leading-snug text-ink">
              {brief.needsAttention[0].description}
            </span>
          </button>
        </div>
      )}

      {/* ── Talk to Carson — visual hero ────────────────────────────── */}
      <section data-testid="home-talk-to-carson-section" className="mt-6 sm:mt-8">
        <button
          data-testid="home-talk-to-carson-button"
          type="button"
          onClick={() => openCarson(true)}
          className="group flex w-full flex-col items-center gap-0.5 rounded-[14px] border border-border bg-gold/[0.08] px-6 py-4 shadow-[0_1px_2px_rgba(31,31,31,0.05)] transition active:scale-[0.982]"
        >
          <span className="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-gold/[0.12] ring-1 ring-gold/30 transition group-hover:bg-gold/[0.18] group-hover:ring-gold/55">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-gold">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </span>
          <div className="text-center">
            <p className="text-[20px] font-semibold tracking-[-0.02em] text-ink">Talk to Carson</p>
            <p className="text-[13px] text-text-soft">Ready when you are.</p>
          </div>
        </button>
      </section>

      {/* ── Next Up — lightweight context ───────────────────────────── */}
      <AwarenessCard events={calendarEvents} now={now} />
    </section>
  );
}

function buildGreeting(now: Date, displayName: string | null): string {
  const hour = now.getHours();
  const name = displayName ? `, ${displayName}` : "";
  if (hour < 12) return `Good morning${name}`;
  if (hour < 18) return `Good afternoon${name}`;
  return `Good evening${name}`;
}

function buildPremiumStatus(tone: "urgent" | "attention" | "clear"): string {
  if (tone === "urgent") return "Immediate attention required.";
  if (tone === "attention") return "A few things need attention.";
  return "Everything is under control.";
}

function buildBriefSentence(
  brief: ReturnType<typeof buildDailyBrief>,
  now: Date,
): string {
  const urgent = brief.needsAttention.filter(
    (t) => t.type === "reminder" && t.due_at && new Date(t.due_at) <= now,
  );
  const attention = brief.needsAttention.filter(
    (t) => !(t.type === "reminder" && t.due_at && new Date(t.due_at) <= now),
  );
  const waiting = brief.waitingOnOthers;

  if (urgent.length > 0) {
    return urgent.length === 1
      ? "One reminder is overdue."
      : `${urgent.length} reminders are overdue.`;
  }
  if (attention.length > 0) {
    if (waiting.length > 0) {
      return `${attention.length} item${attention.length > 1 ? "s" : ""} to review, ${waiting.length} waiting on others.`;
    }
    return attention.length === 1
      ? "One item ready for your review."
      : `${attention.length} items ready for your review.`;
  }
  if (waiting.length > 0) {
    return waiting.length === 1
      ? "One item is waiting on someone."
      : `${waiting.length} items are waiting on others.`;
  }
  if (brief.done.length > 0) {
    return brief.done.length === 1
      ? "One thing wrapped up today."
      : `${brief.done.length} things wrapped up today.`;
  }
  return "Your day is clear.";
}
