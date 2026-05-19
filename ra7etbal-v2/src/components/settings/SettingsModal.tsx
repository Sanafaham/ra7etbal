import { useEffect, useState } from "react";
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

type View = "list" | "confirm-clear";

/**
 * Settings modal — two-view, iOS-Settings-style.
 *
 * View 1 (list): grouped rows in a calm consumer-grade layout.
 *   - History · View history / Archive history (visible Coming-soon
 *     placeholders for the future first-class History feature).
 *   - Workspace · Clear history (active row, neutral colour).
 *
 * View 2 (confirm-clear): a calm in-modal confirmation pane with a
 * title, explanation, and two buttons (Cancel + Clear history). No
 * typed confirmation, no input, no keyboard — so iOS Safari has
 * nothing to auto-zoom and nothing to cover.
 *
 * After success: returns to View 1 with a success notice; the user
 * dismisses when ready. Stores are reset so every tab is empty when
 * the user navigates to it.
 */
export default function SettingsModal({ open, onClose, userId }: Props) {
  const [view, setView] = useState<View>("list");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);

  // Always start on the list view when the modal opens — never strand
  // the user on the confirmation pane between sessions.
  useEffect(() => {
    if (open) {
      setView("list");
      setNotice(null);
    }
  }, [open]);

  async function handleClear() {
    if (!userId || busy) return;
    setBusy(true);
    try {
      const { tasksDeleted, messagesDeleted } = await clearUserData(userId);
      // Empty the in-memory caches so every tab clears immediately on
      // next visit — and force-refresh on mount will confirm against
      // Supabase.
      useTasksStore.getState().reset();
      useMessagesStore.getState().reset();
      setNotice({
        kind: "success",
        text:
          tasksDeleted + messagesDeleted === 0
            ? "Nothing to clear. People and account untouched."
            : `Cleared ${tasksDeleted} task${tasksDeleted === 1 ? "" : "s"} and ${messagesDeleted} message${messagesDeleted === 1 ? "" : "s"}. People and account untouched.`,
      });
      setView("list");
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "Could not clear. Please try again.",
      });
      // Stay on the confirm view so the user can retry.
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    onClose();
  }

  if (view === "confirm-clear") {
    return (
      <Modal open={open} onClose={close} title="Settings" dismissable={!busy}>
        <ConfirmClear
          busy={busy}
          notice={notice?.kind === "error" ? notice.text : null}
          onCancel={() => {
            if (busy) return;
            setNotice(null);
            setView("list");
          }}
          onConfirm={() => void handleClear()}
        />
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title="Settings">
      <SettingsList
        notice={notice?.kind === "success" ? notice.text : null}
        onClickClear={() => {
          setNotice(null);
          setView("confirm-clear");
        }}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function SettingsList({
  notice,
  onClickClear,
}: {
  notice: string | null;
  onClickClear: () => void;
}) {
  return (
    <div className="space-y-5">
      {notice && <AuthNotice kind="success">{notice}</AuthNotice>}

      <Group label="History">
        <ComingSoonRow label="View history" />
        <ComingSoonRow label="Archive history" />
      </Group>

      <Group label="Workspace">
        <ActionRow label="Clear history" onClick={onClickClear} />
      </Group>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-[10px] font-medium uppercase tracking-wide text-ink/50">
        {label}
      </h3>
      <div className="overflow-hidden rounded-2xl border border-sage/20 bg-white/80 shadow-sm">
        {children}
      </div>
    </section>
  );
}

function ComingSoonRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-sage/10 px-4 py-3 last:border-b-0">
      <span className="text-sm text-ink/55">{label}</span>
      <span className="rounded-full border border-sage/20 bg-cream/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink/55">
        Coming soon
      </span>
    </div>
  );
}

function ActionRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 border-b border-sage/10 px-4 py-3 text-left transition hover:bg-cream/60 last:border-b-0"
    >
      <span className="text-base text-ink">{label}</span>
      <span aria-hidden className="text-ink/30">
        ›
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------

function ConfirmClear({
  busy,
  notice,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-lg font-semibold text-ink">Clear history?</h3>
        <p className="text-sm leading-snug text-ink/70">
          This will delete your tasks, messages, follow-ups, and completed
          history. Your People and account will stay.
        </p>
      </header>

      {notice && <AuthNotice kind="error">{notice}</AuthNotice>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-sage/30 bg-white px-5 py-2.5 text-sm font-medium text-ink shadow-sm transition hover:bg-cream disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <Spinner size={14} />}
          <span>{busy ? "Clearing…" : "Clear history"}</span>
        </button>
      </div>
    </div>
  );
}
