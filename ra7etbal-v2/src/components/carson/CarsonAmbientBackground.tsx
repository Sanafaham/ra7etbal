interface Props {
  fixed?: boolean;
  className?: string;
  density?: "standard" | "content";
}

/** Canonical faded Carson identity used by Home and every light Carson surface. */
export default function CarsonAmbientBackground({ fixed = false, className = "", density = "standard" }: Props) {
  return (
    <div
      className={`pointer-events-none ${fixed ? "fixed" : "absolute"} inset-0 overflow-hidden ${className}`}
      aria-hidden="true"
    >
      <div
        className={`absolute inset-0 bg-cover bg-[center_18%] brightness-[0.78] contrast-[1.18] saturate-[1.08] sepia-[0.18] sm:bg-[center_14%] ${density === "content" ? "opacity-[0.15]" : "opacity-[0.26]"}`}
        style={{ backgroundImage: "url('/carson-ambient-subject-v1.png')" }}
      />
    </div>
  );
}
