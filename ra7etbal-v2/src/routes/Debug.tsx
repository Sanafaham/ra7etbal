import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAuth } from "../hooks/useAuth";
import { signOut } from "../lib/session";
import { supabase } from "../lib/supabase";
import { useTasksStore } from "../stores/tasks";
import { usePeopleStore } from "../stores/people";
import { useProfileStore } from "../stores/profile";
import { fetchCalendarEvents } from "../lib/calendar";
import { buildMorningBriefSpoken } from "../lib/morning-brief";

const statusColors: Record<string, string> = {
  loading: "bg-gold text-cream border-gold",
  signed_out: "bg-surface-subtle text-ink border-border",
  signed_in: "bg-gold text-cream border-gold",
  recovery: "bg-surface-subtle text-ink border-gold",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-ink">{label}</span>
      <span className="mt-1 break-all font-mono text-sm text-ink">{value}</span>
    </div>
  );
}

type TestPushState = "idle" | "sending" | "success" | "error";
type BriefPreviewState = "idle" | "loading" | "done" | "error";

export default function Debug() {
  const { status, user, lastEvent, eventCount } = useAuth();
  const [testPushState, setTestPushState] = useState<TestPushState>("idle");
  const [testPushResult, setTestPushResult] = useState<string | null>(null);
  const [briefState, setBriefState] = useState<BriefPreviewState>("idle");
  const [briefText, setBriefText] = useState<string | null>(null);

  const tasks = useTasksStore(useShallow((s) => s.items));
  const people = usePeopleStore(useShallow((s) => s.items));
  const displayName = useProfileStore((s) => s.displayName);

  async function handlePreviewBrief() {
    setBriefState("loading");
    setBriefText(null);
    try {
      const calResult = await fetchCalendarEvents("next_7_days").catch(() => null);
      const calEvents = calResult?.connected ? calResult.events : [];
      const text = buildMorningBriefSpoken(tasks, people, displayName, new Date(), calEvents);
      setBriefText(text || "(no brief generated — no data)");
      setBriefState("done");
    } catch (err) {
      setBriefText(err instanceof Error ? err.message : "Unexpected error.");
      setBriefState("error");
    }
  }

  async function handleTestPush() {
    setTestPushState("sending");
    setTestPushResult(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        setTestPushResult("Not signed in — no session token available.");
        setTestPushState("error");
        return;
      }
      const res = await fetch("/api/send-test-push", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (json.success) {
        setTestPushResult(`Sent to ${json.sent} device(s). Check your iPhone.`);
        setTestPushState("success");
      } else {
        const detail =
          Array.isArray(json.errors) && json.errors.length > 0
            ? json.errors.join(" | ")
            : json.error ?? "Unknown error";
        setTestPushResult(`Failed: ${detail}`);
        setTestPushState("error");
      }
    } catch (err) {
      setTestPushResult(err instanceof Error ? err.message : "Unexpected error.");
      setTestPushState("error");
    }
  }

  const supabaseEnv = import.meta.env.VITE_SUPABASE_URL
    ? new URL(import.meta.env.VITE_SUPABASE_URL).host
    : "(unset)";

  return (
    <section className="space-y-5 rounded-2xl border border-border bg-surface p-6 shadow-sm">
      <header className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Session debug</h2>
        <span
          className={
            "rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wide " +
            (statusColors[status] ?? "bg-surface-subtle text-ink border-border")
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

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => { void signOut(); }}
          disabled={status !== "signed_in"}
          className="rounded-full border border-gold bg-surface-subtle px-4 py-2 text-sm font-medium text-ink shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          Sign out
        </button>

        <button
          type="button"
          onClick={() => { void handleTestPush(); }}
          disabled={status !== "signed_in" || testPushState === "sending"}
          className="rounded-full border border-gold bg-gold px-4 py-2 text-sm font-medium text-cream shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {testPushState === "sending" ? "Sending…" : "Send test push"}
        </button>

        <button
          type="button"
          onClick={() => { void handlePreviewBrief(); }}
          disabled={status !== "signed_in" || briefState === "loading"}
          className="rounded-full border border-gold bg-gold px-4 py-2 text-sm font-medium text-cream shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {briefState === "loading" ? "Generating…" : "Preview morning brief"}
        </button>
      </div>

      {testPushResult && (
        <p
          className={
            "rounded-xl border px-4 py-2.5 text-sm " +
            (testPushState === "success"
              ? "border-gold bg-gold text-cream"
              : "border-gold bg-surface-subtle text-ink")
          }
        >
          {testPushResult}
        </p>
      )}

      {briefText && (
        <div
          className={
            "rounded-xl border px-4 py-3 text-sm " +
            (briefState === "error"
              ? "border-gold bg-surface-subtle text-ink"
              : "border-gold/35 bg-surface-subtle text-ink")
          }
        >
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink">
            Morning Brief V3 preview
          </p>
          <p className="leading-relaxed">{briefText}</p>
        </div>
      )}

      <p className="text-xs text-ink">
        Internal session verification page. The "Clear history" action lives in
        Settings (gear icon in the header) now.
      </p>
    </section>
  );
}
