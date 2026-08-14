#!/usr/bin/env node
/**
 * Carson Engineering Hardening Project — Phase 7.
 *
 * A small, safe post-deployment production canary. Merge success (Phases
 * 1-6) proves the code is correct against CI fixtures; it does not prove
 * the actually-deployed production system is healthy. This script closes
 * that gap for a deliberately small set of high-risk invariants that are
 * (a) safely observable read-only, from data that already exists, and
 * (b) known, from Phase 0's real incident history, to be able to pass CI
 * and still fail after deployment.
 *
 * HARD SAFETY CONTRACT — every check in this file is read-only. Nothing
 * here ever INSERTs, UPDATEs, DELETEs, or calls any Supabase RPC that
 * mutates state. It cannot send a WhatsApp message, push notification, or
 * create/alter a task, reminder, automation, or owner decision. It only
 * reads already-existing rows via Supabase's REST client (`.select()`)
 * and reads Vercel's own deployment metadata. See
 * carson-production-canary.test.mjs's "cannot mutate protected business
 * state" test, which statically scans this file for any Supabase mutation
 * method call and fails the test suite if one is ever added.
 *
 * WHY NOT A NEW /api ROUTE — this repository is on Vercel's Hobby plan,
 * which caps Serverless Functions at 12; api/*.js (excluding `_`-prefixed
 * shared modules and *.test.js) already contains exactly 12 route files.
 * Adding a 13th (e.g. a dedicated /api/canary health route) would risk
 * breaking the production deployment entirely. This canary instead runs
 * as an out-of-band script — a workflow_dispatch-only GitHub Actions job,
 * or by hand — against Vercel's and Supabase's own APIs directly, the
 * same pattern already established by scripts/carson-diagnose.mjs.
 *
 * Exported check functions are pure (take already-fetched data, return a
 * verdict) so they are directly unit-testable with fixtures — see
 * carson-production-canary.test.mjs. Only the fetch* functions and main()
 * touch the network/environment, and only main() calls process.exit().
 */

// --- Pure check functions -------------------------------------------------

/**
 * Deployment identity — the canary must be checking the deployment that is
 * actually serving production, never report PASS against a stale one.
 * `deployment` is the shape returned by Vercel's deployments API (and by
 * this repo's own Vercel MCP tool, which was used to design and manually
 * verify this check against real production during Phase 7).
 */
export function evaluateDeploymentIdentity({ expectedSha, deployment, canonicalAlias = "www.ra7etbal.com" }) {
  const findings = [];
  if (!deployment) {
    return { ok: false, findings: ["no deployment object returned — cannot verify identity"] };
  }
  if (deployment.readyState !== "READY") {
    findings.push(`deployment readyState is "${deployment.readyState}", expected "READY"`);
  }
  if (deployment.target !== "production") {
    findings.push(`deployment target is "${deployment.target}", expected "production"`);
  }
  if (deployment.aliasError) {
    findings.push(`deployment aliasError is set: ${JSON.stringify(deployment.aliasError)}`);
  }
  const actualSha = deployment.meta && deployment.meta.githubCommitSha;
  if (actualSha !== expectedSha) {
    findings.push(`deployed githubCommitSha "${actualSha}" does not match expected "${expectedSha}"`);
  }
  const aliases = Array.isArray(deployment.alias) ? deployment.alias : [];
  if (!aliases.includes(canonicalAlias)) {
    findings.push(`canonical production alias "${canonicalAlias}" is not in the deployment's alias list (${JSON.stringify(aliases)})`);
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Owner-WhatsApp canonical routing — exactly one legitimate account may be
 * bound to a given phone_number_id at any time (Phase 0's Incident 1
 * shape: a phantom/ambiguous binding silently broke inbound-owner trust
 * for a full day with zero error surface). `rows` is every raw row from
 * whatsapp_health_state (id, phone_number_id) — small table, safe to fetch
 * in full; grouping happens here, not in SQL, so this stays a plain
 * PostgREST `.select()` with no RPC/raw-SQL dependency.
 */
export function evaluateAmbiguousBindings(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const key = row.phone_number_id;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const ambiguous = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([phone_number_id, count]) => ({ phone_number_id, count }));
  return { ok: ambiguous.length === 0, ambiguous };
}

/**
 * The migration-established UNIQUE(phone_number_id) constraint that is the
 * actual enforcement mechanism behind evaluateAmbiguousBindings must still
 * exist in the catalog — proves the schema itself wasn't silently altered
 * or rolled back out from under the application-level check above. `rows`
 * is the result of a `pg_constraint` lookup for the exact constraint name.
 *
 * NOT currently called from the CLI's main(): PostgREST (Supabase's REST
 * API, which this canary deliberately limits itself to — see the module
 * header) has no route onto pg_catalog without a dedicated introspection
 * RPC, and creating one would itself be a production schema change, out
 * of Phase 7's scope. This exact constraint's existence is already
 * verified on every relevant PR by Phase 4's carson-tier1-db-contracts.yml
 * (a required merge gate since Phase 6), which is the correct place for
 * schema-catalog verification — kept here, tested, and exported so a
 * future phase can wire it into the live canary if an introspection RPC
 * is ever added.
 */
export function evaluateConstraintExists(rows, expectedName) {
  const found = (rows || []).some((r) => r.conname === expectedName);
  return { ok: found, findings: found ? [] : [`constraint "${expectedName}" not found in pg_constraint`] };
}

/**
 * Automation-runner Communication History identity/linkage — Phase 0's
 * Incidents 3/4 shape: whatsapp_deliveries rows created by the automation
 * runner (not a live conversation) silently missed person_id even when
 * the originating automation had a resolvable assignee, making them
 * permanently unreachable via Communication History. Fixed for automation
 * deliveries created after PR #253/#254/#257's backfill; this check only
 * looks at RECENT deliveries (created after `sinceIso`) — historical
 * pre-fix rows are a documented, permanent, accepted gap (see the real
 * backfill's own notes in RA7ETBAL_STATE.md), not something this canary
 * should ever flag as a live regression.
 *
 * `deliveryRows`: whatsapp_deliveries rows with automation_run_id set and
 * person_id null, created since sinceIso (id, created_at, automation_run_id).
 * `automationRunsById`: Map/object automation_run_id -> { automation_id }.
 * `automationsById`: Map/object automation_id -> { assignee_id }.
 */
export function evaluatePersonIdContinuity(deliveryRows, automationRunsById, automationsById) {
  const violations = [];
  for (const row of deliveryRows || []) {
    const run = automationRunsById instanceof Map ? automationRunsById.get(row.automation_run_id) : automationRunsById[row.automation_run_id];
    if (!run) continue;
    const automation = automationsById instanceof Map ? automationsById.get(run.automation_id) : automationsById[run.automation_id];
    if (!automation || !automation.assignee_id) continue; // no resolvable assignee — null person_id is correct, not a violation
    violations.push({ id: row.id, created_at: row.created_at, automation_run_id: row.automation_run_id });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Combines every check result into one report. `checks` is an array of
 * { name, capability, result: { ok, ... } }. `humanOnlyBoundaries` documents
 * capabilities this canary deliberately does NOT automate, with the honest
 * reason why — reported truthfully every run, never silently omitted, and
 * never counted as a PASS.
 */
export function buildCanaryReport({ deploymentSha, checks, humanOnlyBoundaries }) {
  const failures = checks.filter((c) => !c.result.ok);
  return {
    timestamp: new Date().toISOString(),
    deploymentSha,
    ok: failures.length === 0,
    checks: checks.map((c) => ({ name: c.name, capability: c.capability, ok: c.result.ok })),
    failures: failures.map((c) => ({ name: c.name, capability: c.capability, detail: c.result })),
    humanOnlyBoundaries: humanOnlyBoundaries || [],
  };
}

// Genuinely classification-C boundaries only — a capability where no safe
// automated check (canary or otherwise) can honestly prove the behavior,
// because it terminates in a real device/human interaction. Classification
// B capabilities (an existing check elsewhere already covers the risk, so
// building a redundant canary isn't justified) are NOT listed here — they
// are documented in carson-protected-registry.json's production_canary
// field instead, since "an existing check already covers this" is not a
// human-testing boundary and doesn't belong in the same bucket as one.
export const HUMAN_ONLY_BOUNDARIES = [
  {
    capability: "notifications_inbox_durable_lifecycle",
    reason:
      "Genuine end-to-end proof (owner taps a push, sees the exact reminder card, existing actions still present) requires a real device and a real human tap — already the established acceptance-test pattern for this capability (see RA7ETBAL_STATE.md's Notifications Inbox V1 entries). Automating it would mean fabricating a fake owner interaction with no real device involved, which would not actually prove device-stage delivery.",
  },
];

// --- CLI (network access; kept separate from the pure checks above) ------

const VERCEL_API = "https://api.vercel.com";

function redactAuthHeader(headers) {
  const copy = { ...headers };
  if (copy.Authorization) copy.Authorization = "[redacted]";
  return copy;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    // Never include request headers (which carry the bearer token) in a
    // thrown error message that might end up in a CI log.
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText} (headers redacted: ${JSON.stringify(redactAuthHeader(options?.headers || {}))})`);
  }
  return res.json();
}

async function fetchLatestProductionDeployment({ vercelToken, projectId, teamId }) {
  const url = new URL(`${VERCEL_API}/v6/deployments`);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("target", "production");
  url.searchParams.set("limit", "1");
  if (teamId) url.searchParams.set("teamId", teamId);
  const data = await fetchJson(url.toString(), {
    headers: { Authorization: `Bearer ${vercelToken}` },
  });
  const summary = data.deployments && data.deployments[0];
  if (!summary) return null;
  // The list endpoint's summary shape is missing some fields (aliasError,
  // full alias list) that evaluateDeploymentIdentity needs — fetch the full
  // deployment by id, same as the Vercel MCP's get_deployment tool used to
  // manually verify this check during Phase 7 design.
  const full = await fetchJson(`${VERCEL_API}/v13/deployments/${summary.uid}${teamId ? `?teamId=${teamId}` : ""}`, {
    headers: { Authorization: `Bearer ${vercelToken}` },
  });
  return full;
}

async function fetchSupabaseTable(supabaseUrl, serviceRoleKey, path) {
  const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`;
  return fetchJson(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`carson-production-canary: missing required environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const vercelToken = requireEnv("VERCEL_TOKEN");
  const vercelProjectId = requireEnv("VERCEL_PROJECT_ID");
  const vercelTeamId = process.env.VERCEL_TEAM_ID || "";
  const expectedSha = requireEnv("EXPECTED_PRODUCTION_SHA");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const deployment = await fetchLatestProductionDeployment({
    vercelToken,
    projectId: vercelProjectId,
    teamId: vercelTeamId,
  });
  const deploymentCheck = evaluateDeploymentIdentity({ expectedSha, deployment });

  const bindingRows = await fetchSupabaseTable(supabaseUrl, supabaseServiceRoleKey, "whatsapp_health_state?select=phone_number_id");
  const bindingCheck = evaluateAmbiguousBindings(bindingRows);

  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const deliveryRows = await fetchSupabaseTable(
    supabaseUrl,
    supabaseServiceRoleKey,
    `whatsapp_deliveries?select=id,created_at,automation_run_id&person_id=is.null&automation_run_id=not.is.null&created_at=gt.${sinceIso}`
  );
  const runIds = [...new Set(deliveryRows.map((r) => r.automation_run_id))];
  const automationRuns = runIds.length
    ? await fetchSupabaseTable(supabaseUrl, supabaseServiceRoleKey, `automation_runs?select=id,automation_id&id=in.(${runIds.join(",")})`)
    : [];
  const automationRunsById = new Map(automationRuns.map((r) => [r.id, r]));
  const automationIds = [...new Set(automationRuns.map((r) => r.automation_id))];
  const automations = automationIds.length
    ? await fetchSupabaseTable(supabaseUrl, supabaseServiceRoleKey, `automations?select=id,assignee_id&id=in.(${automationIds.join(",")})`)
    : [];
  const automationsById = new Map(automations.map((a) => [a.id, a]));
  const continuityCheck = evaluatePersonIdContinuity(deliveryRows, automationRunsById, automationsById);

  const report = buildCanaryReport({
    deploymentSha: expectedSha,
    checks: [
      { name: "deployment_identity", capability: "hosting_operations", result: deploymentCheck },
      { name: "whatsapp_canonical_binding_ambiguity", capability: "owner_whatsapp_canonical_routing", result: bindingCheck },
      { name: "automation_runner_person_id_continuity", capability: "whatsapp_delivery_person_identity_continuity", result: continuityCheck },
    ],
    humanOnlyBoundaries: HUMAN_ONLY_BOUNDARIES,
  });

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`carson-production-canary: unexpected error: ${err.message}`);
    process.exit(1);
  });
}
