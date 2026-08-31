/**
 * Hidden Stage 2A binding-issuance view (DEV/TROUBLESHOOTING ONLY, non-production).
 *
 * Not linked anywhere in the UI. Only renders when the URL is
 * /debug/carson-binding (any deeper path also matches) OR carries
 * ?carsonBinding=1. Returns null for every normal user/route.
 *
 * Reuses the existing "issue_session_binding" action already implemented in
 * api/carson-custom-llm-stage2a.js — this view is only the missing
 * owner-authenticated caller for it. It uses the signed-in Supabase session
 * already held by the browser (never asks the owner to paste a JWT) and
 * never logs or displays that access token; only the resulting short-lived
 * carson_stage2a_binding value (10-minute TTL) is shown, for pasting into
 * the ElevenLabs Custom LLM "extra body" config.
 *
 * `computeStage2ABindingVisibility`, `issueStage2ABinding`, and
 * `CarsonStage2ABindingView` are exported so the access-token handling and
 * rendering can be unit-tested without a DOM (see
 * CarsonStage2ABinding.test.tsx) — the access token itself never crosses
 * into the View's props, so it is structurally impossible for it to render.
 *
 * EASY REMOVAL: delete this file and remove the <CarsonStage2ABindingOverlay/>
 * mount + import in App.tsx.
 */
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "../lib/supabase";

export type IssueState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; binding: string; sessionId: string; expiresAt: number };

/** Pure route/query gate — matches the existing CarsonDebug overlay convention. */
export function computeStage2ABindingVisibility(pathname: string, search: string): boolean {
  const params = new URLSearchParams(search);
  return pathname.startsWith("/debug/carson-binding") || params.get("carsonBinding") === "1";
}

/**
 * Requests a fresh Stage 2A session binding using the caller-supplied access
 * token. Fails safe (never calls the endpoint) when no token is available —
 * an unauthenticated browser cannot obtain a binding this way. The token is
 * used only as the Authorization header of the POST request: never placed
 * in the URL, never included in the JSON body, never logged.
 */
export async function issueStage2ABinding({
  getAccessToken,
  fetchImpl = fetch,
}: {
  getAccessToken: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<IssueState> {
  let accessToken: string | undefined;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { status: "error", message: "Could not read the current session." };
  }
  if (!accessToken) {
    return { status: "error", message: "Not signed in to Ra7etBal — sign in first, then reopen this page." };
  }

  try {
    const res = await fetchImpl("/api/carson-custom-llm-stage2a", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ action: "issue_session_binding", scenario: "fixed" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { status: "error", message: body?.error ?? `Request failed (${res.status})` };
    }
    const body = await res.json();
    return { status: "ready", binding: body.binding, sessionId: body.sessionId, expiresAt: body.expiresAt };
  } catch {
    return { status: "error", message: "Network error issuing binding." };
  }
}

export function CarsonStage2ABindingView({
  state,
  copied,
  onIssue,
  onCopy,
}: {
  state: IssueState;
  copied: boolean;
  onIssue: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#0c0a09",
        color: "#e7e5e4",
        font: "13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
        overflowY: "auto",
        padding: "16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <strong style={{ fontSize: 15 }}>Carson Stage 2A — Session Binding</strong>
        <button onClick={onIssue} style={btnStyle}>
          {state.status === "loading" ? "Issuing…" : "Issue new binding"}
        </button>
        <a href="/" style={{ ...btnStyle, textDecoration: "none" }}>Close</a>
      </div>

      <p style={{ color: "#a8a29e", maxWidth: 640 }}>
        Non-production only. Issues a fresh <code>carson_stage2a_binding</code> for
        the ElevenLabs Test Connection, using your already-signed-in Ra7etBal
        session. The binding is short-lived (10 minutes) — reissue if the test
        connection reports an expired binding.
      </p>

      {state.status === "error" && (
        <div style={{ borderLeft: "3px solid #b91c1c", padding: "8px 10px", marginTop: 12, background: "#1c1917", borderRadius: 4 }}>
          {state.message}
        </div>
      )}

      {state.status === "ready" && (
        <div style={{ marginTop: 12 }}>
          <div style={{ color: "#a8a29e", marginBottom: 4 }}>
            carson_stage2a_binding — expires {new Date(state.expiresAt * 1000).toLocaleTimeString()}
          </div>
          <textarea
            readOnly
            value={state.binding}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            style={{
              width: "100%",
              maxWidth: 640,
              height: 90,
              background: "#1c1917",
              color: "#e7e5e4",
              border: "1px solid #44403c",
              borderRadius: 4,
              padding: 8,
              font: "inherit",
              resize: "vertical",
            }}
          />
          <div style={{ marginTop: 8 }}>
            <button style={btnStyle} onClick={onCopy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#292524",
  color: "#e7e5e4",
  border: "1px solid #44403c",
  borderRadius: 4,
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
};

/**
 * Exported so the real Carson conversation-start component's Stage 2A
 * auto-binding gate can reuse the exact same owner-session lookup used
 * here — one implementation, not a second copy.
 */
export async function getSupabaseAccessToken(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

export default function CarsonStage2ABindingOverlay() {
  const location = useLocation();
  const visible = computeStage2ABindingVisibility(location.pathname, location.search);

  const [state, setState] = useState<IssueState>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  async function handleIssue() {
    setState({ status: "loading" });
    setCopied(false);
    setState(await issueStage2ABinding({ getAccessToken: getSupabaseAccessToken }));
  }

  useEffect(() => {
    if (visible && state.status === "idle") void handleIssue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  return (
    <CarsonStage2ABindingView
      state={state}
      copied={copied}
      onIssue={handleIssue}
      onCopy={async () => {
        if (state.status !== "ready") return;
        await navigator.clipboard.writeText(state.binding);
        setCopied(true);
      }}
    />
  );
}
