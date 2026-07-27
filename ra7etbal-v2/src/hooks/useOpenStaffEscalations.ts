import { useEffect, useRef, useState } from "react";
import { useAuth } from "./useAuth";
import { listOpenStaffEscalationsForNeedsYou } from "../lib/staff-messages";
import type { OpenStaffEscalation } from "../types/staff-message";

/**
 * Phase C — the single shared data source for open staff escalations
 * appearing in the Needs You list. Home, Updates (needs-you tab), and
 * BottomNav's badge all call this same hook rather than each duplicating
 * their own fetch/filter logic, so the three surfaces can never drift —
 * same principle already established for buildDailyBrief()'s
 * needsAttention array (see RA7ETBAL_STATE.md).
 *
 * Deliberately does not touch daily-brief.ts / buildDailyBrief(): staff
 * escalations are not `Task` rows, and isNeedsYouTask() is a protected,
 * locked classifier for the existing tasks-only decision queue.
 */
export function useOpenStaffEscalations(): {
  escalations: OpenStaffEscalation[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  reload: () => Promise<void>;
} {
  const { status: authStatus } = useAuth();
  const [escalations, setEscalations] = useState<OpenStaffEscalation[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  async function reload() {
    if (authStatus !== "signed_in") return;
    const generation = ++generationRef.current;
    setStatus((s) => (s === "ready" ? "ready" : "loading"));
    setError(null);
    try {
      const loaded = await listOpenStaffEscalationsForNeedsYou();
      if (generationRef.current !== generation) return;
      setEscalations(loaded);
      setStatus("ready");
    } catch (e) {
      if (generationRef.current !== generation) return;
      // A failed fetch here must never break the rest of the Needs You
      // screen — this hook owns and contains its own error state, same
      // convention as StaffUpdates.tsx.
      setError(e instanceof Error ? e.message : "Could not load staff requests. Please try again.");
      setStatus("error");
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus]);

  return { escalations, status, error, reload };
}
