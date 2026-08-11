import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import AuthNotice from "../components/auth/AuthNotice";
import Spinner from "../components/Spinner";
import { useAuth } from "../hooks/useAuth";
import { selectUnreadNotificationCount, useNotificationsStore } from "../stores/notifications";
import type { OwnerNotification } from "../types/notification";

export default function Notifications() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { status, items, error, loadFor, markRead, markAllRead } = useNotificationsStore();
  const unreadCount = useNotificationsStore(selectUnreadNotificationCount);

  useEffect(() => {
    if (user?.id) void loadFor(user.id);
  }, [loadFor, user?.id]);

  async function openNotification(item: OwnerNotification) {
    try {
      await markRead(item.id);
    } finally {
      if (isSafeInternalRoute(item.target_url)) navigate(item.target_url!);
    }
  }

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Notifications</h1>
          <p className="text-sm text-ink/60">Important updates from Carson, kept here for you.</p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void markAllRead()}
            className="shrink-0 rounded-full border border-sage/25 bg-white px-3 py-1.5 text-xs font-medium text-ink shadow-sm"
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

      {status === "loading" && items.length === 0 && (
        <div className="flex justify-center py-12 text-ink/60"><Spinner size={20} label="Loading notifications" /></div>
      )}

      {status === "ready" && items.length === 0 && (
        <div className="rounded-2xl border border-dashed border-sage/35 bg-white/60 p-8 text-center">
          <p className="font-medium text-ink">Nothing new.</p>
          <p className="mt-1 text-sm text-ink/60">Important updates will stay here when they arrive.</p>
        </div>
      )}

      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => void openNotification(item)}
              className={`w-full rounded-2xl border p-4 text-left shadow-sm transition active:scale-[0.99] ${item.read_at ? "border-sage/15 bg-white/65" : "border-sage/35 bg-white"}`}
            >
              <div className="flex items-start gap-3">
                {!item.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-sage" aria-label="Unread" />}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">{item.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink/70">{item.body}</p>
                  <time className="mt-2 block text-xs text-ink/45" dateTime={item.occurred_at}>{formatTimestamp(item.occurred_at)}</time>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function isSafeInternalRoute(value: string | null): boolean {
  return Boolean(value && /^\/(notifications|updates|history|people)(?:$|[/?#])/.test(value));
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
