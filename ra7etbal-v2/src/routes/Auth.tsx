import { useId, useRef, useState, type FormEvent } from "react";
import AuthNotice from "../components/auth/AuthNotice";
import PasswordField from "../components/auth/PasswordField";
import Spinner from "../components/Spinner";
import { mapAuthError, sendResetEmail, signInWithPassword, signUpWithPassword } from "../lib/auth";

type Mode = "signin" | "signup";
type Notice =
  | { kind: "error" | "info" | "success"; text: string }
  | null;

export default function Auth() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // Synchronous guard against fast double-clicks before React commits.
  const submittingRef = useRef(false);
  const resetRef = useRef(false);

  const emailId = useId();

  const trimmedEmail = email.trim();
  const canSubmit =
    !submitting &&
    !sendingReset &&
    trimmedEmail.length > 0 &&
    password.length > 0;

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setNotice(null);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!canSubmit) return;

    submittingRef.current = true;
    setSubmitting(true);
    setNotice(null);

    try {
      if (mode === "signin") {
        await signInWithPassword({ email: trimmedEmail, password });
        // Auth listener flips status → signed_in. App.tsx <Navigate> sends
        // the user to /. No navigate() call needed here.
      } else {
        await signUpWithPassword({ email: trimmedEmail, password });
        // Email confirmation is OFF → session attaches immediately, same path
        // as sign-in.
      }
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err, mode) });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleForgot() {
    if (resetRef.current) return;
    if (!trimmedEmail) {
      setNotice({ kind: "error", text: "Please enter your email first." });
      return;
    }
    resetRef.current = true;
    setSendingReset(true);
    setNotice(null);
    try {
      await sendResetEmail(trimmedEmail);
      setNotice({
        kind: "success",
        text: "Reset email sent. Check your inbox.",
      });
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err, "reset") });
    } finally {
      resetRef.current = false;
      setSendingReset(false);
    }
  }

  const submitLabel =
    mode === "signin"
      ? submitting
        ? "Signing in…"
        : "Sign in"
      : submitting
        ? "Creating account…"
        : "Create account";

  return (
    <section className="mx-auto max-w-md space-y-6 rounded-2xl border border-sage/30 bg-white/80 p-6 shadow-sm">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-ink">
          {mode === "signin" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="text-sm text-ink/60">
          {mode === "signin"
            ? "Sign in to pick up where you left off."
            : "Just an email and a password — no confirmation step."}
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Auth mode"
        className="grid grid-cols-2 gap-1 rounded-full border border-sage/30 bg-cream/60 p-1"
      >
        {(["signin", "signup"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => switchMode(m)}
            disabled={submitting || sendingReset}
            className={
              "rounded-full px-3 py-2 text-sm font-medium transition " +
              (mode === m
                ? "bg-sage text-white shadow-sm"
                : "text-ink/70 hover:text-ink")
            }
          >
            {m === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={emailId}
            className="text-xs font-medium uppercase tracking-wide text-ink/60"
          >
            Email
          </label>
          <input
            id={emailId}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            inputMode="email"
            disabled={submitting || sendingReset}
            className="w-full rounded-xl border border-sage/30 bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
          />
        </div>

        <div className="space-y-1.5">
          <PasswordField
            label="Password"
            value={password}
            onChange={setPassword}
            placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            disabled={submitting || sendingReset}
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleForgot}
              disabled={sendingReset || submitting}
              className="text-xs font-medium text-sage transition hover:underline disabled:opacity-50"
            >
              {sendingReset ? "Sending…" : "Forgot password?"}
            </button>
          </div>
        </div>

        {notice && <AuthNotice kind={notice.kind}>{notice.text}</AuthNotice>}

        <button
          type="submit"
          disabled={!canSubmit}
          aria-busy={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-sage px-5 py-3 text-base font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting && <Spinner size={16} />}
          <span>{submitLabel}</span>
        </button>
      </form>
    </section>
  );
}

function errorText(err: unknown, action: "signin" | "signup" | "reset"): string {
  // The lib already wrapped Supabase errors, but anything else funnels through
  // mapAuthError for a friendly fallback.
  if (err instanceof Error && err.message) return err.message;
  return mapAuthError(err, action);
}
