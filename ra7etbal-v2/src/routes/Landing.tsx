import { Link } from "react-router-dom";

export default function Landing() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 py-16 text-center">
      {/* Brand */}
      <div className="flex flex-col items-center gap-3">
        <span className="text-5xl">🌿</span>
        <h1 className="text-4xl font-bold tracking-tight text-ink">Ra7etBal</h1>
        <p className="text-xl text-ink/60" dir="rtl">راحة بال</p>
      </div>

      {/* Purpose */}
      <div className="max-w-sm space-y-3">
        <p className="text-lg font-medium text-ink">
          Your AI-powered mental relief assistant
        </p>
        <p className="text-sm text-ink/60 leading-relaxed">
          Ra7etBal helps busy people clear their minds, stay on top of tasks,
          and feel at ease — with Carson, your always-on AI chief of staff.
        </p>
      </div>

      {/* Features */}
      <ul className="max-w-xs space-y-2 text-left text-sm text-ink/70">
        <li className="flex items-start gap-2"><span className="mt-0.5 text-sage">✓</span>Voice-first task management with Carson</li>
        <li className="flex items-start gap-2"><span className="mt-0.5 text-sage">✓</span>Daily briefings and smart follow-ups</li>
        <li className="flex items-start gap-2"><span className="mt-0.5 text-sage">✓</span>Calendar, notes, and people — all in one place</li>
        <li className="flex items-start gap-2"><span className="mt-0.5 text-sage">✓</span>Calm, focused design for peace of mind</li>
      </ul>

      {/* CTA */}
      <Link
        to="/auth"
        className="rounded-2xl bg-sage px-8 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 active:opacity-80"
      >
        Get started
      </Link>

      {/* Legal */}
      <div className="flex gap-4 text-xs text-ink/40">
        <Link to="/privacy" className="hover:text-ink/60">Privacy Policy</Link>
        <Link to="/terms" className="hover:text-ink/60">Terms of Service</Link>
      </div>
    </div>
  );
}
