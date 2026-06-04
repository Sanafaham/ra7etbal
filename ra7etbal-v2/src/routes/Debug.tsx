import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { signOut } from "../lib/session";
import { supabase } from "../lib/supabase";

const statusColors: Record<string, string> = {
  loading: "bg-amber-100 text-amber-900 border-amber-300",
  signed_out: "bg-stone-100 text-stone-700 border-stone-300",
  signed_in: "bg-emerald-100 text-emerald-900 border-emerald-300",
  recovery: "bg-rose-100 text-rose-900 border-rose-800",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-ink/50">{label}</span>
      <span className="mt-1 break-all font-mono text-sm text-ink">{value}</span>
    </div>
  );
}

type TestPushState = "idle" | "sending" | "success" | "error";

export default function Debug() {
  const { status, user, lastEvent, eventCount } = useAuth();
  const [testPushState, setTestPushState] = useState<TestPushState>("idle");
  const [testPushResult, setTestPushResult] = useState<string | null>(null);

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

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => { void signOut(); }}
          disabled={status !== "signed_in"}
          className="rounded-full border border-sage/40 bg-sage px-4 py-2 text-sm font-medium text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          Sign out
        </button>

        <button
          type="button"
          onClick={() => { void handleTestPush(); }}
          disabled={status !== "signed_in" || testPushState === "sending"}
          className="rounded-full border border-charcoal/20 bg-white px-4 py-2 text-sm font-medium text-ink shadow-sm transition hover:bg-cream disabled:cursor-not-allowed disabled:opacity-40"
        >
          {testPushState === "sending" ? "Sending…" : "Send test push"}
        </button>
      </div>

      {testPushResult && (
        <p
          className={
            "rounded-xl border px-4 py-2.5 text-sm " +
            (testPushState === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-rose-200 bg-rose-50 text-rose-900")
          }
        >
          {testPushResult}
        </p>
      )}

      <p className="text-xs text-ink/60">
        Internal session verification page. The "Clear history" action lives in
        Settings (gear icon in the header) now.
      </p>
    </section>
  );
}
