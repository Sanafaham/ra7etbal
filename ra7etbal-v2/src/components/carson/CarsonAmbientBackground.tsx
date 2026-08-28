interface Props {
  fixed?: boolean;
  className?: string;
}

/** Canonical faded Carson identity used by Home and every light Carson surface. */
export default function CarsonAmbientBackground({ fixed = false, className = "" }: Props) {
  return (
    <div
      className={`pointer-events-none ${fixed ? "fixed" : "absolute"} inset-0 overflow-hidden ${className}`}
      aria-hidden="true"
    >
      <div
        className="absolute inset-0 bg-cover bg-[center_18%] opacity-[0.14] brightness-[1.05] contrast-[1.12] saturate-[0.78] sm:bg-[center_14%]"
        style={{ backgroundImage: "url('/carson-ambient-subject-v1.png')" }}
      />
    </div>
  );
}
