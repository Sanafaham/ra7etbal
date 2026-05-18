interface Props {
  kind: "error" | "info" | "success";
  children: React.ReactNode;
}

const styles: Record<Props["kind"], string> = {
  error: "border-rose-300 bg-rose-50 text-rose-900",
  info: "border-sage/40 bg-sage/10 text-ink",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900",
};

export default function AuthNotice({ kind, children }: Props) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
      className={
        "rounded-xl border px-4 py-3 text-sm leading-snug " + styles[kind]
      }
    >
      {children}
    </div>
  );
}
