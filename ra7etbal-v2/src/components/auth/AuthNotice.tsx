interface Props {
  kind: "error" | "info" | "success";
  children: React.ReactNode;
}

const styles: Record<Props["kind"], string> = {
  error: "border-danger/30 bg-danger/8 text-danger",
  info: "border-sage/40 bg-sage/10 text-ink",
  success: "border-gold/30 bg-gold/8 text-gold-dark",
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
