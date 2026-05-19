import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import AuthNotice from "../components/auth/AuthNotice";
import HistoryCard from "../components/history/HistoryCard";
import RefreshButton from "../components/RefreshButton";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { listHistoryMessages } from "../lib/messages";
import { listHistoryTasks } from "../lib/tasks";
import type { Message } from "../types/message";
import type { Task } from "../types/task";

type Status = "idle" | "loading" | "ready" | "error";

interface DateGroup {
  key: string;
  label: string;
  tasks: Task[];
}

export default function History() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!userId) return;
    setStatus("loading");
    setError(null);
    try {
      const t = await listHistoryTasks();
      const m = await listHistoryMessages(t.map((row) => row.id));
      setTasks(t);
      setMessages(m);
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not load history.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const messageByTaskId = useMemo(() => {
    const m = new Map<string, { content: string }>();
    for (const msg of messages) {
      if (msg.task_id) m.set(msg.task_id, { content: msg.content });
    }
    return m;
  }, [messages]);

  const groups = useMemo(() => groupByDate(tasks), [tasks]);
  const initialLoading = status === "loading" && tasks.length === 0;

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">History</h1>
          <p className="text-sm text-ink/60">
            Past completed coordination — confirmed and archived items.
          </p>
        </div>
        <RefreshButton onClick={load} />
      </header>

      {error && status !== "loading" && (
        <AuthNotice kind="error">
          {error}{" "}
          <button type="button" onClick={() => void load()} className="ml-1 underline">
            Try again
          </button>
        </AuthNotice>
      )}

      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading history" />
        </div>
      )}

      {!initialLoading && tasks.length === 0 && status === "ready" && (
        <div className="rounded-2xl border border-dashed border-sage/40 bg-white/60 p-8 text-center text-sm text-ink/70">
          Nothing in history yet. Confirmed and archived items will appear here.
          <div className="mt-3">
            <Link
              to="/"
              className="rounded-full border border-sage/30 bg-white px-3 py-1.5 text-xs font-medium text-ink shadow-sm transition hover:bg-cream"
            >
              ← Back to Home
            </Link>
          </div>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.key} className="space-y-3">
          <h2 className="px-1 text-[10px] font-medium uppercase tracking-wide text-ink/55">
            {g.label} · {g.tasks.length}
          </h2>
          <ul className="space-y-3">
            {g.tasks.map((t) => (
              <li key={t.id}>
                <HistoryCard task={t} message={messageByTaskId.get(t.id) ?? null} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

/**
 * Bucket history rows into human date groups. Newest groups first; within
 * each group, the original task order from the query is preserved (DB
 * already sorts by confirmed_at DESC nulls-last so this falls out right).
 */
function groupByDate(tasks: Task[]): DateGroup[] {
  const now = new Date();
  const startOfToday = startOfDay(now);
  const startOfYesterday = addDays(startOfToday, -1);
  const startOfThisWeek = addDays(startOfToday, -((now.getDay() + 6) % 7)); // Mon
  const startOfLastWeek = addDays(startOfThisWeek, -7);

  const groups: Record<string, DateGroup> = {};
  const orderedKeys: string[] = [];

  function bucket(t: Task): { key: string; label: string } {
    const stamp = new Date(t.confirmed_at ?? t.archived_at ?? t.created_at);
    if (stamp >= startOfToday) return { key: "today", label: "Today" };
    if (stamp >= startOfYesterday) return { key: "yesterday", label: "Yesterday" };
    if (stamp >= startOfThisWeek) return { key: "thisWeek", label: "Earlier this week" };
    if (stamp >= startOfLastWeek) return { key: "lastWeek", label: "Last week" };
    return {
      key: `m-${stamp.getFullYear()}-${stamp.getMonth()}`,
      label: stamp.toLocaleString(undefined, { month: "long", year: "numeric" }),
    };
  }

  for (const t of tasks) {
    const { key, label } = bucket(t);
    if (!groups[key]) {
      groups[key] = { key, label, tasks: [] };
      orderedKeys.push(key);
    }
    groups[key].tasks.push(t);
  }
  return orderedKeys.map((k) => groups[k]);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
