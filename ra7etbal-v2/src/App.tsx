import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import Auth from "./routes/Auth";
import Debug from "./routes/Debug";
import Reset from "./routes/Reset";
import Spinner from "./components/Spinner";
import { useAuth } from "./hooks/useAuth";
import { signOut } from "./lib/session";

function Placeholder({ title }: { title: string }) {
  return (
    <section className="rounded-2xl border border-sage/30 bg-white/70 p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <p className="mt-2 text-sm text-ink/70">
        Placeholder — implemented in a later step.
      </p>
    </section>
  );
}

const navItems = [
  { to: "/", label: "Home", end: true },
  { to: "/auth", label: "Auth" },
  { to: "/reset", label: "Reset" },
  { to: "/review", label: "Review" },
  { to: "/people", label: "People" },
  { to: "/confirm", label: "Confirm" },
  { to: "/debug", label: "Debug" },
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
 * users to /reset (built in Step 4). While loading, render a spinner — the
 * INITIAL_SESSION event resolves within a couple hundred ms.
 */
function AuthRoute() {
  const { status } = useAuth();
  if (status === "loading") return <LoadingPane />;
  if (status === "signed_in") return <Navigate to="/" replace />;
  if (status === "recovery") return <Navigate to="/reset" replace />;
  return <Auth />;
}

/**
 * Route-level guard for /reset. Only renders the Reset screen when the auth
 * machine reports `recovery`. Everything else gets redirected — signed-in
 * users go home, signed-out users go to /auth. This is the architectural
 * fix for the v1 bug where Review/refresh could send the user back into
 * Reset: recovery is a Zustand flag, not a URL hash or DOM check, and it
 * only ever clears via `clearRecovery()` after a successful updateUser.
 */
function ResetRoute() {
  const { status } = useAuth();
  if (status === "loading") return <LoadingPane />;
  if (status === "recovery") return <Reset />;
  if (status === "signed_in") return <Navigate to="/" replace />;
  return <Navigate to="/auth" replace />;
}

/**
 * Wrap any route that requires an authenticated session. Signed-out users
 * are sent to /auth; recovery-mode users are sent to /reset.
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <LoadingPane />;
  if (status === "signed_out") return <Navigate to="/auth" replace />;
  if (status === "recovery") return <Navigate to="/reset" replace />;
  return <>{children}</>;
}

function HeaderUserStrip() {
  const { status, user } = useAuth();
  if (status !== "signed_in" || !user) return null;
  return (
    <div className="ml-auto flex items-center gap-3 text-xs text-ink/70">
      <span className="hidden sm:inline">{user.email}</span>
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
  );
}

export default function App() {
  return (
    <div className="min-h-dvh bg-cream text-ink">
      <header className="mx-auto flex max-w-3xl items-center gap-3 px-5 pt-6">
        <span aria-hidden className="text-2xl">🌿</span>
        <div className="flex flex-col leading-tight">
          <span className="font-semibold">Ra7etBal · راحة بال</span>
          <span className="text-xs text-ink/60">v2 · Step 3</span>
        </div>
        <HeaderUserStrip />
      </header>

      <nav className="mx-auto mt-4 flex max-w-3xl flex-wrap gap-2 px-5">
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

      <main className="mx-auto mt-6 max-w-3xl px-5 pb-24">
        <Routes>
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Placeholder title="Home / Clear My Head" />
              </ProtectedRoute>
            }
          />
          <Route path="/auth" element={<AuthRoute />} />
          <Route path="/reset" element={<ResetRoute />} />
          <Route path="/review" element={<Placeholder title="Review extracted items" />} />
          <Route path="/people" element={<Placeholder title="People" />} />
          <Route path="/confirm" element={<Placeholder title="Confirm task" />} />
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
