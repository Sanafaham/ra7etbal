import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabase";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import Actions from "./routes/Actions";
import Active from "./routes/Active";
import Updates from "./routes/Updates";
import Auth from "./routes/Auth";
import Confirm from "./routes/Confirm";
import Debug from "./routes/Debug";
import FollowUps from "./routes/FollowUps";
import History from "./routes/History";
import Home from "./routes/Home";
import Inbox from "./routes/Inbox";
import Messages from "./routes/Messages";
import Notes from "./routes/Notes";
import People from "./routes/People";
import Landing from "./routes/Landing";
import Reset from "./routes/Reset";
import Privacy from "./routes/Privacy";
import Terms from "./routes/Terms";
import Review from "./routes/Review";
import BottomNav from "./components/nav/BottomNav";
import MoreSheet from "./components/nav/MoreSheet";
import CarsonLivePill from "./components/carson/CarsonLivePill";
import ConfirmationNotices from "./components/home/ConfirmationNotices";
import ElevenLabsAgentWidget from "./components/home/ElevenLabsAgentWidget";
import SettingsModal from "./components/settings/SettingsModal";
import Spinner from "./components/Spinner";
import { useAuth } from "./hooks/useAuth";
import { buildCarsonContext } from "./lib/carson-context";
import { fetchCalendarEvents, type CalendarEvent } from "./lib/calendar";
import { formatNotesForContext, loadRecentNotes } from "./lib/carson-notes";
import { buildMorningBriefSpoken } from "./lib/morning-brief";
import { buildNightSweepSpoken, EVENING_HOUR } from "./lib/night-sweep";
import { useCarsonStore } from "./stores/carson";
import { useHouseholdRulesStore } from "./stores/household-rules";
import { usePeopleStore } from "./stores/people";
import { useProfileStore } from "./stores/profile";
import { useTasksStore } from "./stores/tasks";

function LoadingPane() {
  return (
    <div className="flex items-center justify-center py-12 text-ink/60">
      <Spinner size={20} label="Loading" />
    </div>
  );
}

function AuthRoute() {
  const { status } = useAuth();
  if (status === "loading") return <LoadingPane />;
  if (status === "signed_in") return <Navigate to="/" replace />;
  if (status === "recovery") return <Navigate to="/reset" replace />;
  return <Auth />;
}

function ResetRoute() {
  const { status } = useAuth();
  const location = useLocation();
  // Whether verifyOtp has settled (resolved or rejected).
  const [exchangeAttempted, setExchangeAttempted] = useState(false);
  const [exchangeTimedOut, setExchangeTimedOut] = useState(false);

  // --- token_hash flow (new) ---
  // The Recovery email template now links directly to our app:
  //   https://www.ra7etbal.com/reset?token_hash=<hash>&type=recovery
  // Our JS calls verifyOtp() so Gmail/Google prefetchers (which don't run JS)
  // can never consume the single-use token. No PKCE code-verifier required.
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const tokenHash = params.get("token_hash");
  const tokenType = params.get("type");
  const hasTokenHash = !!tokenHash && tokenType === "recovery";

  // --- legacy PKCE code path ---
  // Supabase SDK strips ?code= from the URL synchronously (before React mounts)
  // via history.replaceState, so this is usually false by the time we render.
  // Kept as a belt-and-suspenders guard in case timing differs.
  const hasPkceCode = location.search.includes("code=");

  useEffect(() => {
    if (!hasTokenHash) return;
    let cancelled = false;
    const t = window.setTimeout(() => setExchangeTimedOut(true), 10_000);
    supabase.auth
      .verifyOtp({ token_hash: tokenHash!, type: "recovery" })
      .finally(() => {
        if (!cancelled) {
          setExchangeAttempted(true);
          window.clearTimeout(t);
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [hasTokenHash, tokenHash]);

  // For the legacy PKCE path: if signed_out + code still in URL, wait up to
  // 10 s for the SDK's async exchange before ejecting to /auth.
  useEffect(() => {
    if (!hasPkceCode) return;
    const t = window.setTimeout(() => setExchangeTimedOut(true), 10_000);
    return () => window.clearTimeout(t);
  }, [hasPkceCode]);

  const waitingForExchange =
    (hasTokenHash && !exchangeAttempted && !exchangeTimedOut) ||
    (hasPkceCode && status === "signed_out" && !exchangeTimedOut);

  console.debug("[ResetRoute]", {
    status,
    hasTokenHash,
    hasPkceCode,
    exchangeAttempted,
    exchangeTimedOut,
    waitingForExchange,
    search: location.search,
  });

  if (status === "loading") return <LoadingPane />;
  if (waitingForExchange) return <LoadingPane />;
  if (status === "recovery") return <Reset />;
  if (status === "signed_in") return <Navigate to="/" replace />;
  return <Navigate to="/auth" replace />;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <LoadingPane />;
  if (status === "signed_out") return <Navigate to="/auth" replace />;
  if (status === "recovery") return <Navigate to="/reset" replace />;
  return <>{children}</>;
}

function HomeRoute() {
  const { status } = useAuth();
  if (status === "loading") return <LoadingPane />;
  if (status === "signed_out") return <Landing />;
  if (status === "recovery") return <Navigate to="/reset" replace />;
  return <Home />;
}

/**
 * App-level tasks force-load so the global ConfirmationNotices banner has
 * fresh data the moment a signed-in user enters the app.
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

/**
 * Persistent Carson widget — mounted once, lives in the Carson bottom sheet.
 * Session survives sheet open/close because this component is never unmounted.
 */
function PersistentCarsonWidget({
  onCallStatusChange,
  onRequestClose,
  onCalendarRevokedChange,
  calendarDisconnectCount,
}: {
  onCallStatusChange: (status: "idle" | "connecting" | "connected" | "error") => void;
  onRequestClose: () => void;
  onCalendarRevokedChange: (revoked: boolean) => void;
  /** Incremented by App each time the user disconnects Google Calendar.
   *  Widget watches this to clear stale calendar events. */
  calendarDisconnectCount: number;
}) {
  const { status, user } = useAuth();
  const userId = user?.id ?? null;

  const { tasks, loadTasks } = useTasksStore(
    useShallow((s) => ({ tasks: s.items, loadTasks: s.loadFor })),
  );
  const { people } = usePeopleStore(
    useShallow((s) => ({ people: s.items })),
  );
  const { displayName } = useProfileStore(
    useShallow((s) => ({ displayName: s.displayName })),
  );

  const { householdRules, loadHouseholdRules } = useHouseholdRulesStore(
    (s) => ({ householdRules: s.rules, loadHouseholdRules: s.load }),
  );

  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [planningCalendarEvents, setPlanningCalendarEvents] = useState<CalendarEvent[]>([]);
  /** True once the 30-day calendar fetch completed successfully (even if empty). */
  const [calendarFetched, setCalendarFetched] = useState(false);
  const [notesBlock, setNotesBlock] = useState("");

  // When calendarDisconnectCount increments, clear stale calendar events so
  // Carson does not see them in the next session after a disconnect.
  useEffect(() => {
    if (calendarDisconnectCount === 0) return;
    setCalendarEvents([]);
    setPlanningCalendarEvents([]);
    setCalendarFetched(false);
  }, [calendarDisconnectCount]);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!userId) return;
    fetchCalendarEvents("next_7_days")
      .then((result) => {
        if (result.connected) {
          setCalendarEvents(result.events);
          onCalendarRevokedChange(false);
        } else if (result.revoked) {
          onCalendarRevokedChange(true);
        }
      })
      .catch(() => {});
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!userId) { setNotesBlock(""); return; }
    loadRecentNotes(20)
      .then((notes) => setNotesBlock(formatNotesForContext(notes)))
      .catch(() => setNotesBlock(""));
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void loadHouseholdRules();
  }, [userId, loadHouseholdRules]);

  const elevenLabsBriefStateText = useMemo(
    () => buildCarsonContext({ tasks, people, email: user?.email, now, calendarEvents, notesBlock, householdRules }),
    [tasks, people, user?.email, now, calendarEvents, notesBlock, householdRules],
  );
  const isEvening = now.getHours() >= EVENING_HOUR;
  const spokenBrief = useMemo(
    () =>
      isEvening
        ? buildNightSweepSpoken(tasks, displayName, now)
        : buildMorningBriefSpoken(tasks, people, displayName, now, calendarEvents),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, people, displayName, now, calendarEvents, isEvening],
  );

  const handleBeforeCallStart = useCallback(async () => {
    if (userId) await loadTasks(userId, { force: true });

    let freshCalendarEvents = calendarEvents;
    try {
      const calResult = await fetchCalendarEvents("next_7_days");
      if (calResult.connected) {
        freshCalendarEvents = calResult.events;
        setCalendarEvents(calResult.events);
        onCalendarRevokedChange(false);
      } else if (calResult.revoked) {
        onCalendarRevokedChange(true);
      }
    } catch { /* keep existing */ }

    try {
      const planResult = await fetchCalendarEvents("next_30_days");
      if (planResult.connected) {
        setPlanningCalendarEvents(planResult.events);
        setCalendarFetched(true);
      }
    } catch { /* keep existing */ }

    const freshTasks = useTasksStore.getState().items;
    const freshNow = new Date();
    const freshNotesBlock = userId ? formatNotesForContext(await loadRecentNotes(20)) : "";
    setNotesBlock(freshNotesBlock);

    const freshHouseholdRules = useHouseholdRulesStore.getState().rules;

    return {
      briefStateText: buildCarsonContext({ tasks: freshTasks, people, email: user?.email, now: freshNow, calendarEvents: freshCalendarEvents, notesBlock: freshNotesBlock, householdRules: freshHouseholdRules }),
      spokenBrief:
        freshNow.getHours() >= EVENING_HOUR
          ? buildNightSweepSpoken(freshTasks, displayName, freshNow)
          : buildMorningBriefSpoken(freshTasks, people, displayName, freshNow, freshCalendarEvents),
    };
  }, [userId, loadTasks, calendarEvents, people, user?.email, displayName, onCalendarRevokedChange]);

  if (status !== "signed_in" || !userId) return null;

  return (
    <ElevenLabsAgentWidget
      inline
      briefStateText={elevenLabsBriefStateText}
      spokenBrief={spokenBrief}
      displayName={displayName}
      planningCalendarEvents={planningCalendarEvents}
      calendarFetched={calendarFetched}
      onBeforeCallStart={handleBeforeCallStart}
      onCallStatusChange={onCallStatusChange}
      onRequestClose={onRequestClose}
    />
  );
}

export default function App() {
  useGlobalTasksRefresh();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [calendarRevoked, setCalendarRevoked] = useState(false);
  const [calendarDisconnectCount, setCalendarDisconnectCount] = useState(0);
  const { status: authStatus, user } = useAuth();
  const { open: carsonOpen, setOpen: setCarsonOpen, callStatus: carsonCallStatus, setCallStatus: setCarsonCallStatus } = useCarsonStore();

  const showNav = useShowNavInner();

  return (
    <div className="min-h-dvh bg-cream text-ink">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="mx-auto flex max-w-3xl items-center justify-between px-5 pt-5" style={{ paddingTop: "max(20px, env(safe-area-inset-top))" }}>
        <div className="flex items-center gap-2 px-1 py-1">
          <span aria-hidden className="text-xl">🌿</span>
          <span className="font-semibold text-ink">راحة بال</span>
        </div>

        <button
          type="button"
          aria-label="More options"
          onClick={() => setMoreOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-sage/8 active:bg-sage/15"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </header>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className="mx-auto mt-3 max-w-3xl px-5" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 80px)" }}>
        <ConfirmationNotices />

        <Routes>
          <Route path="/" element={<HomeRoute />} />
          <Route path="/auth" element={<AuthRoute />} />
          <Route path="/reset" element={<ResetRoute />} />
          <Route path="/review" element={<ProtectedRoute><Review /></ProtectedRoute>} />
          <Route path="/updates" element={<ProtectedRoute><Updates /></ProtectedRoute>} />
          {/* Legacy redirects */}
          <Route path="/active" element={<ProtectedRoute><Active /></ProtectedRoute>} />
          <Route path="/inbox" element={<ProtectedRoute><Inbox /></ProtectedRoute>} />
          {/* Legacy routes — redirect to new structure */}
          <Route path="/actions" element={<ProtectedRoute><Actions /></ProtectedRoute>} />
          <Route path="/follow-ups" element={<ProtectedRoute><FollowUps /></ProtectedRoute>} />
          <Route path="/messages" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
          <Route path="/notes" element={<ProtectedRoute><Notes /></ProtectedRoute>} />
          <Route path="/people" element={<ProtectedRoute><People /></ProtectedRoute>} />
          <Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />
          <Route path="/routines" element={<Navigate to="/updates?tab=routines" replace />} />
          <Route path="/confirm" element={<Confirm />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/debug" element={<Debug />} />
          <Route
            path="*"
            element={
              <section className="rounded-2xl border border-sage/30 bg-white/70 p-6">
                <h2 className="text-xl font-semibold">Not found</h2>
                <p className="mt-2 text-sm text-ink/70">This route does not exist yet.</p>
              </section>
            }
          />
        </Routes>
      </main>

      {/* ── Bottom navigation ────────────────────────────────────────────── */}
      {showNav && <BottomNav />}

      {/* ── Carson live pill (session active, sheet is closed) ─────────── */}
      {showNav && carsonCallStatus === "connected" && !carsonOpen && (
        <CarsonLivePill />
      )}

      {/* ── Carson bottom sheet ──────────────────────────────────────────── */}
      {/* Always mounted so voice sessions survive sheet open/close.
          Half-sheet when idle, full-sheet when a session is active. */}
      <div
        className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-3xl bg-warm-white shadow-2xl"
        style={{
          top: carsonCallStatus === "idle" ? "48dvh" : "12dvh",
          transform: carsonOpen ? "translateY(0)" : "translateY(110%)",
          transition: "transform 0.3s cubic-bezier(0.32, 0.72, 0, 1), top 0.3s cubic-bezier(0.32, 0.72, 0, 1)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
        aria-hidden={!carsonOpen}
      >
        {/* Drag handle — tap anywhere on the bar to close */}
        <button
          type="button"
          onClick={() => setCarsonOpen(false)}
          aria-label="Close Carson"
          className="flex shrink-0 flex-col items-center pt-3 pb-1"
        >
          <div className="h-1 w-10 rounded-full bg-ink/15" />
        </button>

        {/* Header row */}
        <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-1">
          <div>
            <p className="text-sm font-semibold text-ink">Carson</p>
            <p className="text-[11px] text-ink/45">Your Chief of Staff</p>
          </div>
          <button
            type="button"
            onClick={() => setCarsonOpen(false)}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-ink/5 text-ink/50 transition hover:bg-ink/10"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Widget — centered when idle, natural flow when active */}
        <div
          className={
            "flex flex-1 overflow-y-auto px-5 pb-6 " +
            (carsonCallStatus === "idle" ? "flex-col items-center justify-center gap-3" : "flex-col")
          }
        >
          {carsonCallStatus === "idle" && (
            <p className="mb-1 text-center text-[13px] text-ink/40">
              Ask about your tasks, delegate to someone, or set a reminder.
            </p>
          )}
          <PersistentCarsonWidget
            onCallStatusChange={setCarsonCallStatus}
            onRequestClose={() => setCarsonOpen(false)}
            onCalendarRevokedChange={setCalendarRevoked}
            calendarDisconnectCount={calendarDisconnectCount}
          />
        </div>
      </div>

      {/* Backdrop for Carson sheet */}
      {carsonOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
          onClick={() => setCarsonOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── More sheet ───────────────────────────────────────────────────── */}
      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        onSettings={() => setSettingsOpen(true)}
      />

      {/* ── Settings modal ───────────────────────────────────────────────── */}
      {authStatus === "signed_in" && user && (
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          userId={user.id}
          calendarRevoked={calendarRevoked}
          onCalendarReconnected={() => setCalendarRevoked(false)}
          onCalendarDisconnected={() => {
            setCalendarRevoked(false);
            setCalendarDisconnectCount((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

/** Hook extracted so it can call useLocation safely inside the Router context. */
function useShowNavInner() {
  const { pathname } = useLocation();
  const { status } = useAuth();
  if (status !== "signed_in") return false;
  if (pathname === "/confirm" || pathname === "/auth" || pathname === "/reset") return false;
  return true;
}

