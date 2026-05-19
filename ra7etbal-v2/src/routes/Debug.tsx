import { useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { clearUserData } from "../lib/cleanup";
import { signOut } from "../lib/session";
import { useMessagesStore } from "../stores/messages";
import { useTasksStore } from "../stores/tasks";

const statusColors: Record<string, string> = {
  loading: "bg-amber-100 text-amber-900 border-amber-300",
  signed_out: "bg-stone-100 text-stone-700 border-stone-300",
  signed_in: "bg-emerald-100 text-emerald-900 border-emerald-300",
  recovery: "bg-rose-100 text-rose-900 border-rose-300",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-ink/50">{label}</span>
      <span className="mt-1 break-all font-mono text-sm text-ink">{value}</span>
    </div>
  );
}

const CONFIRM_PHRASE = "clear my data";

function DangerZone({ userId }: { userId: string | null }) {
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const canClear = !!userId && !busy && phrase.trim().toLowerCase() === CONFIRM_PHRASE;

  async function handleClear() {
    if (!canClear || !userId) return;
    setBusy(true);
    setNotice(null);
    try {
      const { tasksDeleted, messagesDeleted } = await clearUserData(userId);
      // Reset the in-memory caches so the lists empty immediately. The next
      // visit to any tab will re-fetch (and find nothing).
      useTasksStore.getState().reset();
      useMessagesStore.getState().reset();
      setPhrase("");
      setNotice({
        kind: "success",
        text: `Cleared ${tasksDeleted} task(s) and ${messagesDeleted} message(s). People and account untouched.`,
      });
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "Cleanup failed. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-rose-200 bg-rose-50/40 p-5">
      <header className="space-y-1">
        <h3 className="text-base font-semibold text-rose-900">Danger zone</h3>
        <p className="text-xs text-rose-900/80">
          Deletes ALL of your tasks and messages. People, account, and drafts are
          preserved. Cannot be undone.
        </p>
      </header>

      <label className="block text-xs font-medium uppercase tracking-wide text-rose-900/80">
        Type <span className="rounded bg-rose-100 px-1 font-mono">clear my data</span> to confirm
        <input
          type="text"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          className="mt-2 w-full rounded-xl border border-rose-300 bg-white px-3 py-2 font-mono text-sm text-ink outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-300 disabled:opacity-50"
        />
      </label>

      {notice && <AuthNotice kind={notice.kind}>{notice.text}</AuthNotice>}

      <button
        type="button"
        onClick={() => void handleClear()}
        disabled={!canClear}
        aria-busy={busy}
        className="inline-flex items-center gap-2 rounded-full bg-rose-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy && <Spinner size={14} />}
        <span>{busy ? "Clearing…" : "Clear my tasks & messages"}</span>
      </button>
    </section>
  );
}

export default function Debug() {
  const { status, user, lastEvent, eventCount } = useAuth();

  const supabaseEnv = import.meta.env.VITE_SUPABASE_URL
    ? new URL(import.meta.env.VITE_SUPABASE_URL).host
    : "(unset)";

  return (
    <div className="space-y-6">
      <section className="space-y-5 rounded-2xl border border-sage/30 bg-white/80 p-6 shadow-sm">
        <header className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Session debug</h2>
          <span
            className={
              "rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wide " +
              (statusColors[status] ?? "bg-stone-100 text-stone-700 border-stone-300")
            }
          >
            {status}
          </span>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Supabase host" value={supabaseEnv} />
          <Field label="Last auth event" value={lastEvent ?? "—"} />
          <Field label="Event count" value={String(eventCount)} />
          <Field label="User id" value={user?.id ?? "—"} />
          <Field label="User email" value={user?.email ?? "—"} />
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={() => {
              void signOut();
            }}
            disabled={status !== "signed_in"}
            className="rounded-full border border-sage/40 bg-sage px-4 py-2 text-sm font-medium text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            Sign out
          </button>
        </div>
      </section>

      {status === "signed_in" && <DangerZone userId={user?.id ?? null} />}
    </div>
  );
}
