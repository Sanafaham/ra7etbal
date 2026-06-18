// PersonForm v3 — WhatsApp consent fields
import { useId, useRef, useState, type FormEvent } from "react";
import AuthNotice from "../auth/AuthNotice";
import Spinner from "../Spinner";
import type { Person, PersonDraft, ReliabilityLevel, FollowUpLevel } from "../../types/person";

const ROLE_SUGGESTIONS = [
  "Driver", "Nanny", "Cook", "Cleaner / Housemaid", "Personal Assistant",
  "House Manager", "Gardener", "Helper", "Tutor", "Family",
];

const RELIABILITY_OPTIONS: { value: ReliabilityLevel; label: string }[] = [
  { value: "very_high",     label: "Very high — executes without supervision" },
  { value: "high",          label: "High — reliable with occasional check-ins" },
  { value: "medium",        label: "Medium — needs regular follow-up" },
  { value: "needs_support", label: "Needs support — requires close supervision" },
];

const FOLLOWUP_OPTIONS: { value: FollowUpLevel; label: string }[] = [
  { value: "none",    label: "None — self-managing" },
  { value: "light",   label: "Light — occasional nudge" },
  { value: "regular", label: "Regular — check in after each task" },
  { value: "high",    label: "High — always follow up" },
];

interface Props {
  initial?: Person;
  onSubmit: (draft: PersonDraft) => Promise<unknown>;
  onCancel: () => void;
  onDelete?: () => Promise<unknown>;
}

export default function PersonForm({ initial, onSubmit, onCancel, onDelete }: Props) {
  // Basic fields
  const nameId   = useId();
  const roleId   = useId();
  const phoneId  = useId();
  const notesId  = useId();
  const roleListId = useId();

  const [name,  setName]  = useState(initial?.name  ?? "");
  const [role,  setRole]  = useState(initial?.role  ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  // Household knowledge fields
  const [relationship,       setRelationship]       = useState(initial?.relationship       ?? "");
  const [isFamily,           setIsFamily]           = useState(initial?.is_family          ?? false);
  const [responsibilities,   setResponsibilities]   = useState(initial?.responsibilities   ?? "");
  const [reliabilityLevel,   setReliabilityLevel]   = useState<ReliabilityLevel | "">(initial?.reliability_level ?? "");
  const [followUpLevel,      setFollowUpLevel]      = useState<FollowUpLevel | "">(initial?.follow_up_level     ?? "");
  const [delegationGuidance, setDelegationGuidance] = useState(initial?.delegation_guidance ?? "");
  const [shouldNotAssign,    setShouldNotAssign]    = useState(initial?.should_not_assign   ?? "");
  const [escalateTo,         setEscalateTo]         = useState(initial?.escalate_to        ?? "");
  const [communicationStyle, setCommunicationStyle] = useState(initial?.communication_style ?? "");

  // WhatsApp consent
  const [whatsappOptedIn,     setWhatsappOptedIn]     = useState(initial?.whatsapp_opted_in     ?? false);
  const [whatsappConsentAt,   setWhatsappConsentAt]   = useState(initial?.whatsapp_consent_at   ?? null as string | null);
  const [whatsappConsentMethod, setWhatsappConsentMethod] = useState(initial?.whatsapp_consent_method ?? null as string | null);

  function handleConsentToggle(checked: boolean) {
    setWhatsappOptedIn(checked);
    if (checked) {
      setWhatsappConsentAt(new Date().toISOString());
      setWhatsappConsentMethod("owner_confirmed");
    } else {
      setWhatsappConsentAt(null);
      setWhatsappConsentMethod(null);
    }
  }

  const [showIntelligence, setShowIntelligence] = useState(
    // Auto-expand when any intelligence field already has data
    !!(initial?.relationship || initial?.responsibilities || initial?.delegation_guidance ||
       initial?.reliability_level || initial?.follow_up_level || initial?.should_not_assign ||
       initial?.escalate_to || initial?.communication_style),
  );

  const [busy,             setBusy]             = useState<null | "save" | "delete">(null);
  const [error,            setError]            = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const busyRef = useRef(false);

  const trimmedName = name.trim();
  const trimmedRole = role.trim();
  const canSave = !busy && trimmedName.length > 0 && trimmedRole.length > 0;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busyRef.current || !canSave) return;
    busyRef.current = true;
    setBusy("save");
    setError(null);
    try {
      await onSubmit({
        name:  trimmedName,
        role:  trimmedRole,
        phone: phone.trim()  || null,
        notes: notes.trim()  || null,
        relationship:       relationship.trim()       || null,
        is_family:          isFamily,
        responsibilities:   responsibilities.trim()   || null,
        reliability_level:  reliabilityLevel          || null,
        follow_up_level:    followUpLevel             || null,
        delegation_guidance: delegationGuidance.trim() || null,
        should_not_assign:  shouldNotAssign.trim()    || null,
        escalate_to:        escalateTo.trim()         || null,
        communication_style: communicationStyle.trim() || null,
        whatsapp_opted_in:     whatsappOptedIn,
        whatsapp_consent_at:   whatsappConsentAt,
        whatsapp_consent_method: whatsappConsentMethod,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Please try again.");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!onDelete || busyRef.current) return;
    busyRef.current = true;
    setBusy("delete");
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete. Please try again.");
      busyRef.current = false;
      setBusy(null);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>

      {/* ── Basic fields ──────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-xs font-medium uppercase tracking-wide text-ink/60">Name</label>
        <input
          id={nameId} type="text" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Grace" autoComplete="off" disabled={!!busy}
          className="w-full rounded-xl border border-sage/30 bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={roleId} className="text-xs font-medium uppercase tracking-wide text-ink/60">Role</label>
        <input
          id={roleId} list={roleListId} type="text" value={role} onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. House Manager" autoComplete="off" disabled={!!busy}
          className="w-full rounded-xl border border-sage/30 bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
        />
        <datalist id={roleListId}>
          {ROLE_SUGGESTIONS.map((r) => <option key={r} value={r} />)}
        </datalist>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={notesId} className="text-xs font-medium uppercase tracking-wide text-ink/60">
          Description / Notes <span className="font-normal normal-case text-ink/40">(optional)</span>
        </label>
        <textarea
          id={notesId} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Tell Carson who this person is, what they do, and anything important to remember."
          rows={3} disabled={!!busy}
          className="w-full resize-none rounded-xl border border-sage/30 bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
        />
      </div>

      <div className="flex items-start gap-2.5 pt-0.5">
        <input
          id="is-family" type="checkbox" checked={isFamily}
          onChange={(e) => setIsFamily(e.target.checked)} disabled={!!busy}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-sage/40 text-sage focus:ring-sage/30"
        />
        <label htmlFor="is-family" className="text-sm text-ink/60 leading-snug">
          Family member — Carson won't assign them household tasks or treat them as staff.
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={phoneId} className="text-xs font-medium uppercase tracking-wide text-ink/60">
          Phone <span className="font-normal normal-case text-ink/40">(optional)</span>
        </label>
        <input
          id={phoneId} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
          placeholder="+971 50 000 0000" autoComplete="tel" inputMode="tel" disabled={!!busy}
          className="w-full rounded-xl border border-sage/30 bg-white px-4 py-3 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
        />
      </div>

      {/* ── WhatsApp Consent ──────────────────────────────────────── */}
      <div className="rounded-2xl border border-sage/20 bg-white px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
            <input
              id="whatsapp-consent"
              type="checkbox"
              checked={whatsappOptedIn}
              onChange={(e) => handleConsentToggle(e.target.checked)}
              disabled={!!busy}
              className="h-4 w-4 rounded border-sage/40 text-sage focus:ring-sage/30"
            />
          </div>
          <div className="flex-1 min-w-0">
            <label htmlFor="whatsapp-consent" className="cursor-pointer text-sm font-medium text-ink leading-snug">
              WhatsApp consent recorded
            </label>
            <p className="mt-0.5 text-xs leading-relaxed text-ink/50">
              {whatsappOptedIn
                ? "This person has agreed to receive WhatsApp messages from Ra7etBal."
                : "Without consent, Carson will not send WhatsApp messages to this person."}
            </p>
            {whatsappOptedIn && whatsappConsentAt && (
              <p className="mt-1 text-[11px] text-ink/40">
                Recorded {new Date(whatsappConsentAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                {whatsappConsentMethod === "owner_confirmed" ? " · confirmed by you" : ""}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Carson Intelligence ────────────────────────────────────── */}
      <div className="rounded-2xl border border-sage/15 bg-sage/3">
        <button
          type="button"
          onClick={() => setShowIntelligence((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-ink/50">
            Carson Intelligence
          </span>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={"transition-transform " + (showIntelligence ? "rotate-180" : "")}
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {showIntelligence && (
          <div className="space-y-4 border-t border-sage/10 px-4 pb-4 pt-4">
            <p className="text-[11px] leading-relaxed text-ink/45">
              These fields teach Carson how to delegate to this person and when to follow up. None are required.
            </p>

            {/* Relationship */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-ink/55">
                Relationship to you
              </label>
              <input
                type="text" value={relationship} onChange={(e) => setRelationship(e.target.value)}
                placeholder="e.g. Sana's brother, household staff, my daughter"
                disabled={!!busy}
                className="w-full rounded-xl border border-sage/25 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-sage focus:ring-2 focus:ring-sage/20 disabled:opacity-50"
              />
            </div>

            {/* Responsibilities */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-ink/55">
                Responsibilities
              </label>
              <textarea
                value={responsibilities} onChange={(e) => setResponsibilities(e.target.value)}
                placeholder="What this person handles (e.g. cleaning, laundry, room preparation)"
                rows={2} disabled={!!busy}
                className="w-full resize-none rounded-xl border border-sage/25 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-sage focus:ring-2 focus:ring-sage/20 disabled:opacity-50"
              />
            </div>

            {/* Reliability + Follow-up */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-ink/55">
                  Reliability
                </label>
                <select
                  value={reliabilityLevel}
                  onChange={(e) => setReliabilityLevel(e.target.value as ReliabilityLevel | "")}
                  disabled={!!busy}
                  className="w-full rounded-xl border border-sage/25 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-sage focus:ring-2 focus:ring-sage/20 disabled:opacity-50"
                >
                  <option value="">— not set —</option>
                  {RELIABILITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-ink/55">
                  Follow-up level
                </label>
                <select
                  value={followUpLevel}
                  onChange={(e) => setFollowUpLevel(e.target.value as FollowUpLevel | "")}
                  disabled={!!busy}
                  className="w-full rounded-xl border border-sage/25 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-sage focus:ring-2 focus:ring-sage/20 disabled:opacity-50"
                >
                  <option value="">— not set —</option>
                  {FOLLOWUP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Delegation guidance */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-ink/55">
                Delegation guidance
              </label>
              <textarea
                value={delegationGuidance} onChange={(e) => setDelegationGuidance(e.target.value)}
                placeholder="How Carson should assign tasks to this person (e.g. always loop in Grace, needs step-by-step instructions)"
                rows={2} disabled={!!busy}
                className="w-full resize-none rounded-xl border border-sage/25 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-sage focus:ring-2 focus:ring-sage/20 disabled:opacity-50"
              />
            </div>

            {/* Should not assign */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-ink/55">
                Do NOT assign
              </label>
              <input
                type="text" value={shouldNotAssign} onChange={(e) => setShouldNotAssign(e.target.value)}
                placeholder="e.g. financial tasks, driving, unsupervised decisions"
                disabled={!!busy}
                className="w-full rounded-xl border border-sage/25 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-sage focus:ring-2 focus:ring-sage/20 disabled:opacity-50"
              />
            </div>

            {/* Escalate to */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-ink/55">
                Escalate to (if unresponsive)
              </label>
              <input
                type="text" value={escalateTo} onChange={(e) => setEscalateTo(e.target.value)}
                placeholder="e.g. Grace"
                disabled={!!busy}
                className="w-full rounded-xl border border-sage/25 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-sage focus:ring-2 focus:ring-sage/20 disabled:opacity-50"
              />
            </div>

            {/* Communication style */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-ink/55">
                Communication style
              </label>
              <input
                type="text" value={communicationStyle} onChange={(e) => setCommunicationStyle(e.target.value)}
                placeholder="e.g. Short WhatsApp messages, prefers voice notes, needs written instructions"
                disabled={!!busy}
                className="w-full rounded-xl border border-sage/25 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-sage focus:ring-2 focus:ring-sage/20 disabled:opacity-50"
              />
            </div>

          </div>
        )}
      </div>

      {error && <AuthNotice kind="error">{error}</AuthNotice>}

      {/* ── Action buttons ─────────────────────────────────────────── */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onDelete && !confirmingDelete && (
          <button
            type="button" onClick={() => setConfirmingDelete(true)} disabled={!!busy}
            className="mr-auto rounded-full border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
          >
            Delete
          </button>
        )}
        {onDelete && confirmingDelete && (
          <div className="mr-auto flex items-center gap-2">
            <span className="text-xs text-ink/70">Are you sure?</span>
            <button
              type="button" onClick={() => setConfirmingDelete(false)} disabled={!!busy}
              className="rounded-full border border-sage/30 bg-white px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-cream disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button" onClick={handleDelete} disabled={!!busy}
              className="inline-flex items-center gap-2 rounded-full bg-rose-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-50"
            >
              {busy === "delete" && <Spinner size={12} />}
              {busy === "delete" ? "Deleting…" : "Delete"}
            </button>
          </div>
        )}
        <button
          type="button" onClick={onCancel} disabled={!!busy}
          className="rounded-full border border-sage/30 bg-white px-5 py-2.5 text-sm font-medium text-ink shadow-sm transition hover:bg-cream disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit" disabled={!canSave} aria-busy={busy === "save"}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-sage px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "save" && <Spinner size={14} />}
          <span>{busy === "save" ? "Saving…" : initial ? "Save changes" : "Add person"}</span>
        </button>
      </div>
    </form>
  );
}
