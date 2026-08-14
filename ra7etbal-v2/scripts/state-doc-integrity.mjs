#!/usr/bin/env node
/**
 * Carson Engineering Hardening Project — Phase 5.
 *
 * RA7ETBAL_STATE.md stale-state / engineering-record integrity check.
 *
 * The historical incident this protects against (see RA7ETBAL_STATE.md's
 * own "Correction (2026-08-13)" note and commit 7b83a0089876ac784fbd3b9c98a0
 * c5816581fb94) was a normal PR whose branch was cut before an earlier
 * closure had landed on main, so its diff silently reverted
 * "Notifications Inbox V1 — CLOSED, PRODUCTION VERIFIED, PROTECTED" back to
 * "PRODUCTION CORRECTION PENDING VERIFICATION" and deleted an unrelated
 * already-recorded item, with no explanation anywhere in the diff. Nothing
 * caught it mechanically — it was found by a later manual reconciliation
 * pass. This script is the mechanical catch.
 *
 * It does NOT try to understand engineering truth. It only compares two
 * versions of RA7ETBAL_STATE.md structurally (heading -> status-suffix ->
 * body) and flags a status regression on a previously closed/protected
 * section that has no explicit, human-written reopen/correction marker in
 * its own body. This deliberately mirrors a convention the file already
 * uses on its own — see e.g. lines using "**Correction (date): ...**" and
 * "**Update (date): ...**" throughout RA7ETBAL_STATE.md's real history —
 * rather than inventing new syntax.
 *
 * Exported functions are pure (no fs/git access) so they're directly unit
 * testable — see state-doc-integrity.test.mjs. Only main()/loadRef() touch
 * git or process.argv, and only main() calls process.exit().
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, "..");
// The actual git repository root is one directory above repoRoot
// (ra7etbal-v2/ is a subdirectory of the repo that also contains
// RA7ETBAL_STATE.md, AGENTS.md, .github/ — same layout note as
// impact-map.mjs's identical comment).
export const gitRoot = resolve(repoRoot, "..");
export const STATE_DOC_RELATIVE_PATH = "RA7ETBAL_STATE.md";

// A heading "line" is any level 2-4 ATX heading ("##", "###", "####").
// Level 1 (the document title) and deeper (#####+) are not treated as
// status-bearing sections in this file's real usage.
const HEADING_RE = /^(#{2,4})\s+(.*)$/;

// The file's own real, observed status vocabulary — see the Phase 5
// discovery pass over RA7ETBAL_STATE.md's actual headings. Deliberately
// not inventing terminology the file doesn't use. Checked case-insensitively
// against the whole status-suffix string (the text after a heading's last
// " — "), so multi-word phrases like "PRODUCTION VERIFIED" match as
// substrings of a longer suffix like "CLOSED, PRODUCTION VERIFIED,
// PROTECTED".
//
// OPEN_KEYWORDS are checked first and win on conflict — this is what makes
// "PRODUCTION CORRECTION PENDING VERIFICATION" (the real historical
// regression text) classify as 'open' rather than 'closed' despite also
// containing "PRODUCTION" and "VERIFICATION": it contains "PENDING".
const OPEN_KEYWORDS = [
  "PENDING",
  "UNVERIFIED",
  "NOT CURRENTLY REPRODUCIBLE",
  "IN PROGRESS",
  "NOT STARTED",
  "TODO",
  "OPEN",
];
const CLOSED_KEYWORDS = [
  "CLOSED",
  "PROTECTED",
  "PRODUCTION VERIFIED",
  "FORMALLY CLOSED",
  "PERMANENTLY CLOSED",
  "PERMANENTLY LOCKED",
  "LOCKED",
  "COMPLETE",
  "DEPLOYED",
  "REGRESSION VERIFIED",
  "STABLE",
  "MERGED",
  "FIXED",
  "VERIFIED",
];

/** 'closed' | 'open' | 'neutral'. 'neutral' covers headings with no status
 * suffix at all (most headings in this file — plain topic titles) and
 * suffixes that use neither vocabulary (e.g. "SUPERSEDED", "future work
 * (not defects)") — deliberately NOT invented as their own class; a
 * previously-'closed' section moving to 'neutral' still counts as a
 * regression requiring an explicit marker, since silently losing "CLOSED"
 * wording is exactly the failure mode being guarded against. */
export function classifyStatus(statusSuffix) {
  const upper = String(statusSuffix || "").toUpperCase();
  if (OPEN_KEYWORDS.some((kw) => upper.includes(kw))) return "open";
  if (CLOSED_KEYWORDS.some((kw) => upper.includes(kw))) return "closed";
  return "neutral";
}

function normalizeAnchor(title) {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Splits a heading's text into {title, statusSuffix} on the LAST " — "
 * (em dash) in the line, not the first — some real headings in this file
 * legitimately contain more than one, e.g. "Carson Engineering Hardening
 * Project — Phase 4 (real-PostgreSQL / RLS contract testing) — CLOSED,
 * MERGED", where splitting on the first " — " would collapse every future
 * phase's heading onto the same "Carson Engineering Hardening Project"
 * anchor and compare unrelated phases against each other.
 */
function splitHeadingText(text) {
  const sep = " — ";
  const idx = text.lastIndexOf(sep);
  if (idx === -1) return { title: text.trim(), statusSuffix: "" };
  return {
    title: text.slice(0, idx).trim(),
    statusSuffix: text.slice(idx + sep.length).trim(),
  };
}

/**
 * Parses a markdown document into a flat list of sections, one per level
 * 2-4 heading. A section's body runs from just after its heading line up
 * to (not including) the next level 2-4 heading of any level — headings
 * are not nested for this purpose; each is its own independently
 * comparable unit, which is how a human reads "is the status text right
 * under this heading still what it was."
 */
export function parseSections(markdown) {
  const lines = markdown.split("\n");
  const headingLineIndexes = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) headingLineIndexes.push(i);
  }

  const sections = [];
  for (let h = 0; h < headingLineIndexes.length; h++) {
    const lineIdx = headingLineIndexes[h];
    const match = HEADING_RE.exec(lines[lineIdx]);
    const level = match[1].length;
    const { title, statusSuffix } = splitHeadingText(match[2]);
    const bodyStart = lineIdx + 1;
    const bodyEnd = h + 1 < headingLineIndexes.length ? headingLineIndexes[h + 1] : lines.length;
    const bodyLines = lines.slice(bodyStart, bodyEnd);
    sections.push({
      level,
      headingLine: lines[lineIdx],
      title,
      statusSuffix,
      anchor: normalizeAnchor(title),
      startLine: lineIdx + 1, // 1-indexed, for human-readable reporting
      bodyLines,
    });
  }
  return sections;
}

// An explicit, human-authored reopen/correction marker — the same
// convention RA7ETBAL_STATE.md's real history already uses on its own
// (e.g. "**Correction (2026-08-13): ...**", "**Update (2026-08-14): ...**").
// Not new syntax; codifying an existing practice.
const REOPEN_MARKER_RE = /^\*\*(Correction|Update|Reopened|Reopening)\b/i;

/**
 * True if `proposedSection`'s body contains a reopen/correction marker
 * line that is genuinely new — i.e. that exact line does not appear
 * anywhere in `baseContent` already. Checking "anywhere in baseContent"
 * rather than requiring a real line-diff keeps this a pure, dependency-free
 * comparison (no need to shell out to `git diff` or reimplement an LCS
 * diff) while still refusing to accept a marker that was simply carried
 * over unchanged from a base section that had nothing to do with this
 * regression.
 */
function sectionHasGenuineReopenMarker(proposedSection, baseContent) {
  for (const rawLine of proposedSection.bodyLines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (REOPEN_MARKER_RE.test(line) && !baseContent.includes(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Compares a base (main) and proposed (PR head) version of RA7ETBAL_STATE.md
 * and returns every detected stale-state regression.
 *
 * Two finding types:
 *   - "disappeared": a section that was 'closed'-class in base is entirely
 *     absent from proposed (matched by normalized heading title). Covers
 *     the "deleted the whole item" half of the historical incident.
 *   - "regression": a section that was 'closed'-class in base still exists
 *     in proposed under the same title, but its status suffix is no longer
 *     'closed'-class, and no genuine reopen/correction marker was added to
 *     its body. Covers the "reverted CLOSED -> PENDING" half.
 *
 * A regression finding is suppressed (not returned) when the proposed
 * section's body contains a genuine (not carried-over) "**Correction" /
 * "**Update" / "**Reopened" / "**Reopening" marker line — the file's own
 * existing convention for documenting an intentional status change. A
 * "disappeared" finding has no such escape hatch: if the heading is gone,
 * there is no body left to carry a marker, so the fix is to keep the
 * heading (even a very short one) and mark it explicitly, not to delete it
 * silently.
 */
export function checkStateDocIntegrity(baseContent, proposedContent) {
  const baseSections = parseSections(baseContent);
  const proposedSections = parseSections(proposedContent);
  const proposedByAnchor = new Map(proposedSections.map((s) => [s.anchor, s]));

  const findings = [];
  for (const baseSection of baseSections) {
    if (classifyStatus(baseSection.statusSuffix) !== "closed") continue;

    const proposedSection = proposedByAnchor.get(baseSection.anchor);
    if (!proposedSection) {
      findings.push({
        type: "disappeared",
        title: baseSection.title,
        baseStatus: baseSection.statusSuffix,
      });
      continue;
    }

    const proposedClass = classifyStatus(proposedSection.statusSuffix);
    if (proposedClass === "closed") continue;

    if (!sectionHasGenuineReopenMarker(proposedSection, baseContent)) {
      findings.push({
        type: "regression",
        title: baseSection.title,
        baseStatus: baseSection.statusSuffix,
        proposedStatus: proposedSection.statusSuffix || "(no status suffix)",
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

// --- CLI ----------------------------------------------------------------

function loadRef(ref, relativePath) {
  return execFileSync("git", ["show", `${ref}:${relativePath}`], {
    cwd: gitRoot,
    encoding: "utf8",
  });
}

function loadWorkingTree(absolutePath) {
  return execFileSync("cat", [absolutePath], { encoding: "utf8" });
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function formatFinding(f) {
  if (f.type === "disappeared") {
    return `DISAPPEARED: "${f.title}" was ${JSON.stringify(f.baseStatus)} on the base branch and no longer has a matching heading at all — if this is an intentional rename/removal, keep the heading and add an explicit "**Correction (date): ...**" or "**Update (date): ...**" paragraph explaining why, per RA7ETBAL_STATE.md's own existing convention.`;
  }
  return `REGRESSION: "${f.title}" was ${JSON.stringify(f.baseStatus)} on the base branch and is now ${JSON.stringify(f.proposedStatus)} with no explicit, new "**Correction (date): ...**" / "**Update (date): ...**" / "**Reopened" marker in its body — add one explaining the reason, or restore the closed status if this was unintentional.`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || "origin/main";

  let baseContent;
  try {
    baseContent = loadRef(base, STATE_DOC_RELATIVE_PATH);
  } catch (err) {
    console.log(
      `state-doc-integrity: ${STATE_DOC_RELATIVE_PATH} does not exist at ${base} (or ${base} is unresolvable) — nothing to compare against, treating as OK. (${err.message})`
    );
    process.exit(0);
  }

  let proposedContent;
  if (args.head) {
    proposedContent = loadRef(args.head, STATE_DOC_RELATIVE_PATH);
  } else {
    proposedContent = loadWorkingTree(resolve(gitRoot, STATE_DOC_RELATIVE_PATH));
  }

  const result = checkStateDocIntegrity(baseContent, proposedContent);

  if (!result.ok) {
    console.error(
      `state-doc-integrity: ${result.findings.length} stale-state regression(s) detected in ${STATE_DOC_RELATIVE_PATH}:`
    );
    for (const f of result.findings) console.error(`  - ${formatFinding(f)}`);
    process.exit(1);
  }

  console.log(
    `state-doc-integrity: OK (${parseSections(proposedContent).length} sections checked, no unexplained stale-state regression against ${base})`
  );
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
