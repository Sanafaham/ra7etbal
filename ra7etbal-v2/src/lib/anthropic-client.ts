import { supabase } from "./supabase";

/**
 * Calls the /api/anthropic proxy with the caller's current Supabase session
 * attached. Every caller of /api/anthropic already runs inside an
 * authenticated (ProtectedRoute-gated) part of the app, so a session is
 * always expected to exist — this throws if one doesn't, which every
 * existing caller already treats identically to a network failure via its
 * own try/catch (see text-carson.ts, ai/extract.ts, carson-summarize.ts,
 * etc.). The token itself is never logged or exposed.
 */
export async function callAnthropicProxy(body: unknown): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error("Not signed in.");
  }
  return fetch("/api/anthropic", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}
