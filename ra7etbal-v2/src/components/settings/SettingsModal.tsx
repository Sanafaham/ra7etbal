import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import AuthNotice from "../auth/AuthNotice";
import Spinner from "../Spinner";
import Modal from "../ui/Modal";
import CarsonAmbientBackground from "../carson/CarsonAmbientBackground";
import { archiveCompleted } from "../../lib/archive";
import { clearUserData } from "../../lib/cleanup";
import { supabase } from "../../lib/supabase";
import { useHouseholdRulesStore } from "../../stores/household-rules";
import {
  checkPushSupport,
  disableReminderNotifications,
  enableReminderNotifications,
  getStoredInstallationId,
  isCurrentDeviceRow,
  isSubscriptionSavedForUser,
  listPushSubscriptionDevices,
  refreshPushSubscription,
  removePushSubscriptionDevice,
  type PushNotificationStatus,
  type PushSubscriptionDeviceInfo,
} from "../../lib/push-notifications";
import { needsIOSInstallGuidance } from "../../lib/pwa-standalone";
import { useMessagesStore } from "../../stores/messages";
import { useProfileStore } from "../../stores/profile";
import { useTasksStore } from "../../stores/tasks";

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string | null;
  calendarRevoked?: boolean;
  onCalendarReconnected?: () => void;
  onCalendarDisconnected?: () => void;
}

const settingsAmbientLayer = <CarsonAmbientBackground className="z-[1]" />;

type View = "list" | "confirm-clear" | "confirm-archive" | "confirm-calendar-disconnect" | "delegation-rules" | "notification-devices";

export default function SettingsModal({ open, onClose, userId, calendarRevoked, onCalendarReconnected, onCalendarDisconnected }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<View>("list");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);

  const profileStore = useProfileStore();

  // Detect Google Calendar OAuth callback result via URL params.
  useEffect(() => {
    const calParam = searchParams.get("calendar");
    if (!calParam) return;
    // Strip the param from URL without triggering a navigation
    const next = new URLSearchParams(searchParams);
    next.delete("calendar");
    setSearchParams(next, { replace: true });

    if (calParam === "connected") {
      setNotice({ kind: "success", text: "Google Calendar connected." });
      onCalendarReconnected?.();
    } else if (calParam === "error") {
      setNotice({ kind: "error", text: "Couldn't connect Google Calendar. Please try again." });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) {
      setView("list");
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

  async function handleCalendarDisconnect() {
    if (!userId || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ google_refresh_token: null, google_calendar_connected_at: null })
        .eq("id", userId);
      if (error) throw error;
      setNotice({ kind: "success", text: "Google Calendar disconnected." });
      onCalendarDisconnected?.();
      setView("list");
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "Could not disconnect. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    onClose();
  }

  if (view === "confirm-calendar-disconnect") {
    return (
      <Modal open={open} onClose={close} title="Settings" dismissable={!busy} backgroundLayer={settingsAmbientLayer}>
          <ConfirmPane
          title="Disconnect Google Calendar?"
          body="Carson will not be able to read or manage your calendar until you reconnect."
          confirmLabel="Disconnect"
          tone="strong"
          busy={busy}
          busyLabel="Disconnecting…"
          notice={notice?.kind === "error" ? notice.text : null}
          onCancel={() => {
            if (busy) return;
            setNotice(null);
            setView("list");
          }}
          onConfirm={() => void handleCalendarDisconnect()}
          />
      </Modal>
    );
  }

  if (view === "confirm-archive") {
    return (
      <Modal open={open} onClose={close} title="Settings" dismissable={!busy} backgroundLayer={settingsAmbientLayer}>
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
      <Modal open={open} onClose={close} title="Settings" dismissable={!busy} backgroundLayer={settingsAmbientLayer}>
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

  if (view === "delegation-rules") {
    return (
      <Modal open={open} onClose={close} title="Settings" backgroundLayer={settingsAmbientLayer}>
          <HouseholdDelegationRulesPanel onBack={() => setView("list")} />
      </Modal>
    );
  }

  if (view === "notification-devices") {
    return (
      <Modal open={open} onClose={close} title="Settings" backgroundLayer={settingsAmbientLayer}>
          <NotificationDevicesPanel userId={userId} onBack={() => setView("list")} />
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title="Settings" backgroundLayer={settingsAmbientLayer}>
        <SettingsList
        userId={userId}
        notice={notice?.kind === "success" ? notice.text : null}
        displayName={profileStore.displayName}
        weatherCity={profileStore.weatherCity}
        calendarRevoked={calendarRevoked ?? false}
        onCalendarReconnected={onCalendarReconnected}
        onClickDisconnectCalendar={() => {
          setNotice(null);
          setView("confirm-calendar-disconnect");
        }}
        onSaveDisplayName={async (name) => {
          if (!userId) return;
          await profileStore.save(userId, name);
        }}
        onSaveWeatherCity={async (city) => {
          await profileStore.saveWeatherCity(city);
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
        onClickDelegationRules={() => setView("delegation-rules")}
        onClickManageDevices={() => setView("notification-devices")}
        onClickPrivacy={() => {
          onClose();
          navigate("/privacy");
        }}
        onClickTerms={() => {
          onClose();
          navigate("/terms");
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
  weatherCity,
  calendarRevoked,
  onCalendarReconnected,
  onClickDisconnectCalendar,
  onSaveDisplayName,
  onSaveWeatherCity,
  onClickViewHistory,
  onClickArchive,
  onClickClear,
  onClickDelegationRules,
  onClickManageDevices,
  onClickPrivacy,
  onClickTerms,
  onClickDebug,
}: {
  userId: string | null;
  notice: string | null;
  displayName: string | null;
  weatherCity: string | null;
  calendarRevoked: boolean;
  onCalendarReconnected?: () => void;
  onClickDisconnectCalendar: () => void;
  onSaveDisplayName: (name: string) => Promise<void>;
  onSaveWeatherCity: (city: string) => Promise<void>;
  onClickViewHistory: () => void;
  onClickArchive: () => void;
  onClickClear: () => void;
  onClickDelegationRules: () => void;
  onClickManageDevices: () => void;
  onClickPrivacy: () => void;
  onClickTerms: () => void;
  onClickDebug: () => void;
}) {
  return (
    <div className="space-y-5">
      {notice && <AuthNotice kind="success">{notice}</AuthNotice>}

      <Group label="Account">
        <DisplayNameRow displayName={displayName} onSave={onSaveDisplayName} />
        <WeatherCityRow weatherCity={weatherCity} onSave={onSaveWeatherCity} />
      </Group>

      <Group label="History">
        <ActionRow label="View history" onClick={onClickViewHistory} />
        <ActionRow label="Archive history" onClick={onClickArchive} />
      </Group>

      <Group label="Workspace">
        <ActionRow label="Clear history" onClick={onClickClear} />
      </Group>

      <Group label="Integrations">
        <GoogleCalendarRow
          userId={userId}
          revoked={calendarRevoked}
          onReconnected={onCalendarReconnected}
          onDisconnect={onClickDisconnectCalendar}
        />
      </Group>

      <Group label="Notifications">
        <ReminderNotificationsRow userId={userId} onClickManageDevices={onClickManageDevices} />
      </Group>

      <Group label="Carson">
        <button
          type="button"
          onClick={onClickDelegationRules}
          className="flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left transition hover:bg-cream/60 last:border-b-0"
        >
          <span className="min-w-0">
            <span className="block text-base text-ink">Household Delegation Rules</span>
            <span className="block text-xs text-text-soft">Global rules Carson follows when delegating.</span>
          </span>
          <span aria-hidden className="text-text-muted">›</span>
        </button>
      </Group>

      <Group label="Legal">
        <ActionRow label="Privacy Policy" onClick={onClickPrivacy} />
        <ActionRow label="Terms of Service" onClick={onClickTerms} />
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
      <div className="border-b border-border px-4 py-3 last:border-b-0">
        <p className="mb-1.5 text-xs text-text-soft">Your name</p>
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
          className="mb-2 w-full rounded-xl border border-border bg-surface-subtle px-3 py-2 text-base text-ink placeholder:text-text-muted focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20 disabled:opacity-50"
        />
        {error && <p className="mb-2 text-xs text-danger">{error}</p>}
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
            className="rounded-full border border-border bg-surface-subtle px-4 py-1.5 text-xs font-medium text-ink transition hover:bg-surface disabled:opacity-50"
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
      className="flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left transition hover:bg-cream/60 last:border-b-0"
    >
      <span className="min-w-0">
        <span className="block text-base text-ink">Your name</span>
        <span className="block text-xs text-text-soft">
          {saved ? "Saved ✓" : (displayName ?? "Not set")}
        </span>
      </span>
      <span aria-hidden className="text-text-muted">
        ›
      </span>
    </button>
  );
}

function WeatherCityRow({
  weatherCity,
  onSave,
}: {
  weatherCity: string | null;
  onSave: (city: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setValue(weatherCity ?? "");
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
      <div className="border-b border-border px-4 py-3 last:border-b-0">
        <p className="mb-1.5 text-xs text-text-soft">Weather city</p>
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
          placeholder="e.g. Dubai, Fethiye, London"
          maxLength={80}
          className="mb-2 w-full rounded-xl border border-border bg-surface-subtle px-3 py-2 text-base text-ink placeholder:text-text-muted focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20 disabled:opacity-50"
        />
        {error && <p className="mb-2 text-xs text-danger">{error}</p>}
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
            className="rounded-full border border-border bg-surface-subtle px-4 py-1.5 text-xs font-medium text-ink transition hover:bg-surface disabled:opacity-50"
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
      className="flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left transition hover:bg-cream/60 last:border-b-0"
    >
      <span className="min-w-0">
        <span className="block text-base text-ink">Weather city</span>
        <span className="block text-xs text-text-soft">
          {saved ? "Saved ✓" : (weatherCity ?? "Not set — tap to add")}
        </span>
      </span>
      <span aria-hidden className="text-text-muted">
        ›
      </span>
    </button>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-[10px] font-medium uppercase tracking-wide text-text-soft">
        {label}
      </h3>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface/90 shadow-sm">
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
      className="flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left transition hover:bg-cream/60 last:border-b-0"
    >
      <span className="text-base text-ink">{label}</span>
      <span aria-hidden className="text-text-muted">
        ›
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------

function ReminderNotificationsRow({
  userId,
  onClickManageDevices,
}: {
  userId: string | null;
  onClickManageDevices: () => void;
}) {
  const [status, setStatus] = useState<PushNotificationStatus>(() =>
    checkPushSupport().supported ? "idle" : "unsupported",
  );
  const [busy, setBusy] = useState(false);
  const [busyKind, setBusyKind] = useState<"enabling" | "refreshing" | "disabling">("enabling");
  const [showInstallGuidance, setShowInstallGuidance] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
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

    void loadStatus();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function handleEnable() {
    if (!userId || busy) return;
    setBusyKind("enabling");
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

  async function handleRefresh() {
    if (!userId || busy) return;
    setBusyKind("refreshing");
    setBusy(true);
    try {
      const nextStatus = await refreshPushSubscription(userId);
      setStatus(nextStatus);
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    if (!userId || busy) return;
    setBusyKind("disabling");
    setBusy(true);
    try {
      const nextStatus = await disableReminderNotifications(userId);
      setStatus(nextStatus);
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }

  const isEnabled = status === "enabled";
  const isUnsupported = status === "unsupported";
  // iOS only exposes the Push API to an installed, standalone app — a plain
  // browser tab can never enable notifications no matter what this button
  // does. Showing the normal disabled toggle here just looks broken; show
  // install guidance instead. Any other "unsupported" reason (non-iOS
  // browser lacking push) keeps the existing generic row untouched.
  const showIOSInstallPrompt = isUnsupported && needsIOSInstallGuidance();

  const statusText = getReminderStatusText(status, busy, busyKind);
  // Only truly non-actionable states are unsupported and no-user.
  const disabledMain = busy || isUnsupported || !userId;

  return (
    <div className="border-b border-border last:border-b-0">
      {showIOSInstallPrompt ? (
        <div className="px-4 py-3">
          <span className="block text-base text-ink">Push notifications</span>
          <p className="mt-1 text-xs text-text-soft">
            Install Ra7etBal to enable notifications on your iPhone or iPad.
          </p>
          <button
            type="button"
            onClick={() => setShowInstallGuidance(true)}
            className="mt-2 text-[11px] text-text-soft underline underline-offset-2 transition hover:text-ink"
          >
            How to install Ra7etBal
          </button>
        </div>
      ) : (
        /* Main row */
        <button
          type="button"
          onClick={() => void (isEnabled ? handleRefresh() : handleEnable())}
          disabled={disabledMain}
          aria-busy={busy}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-cream/60 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className="min-w-0">
            <span className="block text-base text-ink">Push notifications</span>
            <span className="block text-xs text-text-soft">{statusText}</span>
          </span>
          <span
            aria-hidden
            className={
              "h-3 w-3 shrink-0 rounded-full " +
              (isEnabled
                ? "bg-gold"
                : status === "denied" || status === "error"
                  ? "bg-danger"
                  : "bg-text-muted")
            }
          />
        </button>
      )}

      {/* Disable link — only shown when enabled and not busy */}
      {isEnabled && !busy && (
        <div className="px-4 pb-2.5">
          <button
            type="button"
            onClick={() => void handleDisable()}
            className="text-[11px] text-text-soft underline underline-offset-2 transition hover:text-ink"
          >
            Disable notifications
          </button>
        </div>
      )}

      {/* Manage notification devices — visible whenever there's a signed-in
          owner, regardless of this device's own toggle state, since the
          list can include other installations. */}
      {userId && (
        <div className="px-4 pb-2.5">
          <button
            type="button"
            onClick={onClickManageDevices}
            className="text-[11px] text-text-soft underline underline-offset-2 transition hover:text-ink"
          >
            Manage notification devices
          </button>
        </div>
      )}

      {/* iOS Settings hint when permission is denied */}
      {status === "denied" && (
        <p className="px-4 pb-2.5 text-[11px] leading-snug text-text-muted">
          Open iOS Settings → Safari (or Ra7etBal app) → Notifications, then enable and return here to subscribe.
        </p>
      )}

      <Modal
        open={showInstallGuidance}
        onClose={() => setShowInstallGuidance(false)}
        title="Install Ra7etBal on iPhone or iPad"
      >
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink">
          <li>Tap the Share button in Safari.</li>
          <li>Choose "Add to Home Screen."</li>
          <li>Open the installed Ra7etBal app.</li>
          <li>Return to Settings and tap "Enable Notifications."</li>
        </ol>
      </Modal>
    </div>
  );
}

function getReminderStatusText(
  status: PushNotificationStatus,
  busy: boolean,
  busyKind: "enabling" | "refreshing" | "disabling",
): string {
  if (busy) {
    if (busyKind === "refreshing") return "Refreshing subscription…";
    if (busyKind === "disabling") return "Disabling…";
    return "Enabling…";
  }

  switch (status) {
    case "enabled":
      return "Enabled — receive reminders, confirmations, follow-ups, and updates";
    case "denied":
      return "Disabled — tap to enable notifications";
    case "unsupported":
      return "Not supported on this device";
    case "error":
      return "Something went wrong — tap to retry";
    case "idle":
      return "Disabled — tap to enable notifications";
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

/**
 * Shows Google Calendar connection status and a connect/reconnect button.
 * Checks profiles.google_calendar_connected_at to determine current state.
 * Connect action redirects to /api/google-calendar (server-side OAuth flow).
 *
 * revoked — when true (token revoked on Google's side), overrides the normal
 * "Connected" display with a warning so the user knows they need to reconnect.
 */
function GoogleCalendarRow({
  userId,
  revoked = false,
  onReconnected,
  onDisconnect,
}: {
  userId: string | null;
  revoked?: boolean;
  onReconnected?: () => void;
  onDisconnect?: () => void;
}) {
  const [connected, setConnected] = useState<boolean | null>(null); // null = loading

  useEffect(() => {
    if (!userId) { setConnected(false); return; }
    let cancelled = false;
    Promise.resolve(
      supabase
        .from("profiles")
        .select("google_calendar_connected_at")
        .eq("id", userId)
        .maybeSingle(),
    )
      .then(({ data }) => {
        if (!cancelled) setConnected(!!data?.google_calendar_connected_at);
      })
      .catch(() => { if (!cancelled) setConnected(false); });
    return () => { cancelled = true; };
  }, [userId]);

  const [connectError, setConnectError] = useState(false);

  async function handleConnect() {
    if (!userId) return;
    setConnectError(false);
    // OAuth initiation now requires the caller's own verified session --
    // the server derives identity from this JWT, never from a client-
    // supplied id (Carson Engineering Hardening Project, Remediation 3).
    // The actual OAuth hop still needs a full-page browser navigation, so
    // this is a two-step flow: authenticate first, then navigate to the
    // server-issued, CSRF-state-bound consent URL.
    const { data: sessionData } = await supabase.auth.getSession();
    const jwt = sessionData?.session?.access_token;
    if (!jwt) {
      setConnectError(true);
      return;
    }
    try {
      const res = await fetch("/api/google-calendar?action=init", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.redirectUrl) {
        setConnectError(true);
        return;
      }
      onReconnected?.();
      // Full page redirect — OAuth flow requires browser navigation.
      window.location.href = body.redirectUrl;
    } catch {
      setConnectError(true);
    }
  }

  const isRevoked = revoked && connected !== false;

  const statusText = connectError
    ? "Something went wrong — tap to retry"
    : connected === null
      ? "Checking…"
      : isRevoked
        ? "Disconnected — reconnect to restore calendar access"
        : connected
          ? "Connected — tap to reconnect"
          : "Not connected";

  const dotColor =
    connected === null
      ? "bg-text-muted"
      : isRevoked
        ? "bg-danger"
        : connected
          ? "bg-gold"
          : "bg-text-muted";

  const statusClass = isRevoked ? "text-danger" : "text-text-soft";

  // Show the disconnect link when calendar is connected or in a revoked-but-was-connected state.
  const showDisconnect = onDisconnect && (connected === true || isRevoked);

  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0">
      <button
        type="button"
        onClick={handleConnect}
        disabled={!userId || connected === null}
        className="flex w-full items-center justify-between gap-3 text-left transition disabled:cursor-default"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="block text-base text-ink">Google Calendar</span>
          </span>
          <span className={`block text-xs ${statusClass}`}>{statusText}</span>
        </span>
        <span aria-hidden className={`h-3 w-3 shrink-0 rounded-full ${dotColor}`} />
      </button>
      {showDisconnect && (
        <button
          type="button"
          onClick={onDisconnect}
          className="mt-1.5 text-[11px] text-text-soft underline underline-offset-2 transition hover:text-ink"
        >
          Disconnect Google Calendar
        </button>
      )}
      <p className="mt-1 text-[11px] leading-snug text-text-muted">
        Connect to let Carson read and manage your Google Calendar.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function HouseholdDelegationRulesPanel({ onBack }: { onBack: () => void }) {
  const { rules: savedRules, status, error, load, save } = useHouseholdRulesStore();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  useEffect(() => {
    if (status === "ready") setText(savedRules);
  }, [status, savedRules]);

  async function handleSave() {
    if (busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    try {
      await save(text);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Back nav */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-text-soft transition hover:text-ink"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Settings
      </button>

      {/* Header */}
      <div>
        <h3 className="text-base font-semibold text-ink">Household Delegation Rules</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-text-soft">
          Global rules Carson follows when helping you delegate. Applies to all people.
        </p>
      </div>

      {error && <AuthNotice kind="error">{error}</AuthNotice>}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"e.g.\n• Grace manages all household staff — always loop her in.\n• Never assign financial tasks to staff without my approval.\n• Loulya's schedule always takes priority."}
        rows={8}
        disabled={status === "loading" || saving}
        className="w-full resize-none rounded-xl border border-border bg-surface-subtle px-4 py-3 text-sm text-ink placeholder:text-text-muted outline-none focus:border-gold focus:ring-2 focus:ring-gold/20 disabled:opacity-50"
      />

      <div className="flex items-center justify-between gap-3">
        {saved && (
          <span className="text-xs font-medium text-gold">Saved ✓</span>
        )}
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={status === "loading" || saving || text === savedRules}
            className="inline-flex items-center gap-2 rounded-full bg-sage px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving && <Spinner size={12} />}
            {saving ? "Saving…" : "Save rules"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Push Subscription Installation Management / Orphan Resolution — owner-
 * visible list of currently-enabled push subscriptions with a manual
 * remove action. Deliberately never auto-detects or auto-removes anything:
 * no age/inactivity heuristic exists here or anywhere in this feature. See
 * "no confirmed delivery yet" copy below — this is evidence, not a
 * dead/alive verdict; a device can be perfectly live and simply never have
 * had a reminder sent to it.
 */
function NotificationDevicesPanel({
  userId,
  onBack,
}: {
  userId: string | null;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [devices, setDevices] = useState<PushSubscriptionDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Read-only — never mints a fresh id just for viewing this panel. A row
  // is only ever badged "This device" when this is non-null AND matches
  // that row's own installation_id exactly.
  const currentInstallationId = useMemo(() => getStoredInstallationId(), []);

  async function load() {
    if (!userId) return;
    setStatus("loading");
    setError(null);
    try {
      const list = await listPushSubscriptionDevices(userId);
      setDevices(list);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your notification devices.");
      setStatus("error");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function handleRemove(deviceId: string) {
    if (!userId || removingId) return;
    setRemoveError(null);
    setRemovingId(deviceId);
    try {
      await removePushSubscriptionDevice(userId, deviceId);
      setDevices((prev) => prev.filter((d) => d.id !== deviceId));
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Could not remove this device. Please try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Back nav */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-text-soft transition hover:text-ink"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Settings
      </button>

      {/* Header */}
      <div>
        <h3 className="text-base font-semibold text-ink">Notification devices</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-text-soft">
          Every device currently set up to receive your reminders and updates. Remove any you no longer use. "No confirmed delivery yet" doesn't mean a device is broken — it may just not have received a notification yet.
        </p>
      </div>

      {error && <AuthNotice kind="error">{error}</AuthNotice>}
      {removeError && <AuthNotice kind="error">{removeError}</AuthNotice>}

      {status === "loading" && (
        <div className="flex items-center justify-center py-8">
          <Spinner size={20} />
        </div>
      )}

      {status === "ready" && devices.length === 0 && (
        <p className="py-6 text-center text-sm text-text-soft">No devices currently receive notifications.</p>
      )}

      {status === "ready" && devices.length > 0 && (
        <ul className="space-y-2">
          {devices.map((device) => {
            const isThisDevice = isCurrentDeviceRow(device, currentInstallationId);
            return (
            <li
              key={device.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface-subtle px-4 py-3"
            >
              <div className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  {device.platform || "Unknown device"}
                  {isThisDevice && (
                    <span className="shrink-0 rounded-full border border-gold/35 bg-gold/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold-soft">
                      This device
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-text-soft">
                  {device.userAgent || "No device details available"}
                </span>
                <span className="mt-1 block text-[11px] text-text-muted">
                  Added {formatDeviceDate(device.createdAt)}
                  {device.lastConfirmedDeliveredAt
                    ? ` · Last confirmed delivery ${formatDeviceDate(device.lastConfirmedDeliveredAt)}`
                    : " · No confirmed delivery yet"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleRemove(device.id)}
                disabled={removingId === device.id}
                className="shrink-0 text-[11px] font-medium text-danger underline underline-offset-2 transition hover:text-danger/80 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {removingId === device.id ? "Removing…" : "Remove"}
              </button>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatDeviceDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
          className="rounded-full border border-border bg-surface-subtle px-5 py-2.5 text-sm font-medium text-ink shadow-sm transition hover:bg-surface disabled:opacity-50"
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
