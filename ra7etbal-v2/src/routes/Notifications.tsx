import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { selectUnreadNotificationCount, useNotificationsStore } from "../stores/notifications";
import type { OwnerNotification } from "../types/notification";
import { markEveryOwnerNotificationRead, openOwnerNotification } from "../lib/notification-actions";

export default function Notifications() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { status, items, error, loadFor, markRead, markAllRead, dismiss } = useNotificationsStore();
  const unreadCount = useNotificationsStore(selectUnreadNotificationCount);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.id) void loadFor(user.id);
  }, [loadFor, user?.id]);

  async function openNotification(item: OwnerNotification) {
    try {
      setActionError(null);
      await openOwnerNotification(item, { markRead, navigate });
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "Could not mark this notification read.");
    }
  }

  async function markAll() {
    try {
      setActionError(null);
      await markEveryOwnerNotificationRead(markAllRead);
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "Could not mark notifications read.");
    }
  }

  async function dismissNotification(id: string) {
    try {
      setActionError(null);
      await dismiss(id);
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "Could not dismiss this notification.");
    }
  }

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Notifications</h1>
          <p className="text-sm text-text-soft">Important updates from Carson, kept here for you.</p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void markAll()}
            className="shrink-0 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-sm"
          >
            Mark all read
          </button>
        )}
      </header>

      {error && (
        <AuthNotice kind="error">
          {error} <button type="button" className="underline" onClick={() => user?.id && void loadFor(user.id, { force: true })}>Try again</button>
        </AuthNotice>
      )}

      {actionError && (
        <AuthNotice kind="error">
          {actionError} <button type="button" className="underline" onClick={() => setActionError(null)}>Dismiss</button>
        </AuthNotice>
      )}

      {status === "loading" && items.length === 0 && (
        <div className="flex justify-center py-12 text-ink/60"><Spinner size={20} label="Loading notifications" /></div>
      )}

      {status === "ready" && items.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-surface-subtle/80 p-8 text-center">
          <p className="font-medium text-ink">Nothing new.</p>
          <p className="mt-1 text-sm text-text-soft">Important updates will stay here when they arrive.</p>
        </div>
      )}

      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id}>
            <div className={`relative w-full rounded-2xl border p-4 shadow-sm ${item.read_at ? "border-border bg-surface/80" : "border-border-strong bg-surface"}`}>
            <button type="button" onClick={() => void openNotification(item)} className="w-full pr-10 text-left transition active:scale-[0.99]">
              <div className="flex items-start gap-3">
                {!item.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-sage" aria-label="Unread" />}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">{item.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-text-soft">{item.body}</p>
                  <time className="mt-2 block text-xs text-text-muted" dateTime={item.occurred_at}>{formatTimestamp(item.occurred_at)}</time>
                </div>
              </div>
            </button>
            <button type="button" aria-label={`Dismiss ${item.title}`} onClick={() => void dismissNotification(item.id)} className="absolute right-3 top-3 rounded-full px-2 py-1 text-lg leading-none text-ink/45 hover:bg-sage/10 hover:text-ink">×</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
