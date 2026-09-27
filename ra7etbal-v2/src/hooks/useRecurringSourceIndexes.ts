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
export function useRecurringSourceIndexes(): {
  indexes: RecurringSourceIndexes | undefined;
  loaded: boolean;
} {
  const { status: authStatus } = useAuth();
  const [indexes, setIndexes] = useState<RecurringSourceIndexes | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;

    if (authStatus !== "signed_in") {
      setIndexes(undefined);
      setLoaded(false);
      return;
    }

    fetchAutomationDigest()
      .then((digest) => {
        if (generationRef.current !== generation) return;
        // Only an explicitly complete link read may narrow what the UI shows.
        // `recurringSourceLinksLoaded !== true` covers both a failed read and a
        // partial one, and must not be confused with "owner has no automations"
        // — see the same distinction in automation-context.ts.
        if (digest.recurringSourceLinksLoaded === true) {
          setIndexes(digest.recurringSourceIndexes);
          setLoaded(true);
        } else {
          setIndexes(undefined);
          setLoaded(false);
        }
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        // Fail safe: no indexes means nothing is superseded, so nothing hides.
        setIndexes(undefined);
        setLoaded(false);
      });
  }, [authStatus]);

  return { indexes, loaded };
}
