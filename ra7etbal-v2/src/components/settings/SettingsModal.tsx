import { useState } from "react";
import AuthNotice from "../auth/AuthNotice";
import Spinner from "../Spinner";
import Modal from "../ui/Modal";
import { clearUserData } from "../../lib/cleanup";
import { useMessagesStore } from "../../stores/messages";
import { useTasksStore } from "../../stores/tasks";

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string | null;
}

const CONFIRM_PHRASE = "clear my history";

/**
 * Settings modal — the gear-icon menu.
 *
 * Today this surfaces only the "Clear history" action. The layout is
 * deliberately sectioned ("History" / "Danger zone") so the future
 * History feature drops in as a new section above Danger zone without
 * restructuring this file. History itself will likely be a /history
 * route opened from a row here, not a panel inside this modal.
 */
export default function SettingsModal({ open, onClose, userId }: Props) {
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    { kind: "error" | "success"; text: string } | null
  >(null);

  const canClear =
    !!userId && !busy && phrase.trim().toLowerCase() === CONFIRM_PHRASE;

  async function handleClear() {
    if (!canClear || !userId) return;
    setBusy(true);
    setNotice(null);
    try {
      const { tasksDeleted, messagesDeleted } = await clearUserData(userId);
      // Empty the in-memory caches so every tab clears immediately.
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
        text: err instanceof Error ? err.message : "Could not clear. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    if (busy) return;
    // Reset transient state so reopening starts clean.
    setPhrase("");
    setNotice(null);
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Settings" dismissable={!busy}>
      <div className="space-y-5">
        {/* === History (placeholder for future first-class section) ===
            History / Archive / Clear are conceptually the same surface —
            "what's already completed". For now only Clear is wired. */}

        <section className="space-y-3 rounded-2xl border border-rose-200 bg-rose-50/40 p-4">
          <header className="space-y-1">
            <h3 className="text-sm font-semibold text-rose-900">Danger zone</h3>
            <p className="text-xs text-rose-900/80">
              Permanently delete all your tasks and messages, including completed
              history. People and your account are preserved. Cannot be undone.
            </p>
          </header>

          <label className="block text-[10px] font-medium uppercase tracking-wide text-rose-900/80">
            Type{" "}
            <span className="rounded bg-rose-100 px-1 font-mono">clear my history</span>{" "}
            to confirm
            <input
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              disabled={busy}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              // 16px (text-base) is required to stop iOS Safari from
              // auto-zooming on focus. Anything smaller triggers it.
              className="mt-2 w-full rounded-xl border border-rose-300 bg-white px-3 py-2 font-mono text-base normal-case text-ink outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-300 disabled:opacity-50"
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
            <span>{busy ? "Clearing…" : "Clear history"}</span>
          </button>
        </section>
      </div>
    </Modal>
  );
}
