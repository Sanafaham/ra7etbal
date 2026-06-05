import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthNotice from "../auth/AuthNotice";
import Spinner from "../Spinner";
import Modal from "../ui/Modal";
import { archiveCompleted } from "../../lib/archive";
import { clearUserData } from "../../lib/cleanup";
import {
  checkPushSupport,
  enableReminderNotifications,
  isSubscriptionSavedForUser,
  type PushNotificationStatus,
} from "../../lib/push-notifications";
import { useMessagesStore } from "../../stores/messages";
import { useProfileStore } from "../../stores/profile";
import { useTasksStore } from "../../stores/tasks";

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string | null;
}

type View = "list" | "confirm-clear" | "confirm-archive";

export default function SettingsModal({ open, onClose, userId }: Props) {
  const navigate = useNavigate();
  const [view, setView] = useState<View>("list");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);

  const profileStore = useProfileStore();

  useEffect(() => {
    if (open) {
      setView("list");
      setNotice(null);
      if (userId && profileStore.status === "idle") {
        void profileStore.loadFor(userId);
      }
    }
  }, [open, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleClear() {
    if (!userId || busy) return;
    setBusy(true);
    try {
      const { tasksDeleted, messagesDeleted } = await clearUserData(userId);
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
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive() {
    if (!userId || busy) return;
    setBusy(true);
    try {
      const { tasksArchived, messagesArchived } = await archiveCompleted(userId);
      useTasksStore.getState().reset();
      useMessagesStore.getState().reset();
      setNotice({
        kind: "success",
        text:
          tasksArchived === 0
            ? "Nothing to archive. Completed items will show up here."
            : `Archived ${tasksArchived} task${tasksArchived === 1 ? "" : "s"} and ${messagesArchived} linked message${messagesArchived === 1 ? "" : "s"}. View them in History.`,
      });
      setView("list");
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "Could not archive. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    onClose();
  }

  if (view === "confirm-archive") {
    return (
      <Modal open={open} onClose={close} title="Settings" dismissable={!busy}>
        <ConfirmPane
          title="Archive completed?"
          body="This moves your completed tasks and their linked messages out of the active workspace. You'll still see them in View history."
          confirmLabel="Archive completed"
          tone="neutral"
          busy={busy}
          busyLabel="Archiving…"
          notice={notice?.kind === "error" ? notice.text : null}
          onCancel={() => {
            if (busy) return;
            setNotice(null);
            setView("list");
          }}
          onConfirm={() => void handleArchive()}
        />
      </Modal>
    );
  }

  if (view === "confirm-clear") {
    return (
      <Modal open={open} onClose={close} title="Settings" dismissable={!busy}>
        <ConfirmPane
          title="Clear history?"
          body="This will delete your tasks, messages, follow-ups, and completed history. Your People and account will stay."
          confirmLabel="Clear history"
          tone="strong"
          busy={busy}
          busyLabel="Clearing…"
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
        userId={userId}
        notice={notice?.kind === "success" ? notice.text : null}
        displayName={profileStore.displayName}
        onSaveDisplayName={async (name) => {
          if (!userId) return;
          await profileStore.save(userId, name);
        }}
        onClickViewHistory={() => {
          onClose();
          navigate("/history");
        }}
        onClickArchive={() => {
          setNotice(null);
          setView("confirm-archive");
        }}
        onClickClear={() => {
          setNotice(null);
          setView("confirm-clear");
        }}
        onClickDebug={() => {
          onClose();
          navigate("/debug");
        }}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function SettingsList({
  userId,
  notice,
  displayName,
  onSaveDisplayName,
  onClickViewHistory,
  onClickArchive,
  onClickClear,
  onClickDebug,
}: {
  userId: string | null;
  notice: string | null;
  displayName: string | null;
  onSaveDisplayName: (name: string) => Promise<void>;
  onClickViewHistory: () => void;
  onClickArchive: () => void;
  onClickClear: () => void;
  onClickDebug: () => void;
}) {
  return (
    <div className="space-y-5">
      {notice && <AuthNotice kind="success">{notice}</AuthNotice>}

      <Group label="Account">
        <DisplayNameRow displayName={displayName} onSave={onSaveDisplayName} />
      </Group>

      <Group label="History">
        <ActionRow label="View history" onClick={onClickViewHistory} />
        <ActionRow label="Archive history" onClick={onClickArchive} />
      </Group>

      <Group label="Workspace">
        <ActionRow label="Clear history" onClick={onClickClear} />
      </Group>

      <Group label="Reminders">
        <ReminderNotificationsRow userId={userId} />
      </Group>

      <Group label="Dev">
        <ActionRow label="Debug" onClick={onClickDebug} />
      </Group>
    </div>
  );
}

function DisplayNameRow({
  displayName,
  onSave,
}: {
  displayName: string | null;
  onSave: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setValue(displayName ?? "");
    setError(null);
    setSaved(false);
    setEditing(true);
    window.setTimeout(() => inputRef.current?.focus(), 50);
  }

  function cancel() {
    if (busy) return;
    setEditing(false);
    setError(null);
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(value);
      setSaved(true);
      setEditing(false);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="border-b border-sage/10 px-4 py-3 last:border-b-0">
        <p className="mb-1.5 text-xs text-ink/50">Your name</p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") cancel();
          }}
          disabled={busy}
          placeholder="e.g. Sana"
          maxLength={80}
          className="mb-2 w-full rounded-xl border border-sage/30 bg-white px-3 py-2 text-base text-ink placeholder:text-ink/30 focus:outline-none focus:ring-2 focus:ring-sage/40 disabled:opacity-50"
        />
        {error && <p className="mb-2 text-xs text-rose-700">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full bg-sage px-4 py-1.5 text-xs font-medium text-white transition hover:brightness-105 disabled:opacity-50"
          >
            {busy && <Spinner size={11} />}
            <span>{busy ? "Saving…" : "Save"}</span>
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="rounded-full border border-sage/30 bg-white px-4 py-1.5 text-xs font-medium text-ink transition hover:bg-cream disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      className="flex w-full items-center justify-between gap-3 border-b border-sage/10 px-4 py-3 text-left transition hover:bg-cream/60 last:border-b-0"
    >
      <span className="min-w-0">
        <span className="block text-base text-ink">Your name</span>
        <span className="block text-xs text-ink/55">
          {saved ? "Saved ✓" : (displayName ?? "Not set")}
        </span>
      </span>
      <span aria-hidden className="text-ink/30">
        ›
      </span>
    </button>
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

function ReminderNotificationsRow({ userId }: { userId: string | null }) {
  const [status, setStatus] = useState<PushNotificationStatus>(() =>
    checkPushSupport().supported ? "idle" : "unsupported",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refreshStatus() {
      if (!checkPushSupport().supported) {
        setStatus("unsupported");
        return;
      }

      if (Notification.permission === "denied") {
        setStatus("denied");
        return;
      }

      if (Notification.permission !== "granted") {
        setStatus("idle");
        return;
      }

      if (!userId) {
        setStatus("idle");
        return;
      }

      try {
        const saved = await isSubscriptionSavedForUser(userId);
        if (!cancelled) setStatus(saved ? "enabled" : "idle");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void refreshStatus();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function handleEnable() {
    if (!userId || busy) return;

    setBusy(true);
    try {
      const nextStatus = await enableReminderNotifications(userId);
      setStatus(nextStatus);
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }

  const statusText = getReminderStatusText(status, busy);
  const disabled = busy || status === "enabled" || status === "unsupported" || !userId;

  return (
    <button
      type="button"
      onClick={() => void handleEnable()}
      disabled={disabled}
      aria-busy={busy}
      className="flex w-full items-center justify-between gap-3 border-b border-sage/10 px-4 py-3 text-left transition hover:bg-cream/60 disabled:cursor-default disabled:hover:bg-transparent last:border-b-0"
    >
      <span className="min-w-0">
        <span className="block text-base text-ink">Enable reminder notifications</span>
        <span className="block text-xs text-ink/55">{statusText}</span>
      </span>
      <span
        aria-hidden
        className={
          "h-3 w-3 shrink-0 rounded-full " +
          (status === "enabled"
            ? "bg-sage"
            : status === "denied" || status === "error"
              ? "bg-gold"
              : "bg-ink/20")
        }
      />
    </button>
  );
}

function getReminderStatusText(status: PushNotificationStatus, busy: boolean): string {
  if (busy) return "Enabling...";

  switch (status) {
    case "enabled":
      return "Enabled";
    case "denied":
      return "Permission denied";
    case "unsupported":
      return "Not supported on this device";
    case "error":
      return "Error";
    case "idle":
      return "Off";
  }
}

// ---------------------------------------------------------------------------

function ConfirmPane({
  title,
  body,
  confirmLabel,
  busyLabel,
  tone,
  busy,
  notice,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel: string;
  tone: "neutral" | "strong";
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmCls =
    tone === "strong"
      ? "bg-ink text-white hover:brightness-110"
      : "bg-sage text-white hover:brightness-105";
  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-lg font-semibold text-ink">{title}</h3>
        <p className="text-sm leading-snug text-ink/70">{body}</p>
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
          className={
            "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 " +
            confirmCls
          }
        >
          {busy && <Spinner size={14} />}
          <span>{busy ? busyLabel : confirmLabel}</span>
        </button>
      </div>
    </div>
  );
}
