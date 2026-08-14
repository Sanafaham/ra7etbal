import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  checkStateDocIntegrity,
  classifyStatus,
  parseSections,
  gitRoot,
  repoRoot,
} from "./state-doc-integrity.mjs";

// Phase 5 of the Carson Engineering Hardening Project. These tests prove the
// stale-state integrity checker's own correctness against small synthetic
// documents (fast, deterministic) plus, critically, the actual real-history
// commit pair that produced the historical stale-state regression this
// checker exists to catch (see the module's own header comment).

describe("classifyStatus", () => {
  it("classifies the file's real closed-class vocabulary as 'closed'", () => {
    expect(classifyStatus("CLOSED, PRODUCTION VERIFIED, PROTECTED")).toBe("closed");
    expect(classifyStatus("FORMALLY CLOSED, PRODUCTION VERIFIED")).toBe("closed");
    expect(classifyStatus("LOCKED")).toBe("closed");
    expect(classifyStatus("COMPLETE, PRODUCTION VERIFIED")).toBe("closed");
    expect(classifyStatus("production verified and protected")).toBe("closed");
  });

  it("classifies the file's real open-class vocabulary as 'open', even when closed-class words are also present", () => {
    expect(classifyStatus("PENDING")).toBe("open");
    expect(classifyStatus("PRODUCTION CORRECTION PENDING VERIFICATION")).toBe("open");
    expect(classifyStatus("OPEN RELIABILITY CAPABILITY")).toBe("open");
    expect(classifyStatus("reclassified UNVERIFIED / NOT CURRENTLY REPRODUCIBLE")).toBe("open");
  });

  it("classifies a heading with no recognized status vocabulary as 'neutral'", () => {
    expect(classifyStatus("")).toBe("neutral");
    expect(classifyStatus("Talk to Carson only")).toBe("neutral");
    expect(classifyStatus("remaining future work (not defects)")).toBe("neutral");
    expect(classifyStatus("SUPERSEDED, REMOVED FROM NAVIGATION (historical record)")).toBe("neutral");
  });
});

describe("parseSections", () => {
  it("splits a heading with two ' — ' separators on the LAST one, keeping the full title distinct", () => {
    const md = "### Carson Engineering Hardening Project — Phase 4 (real-PostgreSQL / RLS contract testing) — CLOSED, MERGED\nbody\n";
    const [section] = parseSections(md);
    expect(section.title).toBe("Carson Engineering Hardening Project — Phase 4 (real-PostgreSQL / RLS contract testing)");
    expect(section.statusSuffix).toBe("CLOSED, MERGED");
  });

  it("gives a heading with no ' — ' an empty status suffix", () => {
    const md = "## Product\nsome body text\n";
    const [section] = parseSections(md);
    expect(section.title).toBe("Product");
    expect(section.statusSuffix).toBe("");
  });

  it("scopes a section's body to end at the next heading of any level, not just the same level", () => {
    const md = [
      "### Section A — CLOSED",
      "line 1",
      "#### Subsection",
      "line 2",
      "### Section B — OPEN",
      "line 3",
    ].join("\n");
    const sections = parseSections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0].title).toBe("Section A");
    expect(sections[0].bodyLines).toEqual(["line 1"]);
  });
});

function md(strings) {
  return strings.join("\n") + "\n";
}

describe("checkStateDocIntegrity — synthetic counterfactual cases", () => {
  it("A. closed -> open without an explicit reopen marker MUST fail", () => {
    const base = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "It works.", ""]);
    const proposed = md(["### Feature X — PENDING", "It works.", ""]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { type: "regression", title: "Feature X", baseStatus: "CLOSED, PRODUCTION VERIFIED, PROTECTED", proposedStatus: "PENDING" },
    ]);
  });

  it("B. closed -> open WITH a valid, genuinely new explicit reopen marker MUST pass", () => {
    const base = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "It works.", ""]);
    const proposed = md([
      "### Feature X — PENDING",
      "**Correction (2026-08-15):** a real production regression was reproduced; reopening for a proper fix.",
      "It works.",
      "",
    ]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("B2. a carried-over marker that already existed in base (not genuinely new) does NOT excuse a fresh regression", () => {
    const base = md([
      "### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED",
      "**Correction (2026-01-01):** an older, unrelated correction note.",
      "It works.",
      "",
    ]);
    const proposed = md([
      "### Feature X — PENDING",
      "**Correction (2026-01-01):** an older, unrelated correction note.",
      "It works.",
      "",
    ]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(false);
  });

  it("a bare reopen-marker word with no date and no explanation must NOT suppress a regression", () => {
    const base = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "It works.", ""]);
    const proposed = md([
      "### Feature X — PENDING",
      "**Update**",
      "It works.",
      "",
    ]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(false);
  });

  it("a marker with a date but no real explanation after the colon must NOT suppress a regression", () => {
    const base = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "It works.", ""]);
    const proposed = md([
      "### Feature X — PENDING",
      "**Correction (2026-08-15):**",
      "It works.",
      "",
    ]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(false);
  });

  it("duplicate normalized headings in the proposed document are refused as ambiguous, never silently resolved to the last one", () => {
    const base = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "It works.", ""]);
    const proposed = md([
      "### Feature X — PENDING",
      "First, regressed copy.",
      "### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED",
      "Second, still-closed copy that would hide the first one behind it in a naive last-write-wins map.",
      "",
    ]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { type: "ambiguous", title: "Feature X", baseStatus: "CLOSED, PRODUCTION VERIFIED, PROTECTED" },
    ]);
  });

  it("C. normal wording/doc cleanup with status unchanged MUST pass", () => {
    const base = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "It works great.", ""]);
    const proposed = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "It works really well, rephrased for clarity.", ""]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(true);
  });

  it("D. adding a new section MUST pass", () => {
    const base = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "It works.", ""]);
    const proposed = md([
      "### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED",
      "It works.",
      "### Feature Y — PENDING",
      "Brand new, never existed before.",
      "",
    ]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(true);
  });

  it("E. deleting a protected/closed section accidentally MUST fail", () => {
    const base = md([
      "### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED",
      "It works.",
      "### Feature Y — OPEN",
      "Still open.",
      "",
    ]);
    const proposed = md(["### Feature Y — OPEN", "Still open.", ""]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { type: "disappeared", title: "Feature X", baseStatus: "CLOSED, PRODUCTION VERIFIED, PROTECTED" },
    ]);
  });

  it("deleting an OPEN (not closed-class) section is not itself flagged — only closed/protected disappearance is in scope", () => {
    const base = md(["### Feature Y — OPEN", "Still open.", ""]);
    const proposed = md([""]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(true);
  });

  it("an upgrade (open -> closed, or neutral -> closed) is never flagged", () => {
    const base = md(["### Feature X — PENDING", "In progress.", ""]);
    const proposed = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "Done.", ""]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(true);
  });

  it("closed -> neutral (status wording silently dropped, e.g. superseded with no reason) MUST also fail without a marker", () => {
    const base = md(["### Feature X — CLOSED, PRODUCTION VERIFIED, PROTECTED", "It works.", ""]);
    const proposed = md(["### Feature X — SUPERSEDED", "It works.", ""]);
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(false);
  });
});

describe("checkStateDocIntegrity — F. real historical stale-state regression reproduction", () => {
  // Loads the actual two git blobs of RA7ETBAL_STATE.md from the real
  // historical incident: commit 7b83a0089876ac784fbd3b9c98a0c5816581fb94
  // (whose own commit message is about an unrelated backfill fix, but whose
  // diff on RA7ETBAL_STATE.md silently reverted "Notifications Inbox V1"
  // from "CLOSED, PRODUCTION VERIFIED, PROTECTED" back to "PRODUCTION
  // CORRECTION PENDING VERIFICATION" and deleted the "Automation-run
  // assignee-confirmation synchronization" item — with no reopen marker
  // anywhere in the diff) against its direct parent. This is not a
  // synthetic reproduction — it is the literal historical commit pair,
  // loaded straight from git history.
  function loadBlob(ref) {
    return execFileSync("git", ["show", `${ref}:RA7ETBAL_STATE.md`], {
      cwd: gitRoot,
      encoding: "utf8",
    });
  }

  it("rejects the real historical regression commit against its real parent", () => {
    const base = loadBlob("7b83a0089876ac784fbd3b9c98a0c5816581fb94^");
    const proposed = loadBlob("7b83a0089876ac784fbd3b9c98a0c5816581fb94");
    const result = checkStateDocIntegrity(base, proposed);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.type === "regression" && f.title === "Notifications Inbox V1")).toBe(true);
  });

  it("the real follow-up fix commit that restored the closure passes cleanly against the regression commit (an upgrade, not flagged)", () => {
    // "docs: restore Notifications Inbox V1 closure, set next task to
    // identity gap" — the actual commit that fixed the historical
    // incident. Comparing regression-commit -> fix-commit is base=open,
    // proposed=closed, which is an upgrade and must never be flagged,
    // proving this checker does not block the very fix it exists to allow.
    const base = loadBlob("7b83a0089876ac784fbd3b9c98a0c5816581fb94");
    const proposedContent = loadBlob("110a155");
    const result = checkStateDocIntegrity(base, proposedContent);
    expect(result.ok).toBe(true);
  });
});

describe("CLI — invalid base ref must hard-fail, never silently pass", () => {
  const cliPath = "scripts/state-doc-integrity.mjs";

  it("exits non-zero and reports an error when --base does not resolve to a real commit", () => {
    let threw = false;
    try {
      execFileSync("node", [cliPath, "--base=this-ref-does-not-exist-anywhere-12345"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
    } catch (err) {
      threw = true;
      expect(err.status).not.toBe(0);
      expect(String(err.stderr)).toMatch(/does not resolve/i);
    }
    expect(threw).toBe(true);
  });

  it("passes cleanly when comparing the current worktree state against its own base (no regression expected)", () => {
    const out = execFileSync("node", [cliPath, "--base=origin/main"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out).toMatch(/state-doc-integrity: OK/);
  });
});
