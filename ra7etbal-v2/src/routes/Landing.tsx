import { Link } from "react-router-dom";

export default function Landing() {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-8 px-6 py-10 text-center">
      {/* Purpose — brand lockup already shown in the shared header above */}
      <div className="max-w-sm space-y-3">
        <p style={{ fontFamily: "var(--font-display)" }} className="text-[26px] font-semibold leading-snug tracking-[-0.005em] text-ink">
          Your AI-powered mental relief assistant
        </p>
        <p className="text-[14px] leading-relaxed text-text-soft">
          Ra7etBal helps busy people clear their minds, stay on top of tasks,
          and feel at ease — with Carson, your always-on AI chief of staff.
        </p>
      </div>

      {/* Features */}
      <ul className="max-w-xs space-y-2 text-left text-[14px] text-ink">
        <li className="flex items-start gap-2"><span className="mt-0.5 text-gold">✓</span>Voice-first task management with Carson</li>
        <li className="flex items-start gap-2"><span className="mt-0.5 text-gold">✓</span>Daily briefings and smart follow-ups</li>
        <li className="flex items-start gap-2"><span className="mt-0.5 text-gold">✓</span>Calendar, notes, and people — all in one place</li>
        <li className="flex items-start gap-2"><span className="mt-0.5 text-gold">✓</span>Calm, focused design for peace of mind</li>
      </ul>

      {/* CTA */}
      <Link
        to="/auth"
        className="rounded-full bg-sage px-8 py-3 text-[14px] font-bold text-white shadow-sm transition hover:brightness-105 active:brightness-95"
      >
        Get started
      </Link>

      {/* Legal */}
      <div className="flex gap-4 text-[11px] text-text-soft">
        <Link to="/privacy" className="hover:text-ink">Privacy Policy</Link>
        <Link to="/terms" className="hover:text-ink">Terms of Service</Link>
      </div>
    </div>
  );
}
