import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";

/**
 * Recipient-facing confirmation page.
 *
 * Reached via the link the host shares (`/confirm?task=<id>`). The recipient
 * does NOT sign in — `/api/get-confirm-task` and `/api/confirm-task` use the
 * Supabase service role on the server to read/write a single task by id, so
 * no public RLS policy on the tasks table is required.
 */

interface TaskInfo {
  id: string;
  description: string;
  assignedTo: string | null;
  status: "pending" | "done" | "cancelled" | string;
  confirmedAt: string | null;
  ownerPhone: string | null;
}

export default function Confirm() {
  const [params] = useSearchParams();
  const taskId = params.get("task");

  const [info, setInfo] = useState<TaskInfo | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmedRef = useRef(false);

  useEffect(() => {
    if (!taskId) {
      setLoadState("error");
      setLoadError("Missing task id in the link.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/get-confirm-task?taskId=${encodeURIComponent(taskId)}`);
        const data = (await res.json()) as Partial<TaskInfo> & { error?: string };
        if (cancelled) return;
        if (!res.ok || !data.id) {
          setLoadState("error");
          setLoadError(data.error || "Could not find that task.");
          return;
        }
        setInfo({
          id: data.id,
          description: data.description ?? "",
          assignedTo: data.assignedTo ?? null,
          status: data.status ?? "pending",
          confirmedAt: data.confirmedAt ?? null,
          ownerPhone: data.ownerPhone ?? null,
        });
        setLoadState("ready");
      } catch (err) {
        if (cancelled) return;
        setLoadState("error");
        setLoadError(
          err instanceof TypeError
            ? "Network issue. Please check your connection."
            : "Could not load that task.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  async function handleConfirm() {
    if (!taskId || confirmedRef.current || confirming) return;
    confirmedRef.current = true;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch("/api/confirm-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        already_done?: boolean;
        error?: string;
      };
      if (!res.ok || data.error) {
        setConfirmError(data.error || "Could not confirm. Please try again.");
        confirmedRef.current = false;
        return;
      }
      // Either success or already_done — both mean the task is now done.
      // The server sends a push notification to the owner automatically.
      setInfo((prev) =>
        prev
          ? { ...prev, status: "done", confirmedAt: new Date().toISOString() }
          : prev,
      );
    } catch (err) {
      confirmedRef.current = false;
      setConfirmError(
        err instanceof TypeError
          ? "Network issue. Please check your connection."
          : "Could not confirm. Please try again.",
      );
    } finally {
      setConfirming(false);
    }
  }

  return (
    <section className="mx-auto max-w-md space-y-5 rounded-2xl border border-sage/30 bg-white/85 p-6 shadow-sm">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-ink/50">
          Ra7etBal · راحة بال
        </p>
        <h1 className="text-2xl font-semibold text-ink">Task confirmation</h1>
      </header>

      {loadState === "loading" && (
        <div className="flex items-center justify-center py-6 text-ink/60">
          <Spinner size={20} label="Loading task" />
        </div>
      )}

      {loadState === "error" && (
        <AuthNotice kind="error">{loadError ?? "Could not load that task."}</AuthNotice>
      )}

      {loadState === "ready" && info && (
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-ink/50">Task</p>
            <p className="text-base leading-snug text-ink">{info.description}</p>
            {info.assignedTo && (
              <p className="text-sm text-ink/55">For: {info.assignedTo}</p>
            )}
          </div>

          {info.status === "done" ? (
            <div className="space-y-3">
              <AuthNotice kind="success">Marked as done.</AuthNotice>
            </div>
          ) : (
            <>
              {confirmError && <AuthNotice kind="error">{confirmError}</AuthNotice>}
              <button
                type="button"
                onClick={handleConfirm}
                disabled={confirming}
                aria-busy={confirming}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-sage px-5 py-3 text-base font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {confirming && <Spinner size={16} />}
                <span>{confirming ? "Confirming…" : "Mark done"}</span>
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
