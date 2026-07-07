import { useMemo } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useCarsonStore } from "../../stores/carson";
import { useBadgeStore } from "../../stores/badges";
import { useTasksStore } from "../../stores/tasks";
import { buildDailyBrief } from "../../lib/daily-brief";

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={`${count} item${count !== 1 ? "s" : ""}`}
      className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold leading-none text-white"
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * 4-tab bottom navigation bar.
 * Home / Updates / People / Carson
 *
 * Updates badge priority: needsAttention → waitingOnOthers → inboxCount
 * (highest-priority non-zero count shown, red pill).
 * Carson: pulsing green dot when connected.
 */
export default function BottomNav() {
  const { setOpen: setCarsonOpen, callStatus, open: carsonOpen } = useCarsonStore();
  const inboxCount = useBadgeStore((s) => s.inboxCount);
  const tasks = useTasksStore((s) => s.items);
  const { pathname } = useLocation();

  const updatesIsActive = pathname === "/updates" || pathname.startsWith("/updates");

  const updatesBadge = useMemo(() => {
    const brief = buildDailyBrief(tasks, new Date());
    if (brief.needsAttention.length > 0) return brief.needsAttention.length;
    if (brief.waitingOnOthers.length > 0) return brief.waitingOnOthers.length;
    if (inboxCount > 0) return inboxCount;
    return 0;
  }, [tasks, inboxCount]);

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-30 border-t border-sage/15 bg-white/96 backdrop-blur-md"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 8px)" }}
      aria-label="Main navigation"
    >
      <div className="mx-auto flex max-w-3xl items-stretch">
        {/* Home */}
        <NavLink
          to="/"
          end
          aria-label="Home"
          className={({ isActive }) =>
            "flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition " +
            (isActive ? "text-sage" : "text-ink/45 hover:text-ink/70")
          }
        >
          {({ isActive }) => (
            <>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={isActive ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z" />
                <path d="M9 21V12h6v9" />
              </svg>
              <span>Home</span>
            </>
          )}
        </NavLink>

        {/* Updates — badge: priority count (needs you → waiting → inbox) */}
        <NavLink
          to="/updates"
          aria-label="Updates"
          className={
            "relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition " +
            (updatesIsActive ? "text-sage" : "text-ink/45 hover:text-ink/70")
          }
        >
          <span className="relative">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={updatesIsActive ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <Badge count={updatesBadge} />
          </span>
          <span>Updates</span>
        </NavLink>

        {/* People — core product destination */}
        <NavLink
          to="/people"
          aria-label="People"
          className={({ isActive }) =>
            "relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition " +
            (isActive ? "text-sage" : "text-ink/45 hover:text-ink/70")
          }
        >
          {({ isActive }) => (
            <>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={isActive ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span>People</span>
            </>
          )}
        </NavLink>

        {/* Carson — active when sheet open, dot when connected */}
        <button
          type="button"
          onClick={() => setCarsonOpen(true)}
          aria-label="Talk to Carson"
          className={"relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition " + (carsonOpen ? "text-sage" : "text-ink/45 hover:text-ink/70")}
        >
          <span className="relative">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={carsonOpen ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
            {callStatus === "connected" && (
              <span aria-label="Carson is active" className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sage" />
              </span>
            )}
          </span>
          <span>Carson</span>
        </button>
      </div>
    </nav>
  );
}
