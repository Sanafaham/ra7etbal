import { NavLink, Route, Routes } from "react-router-dom";
import Debug from "./routes/Debug";

function Placeholder({ title }: { title: string }) {
  return (
    <section className="rounded-2xl border border-sage/30 bg-white/70 p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <p className="mt-2 text-sm text-ink/70">
        Placeholder — implemented in a later step.
      </p>
    </section>
  );
}

const navItems = [
  { to: "/", label: "Home", end: true },
  { to: "/auth", label: "Auth" },
  { to: "/reset", label: "Reset" },
  { to: "/review", label: "Review" },
  { to: "/people", label: "People" },
  { to: "/confirm", label: "Confirm" },
  { to: "/debug", label: "Debug" },
];

export default function App() {
  return (
    <div className="min-h-dvh bg-cream text-ink">
      <header className="mx-auto flex max-w-3xl items-center gap-3 px-5 pt-6">
        <span aria-hidden className="text-2xl">🌿</span>
        <div className="flex flex-col leading-tight">
          <span className="font-semibold">Ra7etBal · راحة بال</span>
          <span className="text-xs text-ink/60">v2 scaffold — Step 1</span>
        </div>
      </header>

      <nav className="mx-auto mt-4 flex max-w-3xl flex-wrap gap-2 px-5">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              [
                "rounded-full border px-3 py-1 text-sm transition",
                isActive
                  ? "border-sage bg-sage text-white"
                  : "border-sage/30 bg-white/60 text-ink hover:bg-white",
              ].join(" ")
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="mx-auto mt-6 max-w-3xl px-5 pb-24">
        <Routes>
          <Route path="/" element={<Placeholder title="Home / Clear My Head" />} />
          <Route path="/auth" element={<Placeholder title="Sign in / Sign up" />} />
          <Route path="/reset" element={<Placeholder title="Set new password" />} />
          <Route path="/review" element={<Placeholder title="Review extracted items" />} />
          <Route path="/people" element={<Placeholder title="People" />} />
          <Route path="/confirm" element={<Placeholder title="Confirm task" />} />
          <Route path="/debug" element={<Debug />} />
          <Route
            path="*"
            element={
              <section className="rounded-2xl border border-sage/30 bg-white/70 p-6">
                <h2 className="text-xl font-semibold">Not found</h2>
                <p className="mt-2 text-sm text-ink/70">
                  This route does not exist yet.
                </p>
              </section>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
