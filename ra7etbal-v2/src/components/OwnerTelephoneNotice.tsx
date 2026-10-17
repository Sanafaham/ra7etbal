import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

interface PhoneResult { code?: string; expiresAt?: string; answer?: string | null; decisionUrl?: string; error?: string }

/** Explicit owner interaction uses the existing Supabase session, never caller ID. */
export default function OwnerTelephoneNotice({ receiptId, userId }: { receiptId: string; userId: string }) {
  const [result, setResult] = useState<PhoneResult | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setResult(null);
    setBusy(false);
    return () => { generation.current += 1; };
  }, [receiptId, userId]);
  useEffect(() => {
    if (!result?.code || !result.expiresAt) return;
    const timeout = window.setTimeout(() => setResult(previous => previous ? { ...previous, code: undefined } : null), Math.max(0, Date.parse(result.expiresAt) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [result?.code, result?.expiresAt]);

  async function load(consent: boolean) {
    const current = ++generation.current;
    setBusy(true);
    setResult(null);
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session || data.session.user.id !== userId) throw new Error("Sign in again to verify this call.");
      const response = await fetch("/api/task-confirm?ownerTelephone=owner", {
        method: "POST",
        headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ receiptId, consent }),
      });
      const value = await response.json() as PhoneResult;
      if (!response.ok) throw new Error(value.error || "Could not load the call. Please try again.");
      if (generation.current === current) setResult(value);
    } catch (error) {
      if (generation.current === current) setResult({ error: error instanceof Error ? error.message : "Could not load the call." });
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  return <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm text-ink">
    <p>Verify only a call you are currently receiving from Carson. Choosing Verify means you agree to transcription for this decision. Audio recording is off.</p>
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={busy} onClick={() => void load(true)} className="underline disabled:opacity-50">Verify Carson’s call</button>
      <button type="button" disabled={busy} onClick={() => void load(false)} className="underline disabled:opacity-50">Review call response</button>
    </div>
    <div aria-live="polite">
      {result?.error && <p role="alert">{result.error}</p>}
      {result?.code && <p>Read this code to Carson: <strong>{result.code}</strong>. It expires at {new Date(result.expiresAt!).toLocaleTimeString()}. This does not approve an action.</p>}
      {result?.answer && <p className="whitespace-pre-wrap">Recorded telephone response: {result.answer}</p>}
      {result && !result.error && !result.code && !result.answer && <p>No confirmed telephone response is available. Your decision remains open.</p>}
      {result?.decisionUrl && /^\/confirm\?token=[0-9a-f-]{36}$/i.test(result.decisionUrl) && <Link className="underline" to={result.decisionUrl}>Open existing decision page</Link>}
    </div>
  </div>;
}
