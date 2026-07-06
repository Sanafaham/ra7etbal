import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import AuthNotice from "../components/auth/AuthNotice";
import PasswordField from "../components/auth/PasswordField";
import Spinner from "../components/Spinner";
import { mapAuthError, sendResetEmail, signInWithPassword, signUpWithPassword } from "../lib/auth";
import { upsertProfile } from "../lib/profile";

type Mode = "signin" | "signup";
type Notice =
  | { kind: "error" | "info" | "success"; text: string }
  | null;

interface FlashState {
  flash?: string;
}

export default function Auth() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);

  // One-shot flash from another route (e.g. Reset → "Password updated. You can
  // now sign in."). Read once on mount, then drop from history.state so a
  // hard refresh doesn't re-show it.
  const location = useLocation();
  const navigate = useNavigate();
  const initialFlash = (location.state as FlashState | null)?.flash;
  const [notice, setNotice] = useState<Notice>(
    initialFlash ? { kind: "success", text: initialFlash } : null,
  );
  useEffect(() => {
    if (initialFlash) {
      navigate(location.pathname, { replace: true, state: null });
    }
    // initialFlash is captured at mount; we intentionally don't depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Synchronous guard against fast double-clicks before React commits.
  const submittingRef = useRef(false);
  const resetRef = useRef(false);

  const emailId = useId();
  const nameId = useId();

  const trimmedEmail = email.trim();
  const trimmedName = name.trim();
  const canSubmit =
    !submitting &&
    !sendingReset &&
    trimmedEmail.length > 0 &&
    password.length > 0 &&
    (mode === "signin" || trimmedName.length > 0);

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setName("");
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
        // Email confirmation is OFF → session attaches immediately.
        // Save display name now that auth.getUser() will resolve correctly.
        // Non-fatal: if the upsert fails the account still exists and the
        // user can set their name in Settings.
        if (trimmedName) {
          await upsertProfile(trimmedName).catch((err) => {
            console.warn("[Auth] upsertProfile after signup failed:", err);
          });
        }
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
    <section className="mx-auto max-w-md space-y-6 rounded-2xl border border-border bg-white/80 p-6 shadow-sm">
      <header className="space-y-1">
        <h1 style={{ fontFamily: "var(--font-display)" }} className="text-[28px] font-semibold leading-tight tracking-[-0.005em] text-ink">
          {mode === "signin" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="text-[13px] text-text-soft">
          {mode === "signin"
            ? "Sign in to pick up where you left off."
            : "Your name, email, and a password — no confirmation step."}
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Auth mode"
        className="grid grid-cols-2 gap-1 rounded-full border border-border bg-cream/60 p-1"
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
        {mode === "signup" && (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={nameId}
              className="text-xs font-medium uppercase tracking-wide text-ink/60"
            >
              Your name
            </label>
            <input
              id={nameId}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What should Carson call you?"
              autoComplete="name"
              disabled={submitting || sendingReset}
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
            />
          </div>
        )}

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
            className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
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

      <p className="text-center text-[11px] text-ink/40">
        By continuing you agree to our{" "}
        <Link to="/terms" className="underline underline-offset-2 hover:text-ink/60">
          Terms
        </Link>{" "}
        and{" "}
        <Link to="/privacy" className="underline underline-offset-2 hover:text-ink/60">
          Privacy Policy
        </Link>
        .
      </p>
    </section>
  );
}

function errorText(err: unknown, action: "signin" | "signup" | "reset"): string {
  // The lib already wrapped Supabase errors, but anything else funnels through
  // mapAuthError for a friendly fallback.
  if (err instanceof Error && err.message) return err.message;
  return mapAuthError(err, action);
}
