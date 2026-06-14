import { Link } from "react-router-dom";

export default function Terms() {
  return (
    <section className="mx-auto max-w-2xl space-y-8 px-4 py-12">
      <header className="space-y-2">
        <Link to="/auth" className="text-xs font-medium text-sage hover:underline">
          ← Back
        </Link>
        <h1 className="text-3xl font-semibold text-ink">Terms of Service</h1>
        <p className="text-sm text-ink/50">Last updated: June 2026</p>
      </header>

      <div className="space-y-6 text-sm leading-relaxed text-ink/80">
        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">1. Acceptance of Terms</h2>
          <p>
            By creating an account or using Ra7etBal, you agree to these Terms of Service. If you
            do not agree, please do not use the app.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">2. What Ra7etBal Is</h2>
          <p>
            Ra7etBal is a personal productivity assistant. It helps you capture and manage tasks,
            reminders, delegations, and calendar events. Carson, the AI Chief of Staff, can
            interact with your data using voice.
          </p>
          <p>
            Ra7etBal is a personal tool. It is not designed for teams, enterprises, or
            multi-user environments at this time.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">3. Your Account</h2>
          <p>
            You are responsible for maintaining the security of your account credentials. You
            must not share your account with others. You are responsible for all activity that
            occurs under your account.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">4. Google Calendar Integration</h2>
          <p>
            Ra7etBal can connect to your Google Calendar to read your events and create, update,
            or delete events at your instruction. This integration is optional. You can connect
            and disconnect Google Calendar at any time from Settings.
          </p>
          <p>
            By connecting Google Calendar, you authorise Ra7etBal to access calendar data on
            your behalf. We do not access your calendar for any purpose other than what you
            explicitly request through the app.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">5. WhatsApp and Messaging</h2>
          <p>
            Ra7etBal can send WhatsApp messages to people you specify when you delegate tasks or
            create reminders. You are responsible for ensuring you have the right to send messages
            to those contacts. Do not use Ra7etBal to send unsolicited messages.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">6. Acceptable Use</h2>
          <p>You agree not to use Ra7etBal to:</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>Violate any applicable laws or regulations.</li>
            <li>Send spam or unsolicited messages to others.</li>
            <li>Attempt to access another user's data.</li>
            <li>Reverse engineer, copy, or reproduce the service.</li>
            <li>Use the service in any way that could damage or overload our infrastructure.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">7. Availability</h2>
          <p>
            Ra7etBal is provided as-is. We aim to keep the service available, but we do not
            guarantee uninterrupted access. We may update or change the service at any time.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">8. Limitation of Liability</h2>
          <p>
            Ra7etBal is not liable for any loss or damage resulting from your use of the service,
            including but not limited to missed reminders, missed tasks, or calendar errors. You
            use the service at your own risk.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">9. Changes to These Terms</h2>
          <p>
            We may update these terms from time to time. Continued use of the app after changes
            are posted means you accept the updated terms. We will update the "Last updated" date
            at the top of this page when changes are made.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-ink">10. Contact</h2>
          <p>
            For any questions about these terms, contact us at{" "}
            <a href="mailto:support@ra7etbal.com" className="text-sage hover:underline">
              support@ra7etbal.com
            </a>
            .
          </p>
        </section>
      </div>
    </section>
  );
}
