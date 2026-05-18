import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import AuthNotice from "../components/auth/AuthNotice";
import PasswordField from "../components/auth/PasswordField";
import Spinner from "../components/Spinner";
import { mapAuthError, updatePassword } from "../lib/auth";
import { clearRecovery, signOut } from "../lib/session";

const MIN_PASSWORD_LENGTH = 6;

export default function Reset() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous guard for fast double-clicks before React commits.
  const submittingRef = useRef(false);

  const canSubmit = !submitting && password.length > 0;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!canSubmit) return;

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      // 1) Update the password on the Supabase user.
      await updatePassword(password);

      // 2) Tear down the recovery session so the app cannot route the user
      //    back into Reset later. We clear the store flag first, then sign
      //    out of Supabase. SIGNED_OUT from the listener will re-confirm
      //    `signed_out` — both calls are idempotent.
      clearRecovery();
      await signOut();

      // 3) Send the user to /auth with a one-shot success notice. `replace`
      //    so the browser back button doesn't return to Reset.
      navigate("/auth", {
        replace: true,
        state: { flash: "Password updated. You can now sign in." },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : mapAuthError(err, "update"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="mx-auto max-w-md space-y-6 rounded-2xl border border-sage/30 bg-white/80 p-6 shadow-sm">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-ink">Set a new password</h1>
        <p className="text-sm text-ink/60">
          Choose a password that's at least {MIN_PASSWORD_LENGTH} characters. You'll
          be signed out and asked to sign in again with the new password.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <PasswordField
          label="New password"
          value={password}
          onChange={setPassword}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          autoComplete="new-password"
          disabled={submitting}
        />

        {error && <AuthNotice kind="error">{error}</AuthNotice>}

        <button
          type="submit"
          disabled={!canSubmit}
          aria-busy={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-sage px-5 py-3 text-base font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting && <Spinner size={16} />}
          <span>{submitting ? "Updating…" : "Update password"}</span>
        </button>
      </form>
    </section>
  );
}
