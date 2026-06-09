/**
 * InboxReviewPanel — Inbox Review V1
 *
 * Shows unprocessed inbox_items captured via Text Carson (or future voice
 * capture). Collapses entirely when the inbox is empty.
 *
 * Actions per item:
 *   Dismiss     — marks processed_at immediately, item disappears
 *   Keep        — collapses item for the session (local state only, no DB write)
 *   Remind me   — pre-fills Clear My Head with the content; item stays open
 *   Delegate    — pre-fills Clear My Head with the content; item stays open
 *   Task        — pre-fills Clear My Head with the content; item stays open
 *
 * Convert actions (Remind / Delegate / Task) do NOT mark processed_at.
 * The item remains visible until the user explicitly dismisses it, ensuring
 * no open loop is lost if the user taps convert but never completes the save.
 */

import { useEffect, useState } from "react";
import type { InboxItem } from "../../types/inbox";
import { listInboxItems, markInboxItemProcessed } from "../../lib/inbox";

interface Props {
  userId: string | null;
  /** Called when a convert button is tapped — pre-fills Clear My Head. */
  onPrefill: (text: string) => void;
}

export default function InboxReviewPanel({ userId, onPrefill }: Props) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!userId) return;
    listInboxItems()
      .then(setItems)
      .catch(() => {
        /* silent — panel just won't show */
      })
      .finally(() => setLoaded(true));
  }, [userId]);

  const visible = items.filter((item) => !kept.has(item.id));

  if (!loaded || visible.length === 0) return null;

  async function handleDismiss(id: string) {
    setDismissing((prev) => new Set(prev).add(id));
    try {
      await markInboxItemProcessed(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch {
      // Failed — remove the dismissing spinner but leave item visible
    } finally {
      setDismissing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function handleKeep(id: string) {
    setKept((prev) => new Set(prev).add(id));
  }

  function handleConvert(content: string) {
    onPrefill(content);
  }

  return (
    <section className="mt-3 rounded-[24px] border border-sage/25 bg-white/72 p-4 shadow-sm backdrop-blur-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gold/20 text-[11px] font-bold text-gold-dark">
          {visible.length}
        </span>
        <h2 className="text-sm font-semibold text-text">Inbox</h2>
        <p className="text-xs text-text-soft">Captured thoughts waiting for your decision</p>
      </div>

      <ul className="space-y-2">
        {visible.map((item) => (
          <li
            key={item.id}
            className="rounded-2xl border border-sage/15 bg-card/60 px-3 py-2.5"
          >
            <p className="mb-2 text-[14px] leading-snug text-text">{item.content}</p>
            <p className="mb-2.5 text-[11px] text-text-muted">{timeAgo(item.created_at)}</p>
            <div className="flex flex-wrap gap-1.5">
              <ConvertButton
                label="Remind me"
                onClick={() => handleConvert(`Remind me to ${item.content}`)}
              />
              <ConvertButton
                label="Delegate"
                onClick={() => handleConvert(item.content)}
              />
              <ConvertButton
                label="Task"
                onClick={() => handleConvert(item.content)}
              />
              <button
                type="button"
                onClick={() => handleKeep(item.id)}
                className="rounded-full border border-sage/20 bg-transparent px-2.5 py-1 text-xs font-medium text-text-soft transition hover:bg-sage/10"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={() => void handleDismiss(item.id)}
                disabled={dismissing.has(item.id)}
                className="rounded-full border border-danger/20 bg-transparent px-2.5 py-1 text-xs font-medium text-danger/70 transition hover:bg-danger/5 disabled:opacity-50"
              >
                {dismissing.has(item.id) ? "…" : "Dismiss"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConvertButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-charcoal/15 bg-charcoal/90 px-2.5 py-1 text-xs font-medium text-ivory transition hover:bg-espresso"
    >
      {label}
    </button>
  );
}

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
