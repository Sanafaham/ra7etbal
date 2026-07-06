import { useId, useState } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: "current-password" | "new-password";
  disabled?: boolean;
  /** Accessible label, also rendered visually unless `srOnlyLabel` is true. */
  label: string;
  srOnlyLabel?: boolean;
  /** Used by parent to scope its own htmlFor; if omitted we generate one. */
  id?: string;
}

export default function PasswordField({
  value,
  onChange,
  placeholder,
  autoComplete = "current-password",
  disabled,
  label,
  srOnlyLabel,
  id,
}: Props) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className={
          srOnlyLabel
            ? "sr-only"
            : "text-xs font-medium uppercase tracking-wide text-ink/60"
        }
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          disabled={disabled}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 pr-12 text-base text-ink shadow-sm outline-none transition focus:border-sage focus:ring-2 focus:ring-sage/30 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-lg text-ink/60 transition hover:text-ink disabled:opacity-50"
        >
          {visible ? "🙈" : "👁"}
        </button>
      </div>
    </div>
  );
}
