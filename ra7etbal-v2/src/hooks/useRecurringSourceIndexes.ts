import { useEffect, useRef, useState } from "react";
import { useAuth } from "./useAuth";
import { fetchAutomationDigest } from "../lib/automation-context";
import type { RecurringSourceIndexes } from "../../shared/carson-recurring-manifestations";

/**
 * P3 5b UI CONSUMER ALIGNMENT (2026-09-27) — the single shared access path to
 * the existing recurring source-link indexes for the Home / What's Happening
 * operational surfaces.
 *
 * This is NOT a new source of truth. It is a React access path to the one that
 * already exists: fetchAutomationDigest() populates
 * `AutomationDigest.recurringSourceIndexes` and `recurringSourceLinksLoaded`
 * (see automation-context.ts), which App.tsx already passes into
 * buildCarsonContext(). Home and Updates are rendered through <Routes> without
 * props, so they need their own accessor — same convention already established
 * by useOpenStaffEscalations(), which Home, Updates and BottomNav all share so
 * the surfaces cannot drift.
 *
 * FAIL SAFE BY CONSTRUCTION: `indexes` is undefined until the digest has loaded
 * AND reported `recurringSourceLinksLoaded === true`. Idle, in-flight, failed,
 * signed-out, and "loaded but links incomplete" all yield undefined, and
 * buildDailyBrief() treats undefined as "supersede nothing" — every
 * manifestation stays visible. Nothing is ever hidden because a fetch was slow
 * or failed.
 */
/**
 * One in-flight/resolved digest read shared by every surface that needs the
 * indexes (Home, Updates, BottomNav), keyed by user so a sign-out or account
 * switch can never serve another user's links.
 *
 * Two reasons this cache is load-bearing rather than an optimisation:
 *  - Home, Updates and BottomNav must agree. Three independent fetches could
 *    resolve to three different snapshots, so the same task could be superseded
 *    on one surface and current on another — exactly the drift this capability's
 *    contract forbids.
 *  - fetchAutomationDigest() issues several queries, two of them bounded at
 *    RECURRING_SOURCE_LINK_LIMIT rows. Re-running all of it on every route mount
 *    just to read two fields is waste App.tsx has already paid for.
 */
let cacheKey: string | null = null;
let cachedDigest: Promise<{
  indexes: RecurringSourceIndexes | undefined;
  loaded: boolean;
}> | null = null;

function readSharedIndexes(userId: string) {
  if (cacheKey === userId && cachedDigest) return cachedDigest;
  cacheKey = userId;
  cachedDigest = fetchAutomationDigest()
    .then((digest) =>
      // Only an explicitly complete link read may narrow what the UI shows.
      // `recurringSourceLinksLoaded !== true` covers both a failed read and a
      // partial one, and must not be confused with "owner has no automations"
      // — see the same distinction in automation-context.ts.
      digest.recurringSourceLinksLoaded === true
        ? { indexes: digest.recurringSourceIndexes, loaded: true }
        : { indexes: undefined, loaded: false },
    )
    .catch(() => {
      // Fail safe: no indexes means nothing is superseded, so nothing hides.
      // Clear the cache so a later mount can retry rather than being pinned to
      // a transient failure for the rest of the session.
      if (cacheKey === userId) {
        cacheKey = null;
        cachedDigest = null;
      }
      return { indexes: undefined, loaded: false };
    });
  return cachedDigest;
}

/** Test-only seam so a suite can reset module state between cases. */
export function __resetRecurringSourceIndexesCache() {
  cacheKey = null;
  cachedDigest = null;
}

export function useRecurringSourceIndexes(): {
  indexes: RecurringSourceIndexes | undefined;
  loaded: boolean;
} {
  const { status: authStatus, user } = useAuth();
  const userId = user?.id ?? null;
  const [indexes, setIndexes] = useState<RecurringSourceIndexes | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;

    if (authStatus !== "signed_in" || !userId) {
      setIndexes(undefined);
      setLoaded(false);
      return;
    }

    readSharedIndexes(userId)
      .then((result) => {
        if (generationRef.current !== generation) return;
        setIndexes(result.indexes);
        setLoaded(result.loaded);
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        // Fail safe: no indexes means nothing is superseded, so nothing hides.
        setIndexes(undefined);
        setLoaded(false);
      });
  }, [authStatus, userId]);

  return { indexes, loaded };
}
