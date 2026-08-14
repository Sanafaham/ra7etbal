import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  mapChangedFiles,
  buildPathIndex,
  buildTestIndex,
  isProductionSurfaceFile,
  findMissingRegistryPaths,
  loadRegistry,
  loadExclusions,
  extractFilePath,
  repoRoot,
} from "./impact-map.mjs";

// Phase 2 of the Carson Engineering Hardening Project. These tests prove the
// impact mapper's own correctness against small synthetic registries (fast,
// deterministic, no dependency on the real 14-capability registry staying a
// particular shape) plus a handful of checks against the real registry file
// to prove the two stay in sync. Counterfactual verification against the
// real Phase 0 incidents lives in impact-map.counterfactual.test.mjs.

function fixtureRegistry() {
  return {
    capabilities: [
      {
        id: "cap_a",
        files_functions: ["api/foo.js:doThing", "src/lib/foo-helper.ts"],
        production_entry_points: [],
        shared_dependencies: ["api/_shared.js"],
        db: { migrations: ["supabase/migrations/20260101_a.sql"], data_repairs: [] },
        focused_tests: ["api/foo.test.js"],
        golden_journey_tests: [],
        db_contract_tests: ["supabase/migrations/verification/a_contract.sql"],
        db_contract_workflow: ".github/workflows/a-contract.yml",
      },
      {
        id: "cap_b",
        files_functions: ["src/lib/bar.ts"],
        production_entry_points: [],
        shared_dependencies: ["api/_shared.js"],
        db: { migrations: [], data_repairs: [] },
        focused_tests: ["src/lib/bar.test.ts"],
        golden_journey_tests: ["src/lib/bar.golden-contract.test.ts"],
      },
    ],
  };
}

describe("extractFilePath", () => {
  it("strips a trailing function-name colon suffix", () => {
    expect(extractFilePath("api/foo.js:doThing")).toBe("api/foo.js");
  });
  it("strips a trailing parenthetical description", () => {
    expect(extractFilePath("api/foo.js (some description)")).toBe("api/foo.js");
  });
  it("leaves a bare path unchanged", () => {
    expect(extractFilePath("api/foo.js")).toBe("api/foo.js");
  });
});

describe("mapChangedFiles — direct capability dependency", () => {
  it("a change to a file listed under one capability's files_functions selects exactly that capability", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["src/lib/bar.ts"], registry, new Set());
    expect(result.affectedCapabilities).toEqual(["cap_b"]);
    expect(result.requiredTests).toEqual(["src/lib/bar.golden-contract.test.ts", "src/lib/bar.test.ts"]);
  });
});

describe("mapChangedFiles — Phase 4 DB contract surfacing", () => {
  it("a change to a migration file surfaces the owning capability's db_contract_tests/workflow, informationally, not as a vitest requiredTest", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["supabase/migrations/20260101_a.sql"], registry, new Set());
    expect(result.affectedCapabilities).toEqual(["cap_a"]);
    expect(result.affectedDbContractTests).toEqual(["supabase/migrations/verification/a_contract.sql"]);
    expect(result.affectedDbContractWorkflows).toEqual([".github/workflows/a-contract.yml"]);
    // Not conflated with the vitest-run requiredTests list.
    expect(result.requiredTests).not.toContain("supabase/migrations/verification/a_contract.sql");
  });

  it("a capability with no db_contract_tests contributes nothing to the DB contract lists", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["src/lib/bar.ts"], registry, new Set());
    expect(result.affectedCapabilities).toEqual(["cap_b"]);
    expect(result.affectedDbContractTests).toEqual([]);
    expect(result.affectedDbContractWorkflows).toEqual([]);
  });

  it("a direct change to a db_contract_tests SQL file itself (not the migration) also selects the owning capability", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["supabase/migrations/verification/a_contract.sql"], registry, new Set());
    expect(result.affectedCapabilities).toEqual(["cap_a"]);
    expect(result.affectedDbContractTests).toEqual(["supabase/migrations/verification/a_contract.sql"]);
    expect(result.affectedDbContractWorkflows).toEqual([".github/workflows/a-contract.yml"]);
  });

  it("a direct change to the db_contract_workflow file itself also selects the owning capability", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles([".github/workflows/a-contract.yml"], registry, new Set());
    expect(result.affectedCapabilities).toEqual(["cap_a"]);
    expect(result.affectedDbContractTests).toEqual(["supabase/migrations/verification/a_contract.sql"]);
    expect(result.affectedDbContractWorkflows).toEqual([".github/workflows/a-contract.yml"]);
  });
});

describe("mapChangedFiles — shared dependency fan-out", () => {
  it("a change to a file listed as shared_dependencies for multiple capabilities selects every dependent capability, not just the nearest one", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["api/_shared.js"], registry, new Set());
    expect(result.affectedCapabilities).toEqual(["cap_a", "cap_b"]);
    expect(result.requiredTests).toEqual([
      "api/foo.test.js",
      "src/lib/bar.golden-contract.test.ts",
      "src/lib/bar.test.ts",
    ]);
  });
});

describe("mapChangedFiles — multiple changed files produce a deduplicated union", () => {
  it("two files from the same capability, plus one from another, produce exactly the union with no duplicates", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(
      ["api/foo.js", "src/lib/foo-helper.ts", "src/lib/bar.ts"],
      registry,
      new Set()
    );
    expect(result.affectedCapabilities).toEqual(["cap_a", "cap_b"]);
    // api/foo.test.js must appear exactly once even though two cap_a files changed
    expect(result.requiredTests.filter((t) => t === "api/foo.test.js")).toHaveLength(1);
  });
});

describe("mapChangedFiles — unrelated non-production changes never trigger false protection", () => {
  it("a changed docs/markdown file selects zero capabilities and zero tests", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["README.md", "docs/some-note.md"], registry, new Set());
    expect(result.affectedCapabilities).toEqual([]);
    expect(result.requiredTests).toEqual([]);
    expect(result.unmappedProtectedFiles).toEqual([]);
  });

  it("a changed file outside api/, src/lib/, and supabase/migrations/ is never flagged as an unmapped protected file, even if unmapped", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["src/components/SomeUnrelatedWidget.tsx"], registry, new Set());
    expect(result.unmappedProtectedFiles).toEqual([]);
  });
});

describe("mapChangedFiles — fail-closed on unmapped protected production files", () => {
  it("a changed api/ file with zero capability mapping and no exclusion is reported as unmapped", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["api/totally-new-unregistered-module.js"], registry, new Set());
    expect(result.unmappedProtectedFiles).toEqual(["api/totally-new-unregistered-module.js"]);
  });

  it("a changed src/lib/ file with zero capability mapping is reported as unmapped", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["src/lib/totally-new-unregistered-module.ts"], registry, new Set());
    expect(result.unmappedProtectedFiles).toEqual(["src/lib/totally-new-unregistered-module.ts"]);
  });

  it("a changed supabase/migrations/ file with zero capability mapping is reported as unmapped", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["supabase/migrations/20261231_new_unregistered.sql"], registry, new Set());
    expect(result.unmappedProtectedFiles).toEqual(["supabase/migrations/20261231_new_unregistered.sql"]);
  });

  it("an explicit exclusion silences the unmapped-protected-file failure for that exact path only", () => {
    const registry = fixtureRegistry();
    const exclusions = new Set(["api/weather.js"]);
    const result = mapChangedFiles(["api/weather.js", "api/still-unregistered.js"], registry, exclusions);
    expect(result.unmappedProtectedFiles).toEqual(["api/still-unregistered.js"]);
  });

  it("a .test.js/.test.ts change under api/ or src/lib/ is never flagged as unmapped — test files are not production surface", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(
      ["api/some-unregistered-thing.test.js", "src/lib/some-unregistered-thing.test.ts"],
      registry,
      new Set()
    );
    expect(result.unmappedProtectedFiles).toEqual([]);
  });

  it("a supabase/migrations/verification/*.sql change is never flagged as unmapped — it is DB verification tooling, not production business logic", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(
      ["supabase/migrations/verification/some_new_check.sql"],
      registry,
      new Set()
    );
    expect(result.unmappedProtectedFiles).toEqual([]);
  });
});

describe("mapChangedFiles — registered test paths must exist (registry/mapper consistency, not filesystem I/O)", () => {
  it("a change to a file that is itself a registered focused_test selects that test's own capability", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["src/lib/bar.test.ts"], registry, new Set());
    expect(result.affectedCapabilities).toEqual(["cap_b"]);
    expect(result.requiredTests).toContain("src/lib/bar.test.ts");
  });
});

describe("mapChangedFiles — migration/database dependency changes map correctly", () => {
  it("a changed migration file listed under db.migrations selects the owning capability", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(["supabase/migrations/20260101_a.sql"], registry, new Set());
    expect(result.affectedCapabilities).toEqual(["cap_a"]);
  });

  it("a changed .rollback.sql companion maps to the same capability as its forward migration", () => {
    const registry = fixtureRegistry();
    const result = mapChangedFiles(
      ["supabase/migrations/20260101_a.rollback.sql"],
      registry,
      new Set()
    );
    expect(result.affectedCapabilities).toEqual(["cap_a"]);
  });
});

describe("isProductionSurfaceFile", () => {
  it("classifies api/, src/lib/, and supabase/migrations/ production files as protected surface", () => {
    expect(isProductionSurfaceFile("api/foo.js")).toBe(true);
    expect(isProductionSurfaceFile("src/lib/foo.ts")).toBe(true);
    expect(isProductionSurfaceFile("supabase/migrations/20260101_a.sql")).toBe(true);
  });
  it("excludes test files, rollback files, and verification fixtures from the fail-closed gate", () => {
    expect(isProductionSurfaceFile("api/foo.test.js")).toBe(false);
    expect(isProductionSurfaceFile("supabase/migrations/20260101_a.rollback.sql")).toBe(false);
    expect(isProductionSurfaceFile("supabase/migrations/verification/x.sql")).toBe(false);
  });
  it("excludes files outside the three named surfaces", () => {
    expect(isProductionSurfaceFile("src/components/Widget.tsx")).toBe(false);
    expect(isProductionSurfaceFile("README.md")).toBe(false);
  });
});

describe("buildPathIndex / buildTestIndex", () => {
  it("indexes every files_functions/production_entry_points/shared_dependencies/migration entry, normalized", () => {
    const registry = fixtureRegistry();
    const index = buildPathIndex(registry);
    expect([...(index.get("api/foo.js") || [])]).toEqual(["cap_a"]);
    expect([...(index.get("api/_shared.js") || [])].sort()).toEqual(["cap_a", "cap_b"]);
    expect([...(index.get("supabase/migrations/20260101_a.sql") || [])]).toEqual(["cap_a"]);
  });
  it("indexes every focused_tests/golden_journey_tests entry", () => {
    const registry = fixtureRegistry();
    const index = buildTestIndex(registry);
    expect([...(index.get("src/lib/bar.test.ts") || [])]).toEqual(["cap_b"]);
    expect([...(index.get("src/lib/bar.golden-contract.test.ts") || [])]).toEqual(["cap_b"]);
  });
});

// --- Registry/mapper consistency against the real registry --------------

describe("registry changes trigger validation (mapper refuses to run against a broken registry)", () => {
  it("findMissingRegistryPaths returns empty for the real, current carson-protected-registry.json", () => {
    const registry = loadRegistry();
    const missing = findMissingRegistryPaths(registry);
    expect(missing).toEqual([]);
  });

  it("findMissingRegistryPaths reports a capability id and the exact missing path when a registry entry points nowhere", () => {
    const registry = {
      capabilities: [
        {
          id: "broken_cap",
          files_functions: ["api/this-file-does-not-exist-anywhere.js"],
          production_entry_points: [],
          shared_dependencies: [],
          db: { migrations: [], data_repairs: [] },
          focused_tests: [],
          golden_journey_tests: [],
        },
      ],
    };
    const missing = findMissingRegistryPaths(registry);
    expect(missing).toEqual(["broken_cap: api/this-file-does-not-exist-anywhere.js"]);
  });

  it("the real carson-impact-exclusions.json loads and every excluded path exists on disk", () => {
    const exclusions = loadExclusions();
    expect(exclusions.size).toBeGreaterThan(0);
    for (const relPath of exclusions) {
      expect(existsOnDisk(relPath)).toBe(true);
    }
  });
});

function existsOnDisk(relPath) {
  return existsSync(resolve(repoRoot, relPath));
}
