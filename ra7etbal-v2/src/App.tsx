import { useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import Actions from "./routes/Actions";
import Auth from "./routes/Auth";
import Confirm from "./routes/Confirm";
import Debug from "./routes/Debug";
import FollowUps from "./routes/FollowUps";
import History from "./routes/History";
import Home from "./routes/Home";
import Messages from "./routes/Messages";
import Notes from "./routes/Notes";
import People from "./routes/People";
import Reset from "./routes/Reset";
import Review from "./routes/Review";
import ConfirmationNotices from "./components/home/ConfirmationNotices";
import SettingsModal from "./components/settings/SettingsModal";
import Spinner from "./components/Spinner";
import { useAuth } from "./hooks/useAuth";
import { signOut } from "./lib/session";
import { useTasksStore } from "./stores/tasks";

/**
 * Nav items shown when signed in. Auth/Reset/Confirm/Debug are reachable
 * by URL but kept off the chip nav (Auth & Reset are state-driven, Confirm
 * is recipient-facing via shared link, Debug is for verification only).
 */
const navItems: { to: string; label: string; end?: boolean }[] = [
  { to: "/", label: "Home", end: true },
  { to: "/actions", label: "Actions" },
  { to: "/follow-ups", label: "Follow-ups" },
  { to: "/messages", label: "Messages" },
  { to: "/notes", label: "Notes" },
  { to: "/people", label: "People" },
];

function LoadingPane() {
  return (
    <div className="flex items-center justify-center py-12 text-ink/60">
      <Spinner size={20} label="Loading" />
    </div>
  );
}

/**
 * Route-level guard for /auth. Sends signed-in users home and recovery-mode
 * users to /reset. While loading, render a spinner — INITIAL_SESSION resolves
 * within a couple hundred ms.
 */
function AuthRoute() {
  const { status } = useAuth();
  if (status === "loading") return <LoadingPane />;
  if (status === "signed_in") return <Navigate to="/" replace />;
  if (status === "recovery") return <Navigate to="/reset" replace />;
  return <Auth />;
}

/** Recovery-only route. The recovery flag is a Zustand state, not a URL hash. */
function ResetRoute() {
  const { status } = useAuth();
  if (status === "loading") return <LoadingPane />;
  if (status === "recovery") return <Reset />;
  if (status === "signed_in") return <Navigate to="/" replace />;
  return <Navigate to="/auth" replace />;
}

/** Wrap any route that needs an authenticated session. */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <LoadingPane />;
  if (status === "signed_out") return <Navigate to="/auth" replace />;
  if (status === "recovery") return <Navigate to="/reset" replace />;
  return <>{children}</>;
}

function HeaderUserStrip() {
  const { status, user } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (status !== "signed_in" || !user) return null;
  return (
    <>
      <div className="ml-auto flex items-center gap-2 text-xs text-ink/70">
        <span className="hidden sm:inline">{user.email}</span>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-sage/40 bg-white text-ink shadow-sm transition hover:bg-cream"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.51 7.51 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.14.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.49.39 1.04.7 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7.51 7.51 0 0 0 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => {
            void signOut();
          }}
          className="rounded-full border border-sage/40 bg-white px-3 py-1 font-medium text-ink shadow-sm transition hover:bg-cream"
        >
          Sign out
        </button>
      </div>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        userId={user.id}
      />
    </>
  );
}

/**
 * Nav is hidden on the recipient-facing confirmation page so the link feels
 * like a single-purpose action surface, not the host's app.
 */
function ChipNav() {
  const { status } = useAuth();
  if (status !== "signed_in") return null;
  return (
    <nav className="mx-auto mt-2 flex max-w-3xl flex-wrap gap-2 px-5">
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            [
              "rounded-full border px-3 py-1 text-sm transition",
              isActive
                ? "border-sage bg-sage text-white"
                : "border-sage/30 bg-white/60 text-ink hover:bg-white",
            ].join(" ")
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * App-level tasks force-load so the global ConfirmationNotices banner has
 * fresh data the moment a signed-in user enters the app — regardless of
 * which route they land on. Fires once per user per session; individual
 * list screens (Actions / Follow-ups / Messages) still force-refresh on
 * their own mounts via useTaskList, so this is just the floor.
 */
function useGlobalTasksRefresh() {
  const { status, user } = useAuth();
  const firedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "signed_in" || !user?.id) return;
    if (firedRef.current === user.id) return;
    firedRef.current = user.id;
    void useTasksStore.getState().loadFor(user.id, { force: true });
  }, [status, user?.id]);
}

export default function App() {
  useGlobalTasksRefresh();
  return (
    <div className="min-h-dvh bg-cream text-ink">
      <header className="mx-auto flex max-w-3xl items-center gap-3 px-5 pt-6">
        <span aria-hidden className="text-2xl">🌿</span>
        <div className="flex flex-col leading-tight">
          <span className="font-semibold">Ra7etBal · راحة بال</span>
          <span className="text-xs text-ink/60">v2</span>
        </div>
        <HeaderUserStrip />
      </header>

      <ChipNav />

      <main className="mx-auto mt-3 max-w-3xl px-5 pb-24">
        {/* Owner confirmation banner — global. Self-gates by auth status
            and by pathname (hidden on /confirm). Rendering above Routes
            keeps it visible across Home / Actions / Follow-ups / Messages
            / People / History. */}
        <ConfirmationNotices />

        <Routes>
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />
          <Route path="/auth" element={<AuthRoute />} />
          <Route path="/reset" element={<ResetRoute />} />
          <Route
            path="/review"
            element={
              <ProtectedRoute>
                <Review />
              </ProtectedRoute>
            }
          />
          <Route
            path="/actions"
            element={
              <ProtectedRoute>
                <Actions />
              </ProtectedRoute>
            }
          />
          <Route
            path="/follow-ups"
            element={
              <ProtectedRoute>
                <FollowUps />
              </ProtectedRoute>
            }
          />
          <Route
            path="/messages"
            element={
              <ProtectedRoute>
                <Messages />
              </ProtectedRoute>
            }
          />
          <Route
            path="/notes"
            element={
              <ProtectedRoute>
                <Notes />
              </ProtectedRoute>
            }
          />
          <Route
            path="/people"
            element={
              <ProtectedRoute>
                <People />
              </ProtectedRoute>
            }
          />
          <Route
            path="/history"
            element={
              <ProtectedRoute>
                <History />
              </ProtectedRoute>
            }
          />
          <Route path="/confirm" element={<Confirm />} />
          <Route path="/debug" element={<Debug />} />
          <Route
            path="*"
            element={
              <section className="rounded-2xl border border-sage/30 bg-white/70 p-6">
                <h2 className="text-xl font-semibold">Not found</h2>
                <p className="mt-2 text-sm text-ink/70">
                  This route does not exist yet.
                </p>
              </section>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
