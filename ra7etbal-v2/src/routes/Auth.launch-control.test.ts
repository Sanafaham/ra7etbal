import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./Auth.tsx", import.meta.url)),
  "utf8",
);

describe("production launch signup control", () => {
  it("keeps public signup hidden unless the launch flag is explicitly true", () => {
    expect(source).toContain(
      'import.meta.env.VITE_PUBLIC_SIGNUP_ENABLED === "true"',
    );
    expect(source).toContain(
      'PUBLIC_SIGNUP_ENABLED ? ["signup" as const] : []',
    );
  });

  it("keeps existing approved-user sign in available", () => {
    expect(source).toContain(
      "Existing approved users can sign in.",
    );
    expect(source).toContain(
      "await signInWithPassword({ email: trimmedEmail, password })",
    );
  });
});
