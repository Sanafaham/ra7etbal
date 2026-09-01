/**
 * carson-second-brain-voice-binding.ts
 *
 * Second Brain Slice 2 — client-side counterpart to
 * api/_carson-second-brain-voice-boundary.js. Fetches a fresh,
 * owner-authenticated, short-lived binding automatically, using the
 * signed-in Ra7etBal session already held by the browser — no manual
 * binding page, no owner-visible token, no owner action required.
 *
 * The binding is held only in memory for the duration of constructing one
 * Conversation.startSession call (see ElevenLabsAgentWidget.tsx's
 * secondBrainVoiceEnabled gate) — never logged, never persisted to
 * localStorage/sessionStorage, never placed in a URL.
 */
import { supabase } from "./supabase";

export type IssueSecondBrainVoiceBindingResult =
  | { status: "ready"; binding: string; sessionId: string; expiresAt: number }
  | { status: "error"; message: string };

/**
 * Requests a fresh binding using the caller-supplied access token. Fails
 * safe (never calls the endpoint) when no token is available — an
 * unauthenticated browser cannot obtain a binding this way. The token is
 * used only as the Authorization header of one POST: never placed in a
 * URL, never included in the JSON body, never logged.
 */
export async function issueSecondBrainVoiceBinding({
  getAccessToken,
  fetchImpl = fetch,
}: {
  getAccessToken: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<IssueSecondBrainVoiceBindingResult> {
  let accessToken: string | undefined;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { status: "error", message: "Could not read the current session." };
  }
  if (!accessToken) {
    return { status: "error", message: "Not signed in — cannot issue a Second Brain voice binding." };
  }

  try {
    const res = await fetchImpl("/api/carson-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ action: "issue_second_brain_voice_binding" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { status: "error", message: body?.error ?? `Request failed (${res.status})` };
    }
    const body = await res.json();
    return { status: "ready", binding: body.binding, sessionId: body.sessionId, expiresAt: body.expiresAt };
  } catch {
    return { status: "error", message: "Network error issuing Second Brain voice binding." };
  }
}

export async function getSupabaseAccessToken(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}
