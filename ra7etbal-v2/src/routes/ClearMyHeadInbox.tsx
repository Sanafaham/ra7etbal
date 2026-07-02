/**
 * Clear My Head Inbox — read-only thoughts moved here by "Leave here for
 * now" in Clear My Head Review. No editing, no conversion actions: the only
 * actions are Delete (permanent) and asking Carson to go through the inbox.
 * Distinct from the Notes tab (id "inbox", carson_notes) and from the
 * separate Home-screen capture inbox (inbox_items / InboxReviewPanel).
 */
import { useEffect, useState } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import {
  deleteClearMyHeadInboxItem,
  listClearMyHeadInboxItems,
  type ClearMyHeadInboxItem,
} from "../lib/clear-my-head-inbox";

export default function ClearMyHeadInbox({ headerless = false }: { headerless?: boolean } = {}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [items, setItems] = useState<ClearMyHeadInboxItem[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const initialLoading = status === "loading" && items.length === 0;

  async function reload() {
    if (!userId) return;
    setStatus((s) => (s === "ready" ? "ready" : "loading"));
    setError(null);
    try {
      const loaded = await listClearMyHeadInboxItems(100);
      setItems(loaded);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the inbox.");
      setStatus("error");
    }
  }

  useEffect(() => {
    if (!userId) { setItems([]); setStatus("idle"); return; }
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function handleDelete(item: ClearMyHeadInboxItem) {
    if (deletingId) return;
    if (confirmingDeleteId !== item.id) {
      setConfirmingDeleteId(item.id);
      window.setTimeout(() => setConfirmingDeleteId((c) => (c === item.id ? null : c)), 3000);
      return;
    }
    setConfirmingDeleteId(null);
    setDeletingId(item.id);
    setError(null);
    try {
      await deleteClearMyHeadInboxItem(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this thought.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="space-y-4">
      {!headerless && (
        <header>
          <h1 className="text-xl font-semibold text-ink">Inbox</h1>
          <p className="text-xs text-ink/55">
            Thoughts you left for later from Clear My Head. Ask Carson to go through your
            inbox, or delete what you no longer need.
          </p>
        </header>
      )}

      {error && <AuthNotice kind="error">{error}</AuthNotice>}

      {initialLoading && (
        <div className="flex items-center justify-center py-12 text-ink/60">
          <Spinner size={20} label="Loading" />
        </div>
      )}

      {status === "ready" && (
        items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-sage/20 bg-white/40 px-4 py-6 text-sm text-ink/45">
            Your inbox is empty. Thoughts you leave for later in Clear My Head will show up
            here.
          </div>
        ) : (
          <ul className="space-y-2.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-2xl border border-sage/20 bg-white/70 px-4 py-3 shadow-sm"
              >
                <p className="whitespace-pre-wrap text-sm leading-snug text-ink">{item.text}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-ink/45">{formatDate(item.created_at)}</span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(item)}
                    disabled={deletingId === item.id}
                    aria-label={`Delete "${item.text}" from inbox`}
                    className="rounded-full border border-rose-200 bg-rose-50/80 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-rose-700 shadow-sm transition hover:bg-rose-100 disabled:opacity-50"
                  >
                    {confirmingDeleteId === item.id ? "Confirm delete" : "Delete"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
