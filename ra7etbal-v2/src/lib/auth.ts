import type { AuthError } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * All public auth actions live here so components never touch the Supabase
 * client directly. Errors are normalized into stable user-facing strings via
 * `mapAuthError()` — components display the string as-is.
 */

export interface Credentials {
  email: string;
  password: string;
}

export async function signInWithPassword({ email, password }: Credentials): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw friendly(error, "signin");
}

export async function signUpWithPassword({ email, password }: Credentials): Promise<void> {
  // Email confirmation is OFF in this project, so a successful signUp yields
  // a session and the auth listener flips the store to `signed_in`.
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw friendly(error, "signup");
}

export async function sendResetEmail(email: string): Promise<void> {
  // Always use the canonical www origin so the redirectTo matches the Supabase
  // allowlist regardless of which domain the user triggered the reset from.
  // Use the non-www canonical origin. www.ra7etbal.com has a DNS-level
  // redirect (registrar, not Vercel) that strips path+query, so any link to
  // www.ra7etbal.com/reset?code=XXX lands at ra7etbal.com (root) with the
  // PKCE code gone. ra7etbal.com has no such redirect, so the code survives.
  const origin =
    window.location.hostname === "localhost"
      ? window.location.origin
      : "https://ra7etbal.com";
  const redirectTo = origin + "/reset";
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw friendly(error, "reset");
}

/**
 * Update the signed-in (or recovery-mode) user's password. Caller is
 * responsible for the post-update flow (clearRecovery + signOut + navigate).
 */
export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw friendly(error, "update");
}

// ---------------------------------------------------------------------------

type AuthAction = "signin" | "signup" | "reset" | "update";

function friendly(err: AuthError | Error, action: AuthAction): Error {
  const message = mapAuthError(err, action);
  const out = new Error(message);
  // Preserve the original for logging — surfaces in the browser console.
  (out as Error & { cause?: unknown }).cause = err;
  return out;
}

/**
 * Translate Supabase / network errors into the exact user-facing strings
 * required by the regression checklist. Centralized here so every screen
 * shows the same wording for the same failure.
 */
export function mapAuthError(err: unknown, action: AuthAction): string {
  if (!err) return "Something went wrong. Please try again.";

  // Browser network failures: TypeError "Failed to fetch" / "Load failed"
  if (err instanceof TypeError) {
    return "Network issue. Please check your connection.";
  }

  const raw =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : String(err);
  const msg = raw.toLowerCase();

  if (msg.includes("invalid login credentials")) return "Wrong email or password.";
  if (msg.includes("email not confirmed")) {
    return "Email not yet confirmed. Check your inbox or contact support.";
  }
  if (msg.includes("user not found") || msg.includes("no user found")) {
    return "No account with that email.";
  }
  if (msg.includes("user already registered") || msg.includes("already been registered")) {
    return "An account with that email already exists. Try signing in.";
  }
  if (msg.includes("password should be at least") || msg.includes("password is too short")) {
    return "Password must be at least 6 characters.";
  }
  if (msg.includes("rate limit") || msg.includes("too many requests")) {
    return "Too many attempts. Please try again in a few minutes.";
  }
  if (msg.includes("invalid email") || msg.includes("email address") && msg.includes("invalid")) {
    return "That doesn't look like a valid email address.";
  }
  if (msg.includes("network") || msg.includes("failed to fetch") || msg.includes("load failed")) {
    return "Network issue. Please check your connection.";
  }

  // Fallback per action so the user never sees a raw stack trace.
  switch (action) {
    case "signin":
      return "Could not sign in. Please try again.";
    case "signup":
      return "Could not create your account. Please try again.";
    case "reset":
      return "Could not send the reset email. Please try again.";
    case "update":
      return "Could not update your password. Please try again.";
  }
}
