interface Props {
  size?: number;
  className?: string;
  label?: string;
}

/** Small inline spinner — pairs with button labels like "Signing in…". */
export default function Spinner({ size = 16, className = "", label }: Props) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      className={"inline-flex items-center " + className}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="animate-spin"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="3"
        />
        <path
          d="M22 12a10 10 0 0 0-10-10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
