import { beforeEach, describe, expect, it, vi } from "vitest";

const { single, supabaseMock } = vi.hoisted(() => {
  const single = vi.fn();
  const supabaseMock = {
    from: vi.fn(() => ({
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single })) })),
    })),
  };
  return { single, supabaseMock };
});
vi.mock("./supabase", () => ({ supabase: supabaseMock }));

import { createPerson } from "./people";

describe("createPerson — Canonical Staff Identity Cleanup prevention", () => {
  beforeEach(() => {
    single.mockReset();
  });

  it("surfaces a clear message when the test/fixture-role guard (people_role_not_test_fixture_check) rejects an insert", async () => {
    single.mockResolvedValue({
      data: null,
      error: {
        message:
          'new row for relation "people" violates check constraint "people_role_not_test_fixture_check"',
      },
    });

    await expect(
      createPerson({ name: "Regression Guard Test", role: "Test staff" } as never),
    ).rejects.toThrow("That role looks like a test/fixture placeholder, not a real household role.");
  });

  it("does not block a second real person sharing an existing name — the guard targets fixture roles, not name collisions", async () => {
    single.mockResolvedValue({
      data: { id: "person-2", name: "Christopher", role: "Gardener" },
      error: null,
    });

    await expect(
      createPerson({ name: "Christopher", role: "Gardener" } as never),
    ).resolves.toMatchObject({ name: "Christopher", role: "Gardener" });
  });
});
