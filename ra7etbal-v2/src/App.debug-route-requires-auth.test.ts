import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "App.tsx"), "utf-8");

/**
 * /debug (src/routes/Debug.tsx) was reachable by unauthenticated visitors —
 * it rendered the current session's auth state, Supabase host, and (when a
 * session existed in the browser) the signed-in user's id/email, with no
 * route guard. Wrapping it in the same ProtectedRoute already used by every
 * other authenticated-only route (see the 10 other ProtectedRoute-wrapped
 * <Route> entries in App.tsx) redirects unauthenticated visitors to /auth,
 * matching this app's one existing auth-gating mechanism rather than
 * introducing a new one.
 */
describe("App.tsx — /debug route requires authentication", () => {
  it("wraps the /debug route in ProtectedRoute", () => {
    expect(SOURCE).toContain(
      '<Route path="/debug" element={<ProtectedRoute><Debug /></ProtectedRoute>} />',
    );
  });

  it("no longer renders Debug unguarded", () => {
    expect(SOURCE).not.toContain('<Route path="/debug" element={<Debug />} />');
  });

  it("leaves the other genuinely-public routes (/, /auth, /reset, /confirm, /privacy, /terms) unguarded, unchanged", () => {
    expect(SOURCE).toContain('<Route path="/" element={<HomeRoute />} />');
    expect(SOURCE).toContain('<Route path="/auth" element={<AuthRoute />} />');
    expect(SOURCE).toContain('<Route path="/reset" element={<ResetRoute />} />');
    expect(SOURCE).toContain('<Route path="/confirm" element={<ConfirmRouter />} />');
    expect(SOURCE).toContain('<Route path="/privacy" element={<Privacy />} />');
    expect(SOURCE).toContain('<Route path="/terms" element={<Terms />} />');
  });

  it("leaves every already-protected route's guard unchanged", () => {
    const alreadyProtected = [
      '<Route path="/updates" element={<ProtectedRoute><Updates /></ProtectedRoute>} />',
      '<Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />',
      '<Route path="/active" element={<ProtectedRoute><Active /></ProtectedRoute>} />',
      '<Route path="/inbox" element={<ProtectedRoute><Inbox /></ProtectedRoute>} />',
      '<Route path="/actions" element={<ProtectedRoute><Actions /></ProtectedRoute>} />',
      '<Route path="/follow-ups" element={<ProtectedRoute><FollowUps /></ProtectedRoute>} />',
      '<Route path="/messages" element={<ProtectedRoute><Messages /></ProtectedRoute>} />',
      '<Route path="/notes" element={<ProtectedRoute><Notes /></ProtectedRoute>} />',
      '<Route path="/people" element={<ProtectedRoute><People /></ProtectedRoute>} />',
      '<Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />',
    ];
    for (const route of alreadyProtected) {
      expect(SOURCE).toContain(route);
    }
  });

  it("ProtectedRoute itself still redirects signed-out visitors to /auth (the mechanism /debug now relies on)", () => {
    expect(SOURCE).toContain('if (status === "signed_out") return <Navigate to="/auth" replace />;');
  });
});
