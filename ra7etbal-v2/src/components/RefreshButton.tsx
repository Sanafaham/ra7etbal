import { useState } from "react";
import Spinner from "./Spinner";

interface Props {
  onClick: () => void | Promise<void>;
  label?: string;
}

/**
 * Small icon button placed in list-screen headers. Force-refreshes the
 * underlying store from Supabase. Used by Actions / Follow-ups / Messages
 * so the host can pull the latest after the recipient confirms via the
 * public link, without waiting for realtime.
 */
export default function RefreshButton({ onClick, label = "Refresh" }: Props) {
  const [spinning, setSpinning] = useState(false);

  async function handle() {
    if (spinning) return;
    setSpinning(true);
    try {
      await onClick();
    } finally {
      setSpinning(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handle()}
      aria-label={label}
      disabled={spinning}
      className="inline-flex items-center gap-2 rounded-full border border-sage/30 bg-white px-3 py-1.5 text-xs font-medium text-ink shadow-sm transition hover:bg-cream disabled:opacity-50"
    >
      {spinning ? (
        <Spinner size={12} />
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      <span>{label}</span>
    </button>
  );
}
