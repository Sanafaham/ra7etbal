import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/auth", () => ({
  mapAuthError: () => "Authentication failed.",
  sendResetEmail: vi.fn(),
  signInWithPassword: vi.fn(),
  signUpWithPassword: vi.fn(),
}));

vi.mock("../lib/profile", () => ({
  upsertProfile: vi.fn(),
}));

import Auth from "./Auth";

function renderAuth(publicSignupEnabled: boolean, initialMode: "signin" | "signup") {
  return renderToStaticMarkup(
    <StaticRouter location="/auth">
      <Auth
        publicSignupEnabled={publicSignupEnabled}
        initialMode={initialMode}
      />
    </StaticRouter>,
  );
}

describe("production launch signup UI control", () => {
  it("signup disabled: hides signup controls and shows the invite-only notice", () => {
    const html = renderAuth(false, "signup");

    expect(html).toContain("Welcome back");
    expect(html).toContain("Ra7etBal is currently invite-only.");
    expect(html).not.toContain("Create your account");
    expect(html).not.toContain("Create account");
    expect(html).not.toContain("What should Carson call you?");
    expect(html).not.toContain('role="tablist"');
  });

  it("signup enabled: makes the signup tab and signup form available", () => {
    const html = renderAuth(true, "signup");

    expect(html).toContain("Create your account");
    expect(html).toContain("Create account");
    expect(html).toContain("What should Carson call you?");
    expect(html).toContain('role="tablist"');
    expect(html).not.toContain("currently invite-only");
  });

  it.each([false, true])(
    "sign-in remains available when public signup is %s",
    (publicSignupEnabled) => {
      const html = renderAuth(publicSignupEnabled, "signin");

      expect(html).toContain("Welcome back");
      expect(html).toContain("Sign in to pick up where you left off.");
      expect(html).toContain("Forgot password?");
      expect(html).toContain('type="email"');
      expect(html).toContain('autoComplete="current-password"');
    },
  );
});
