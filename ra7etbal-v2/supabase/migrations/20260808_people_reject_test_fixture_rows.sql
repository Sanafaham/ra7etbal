/**
 * Prevention for the Canonical Staff Identity Cleanup incident.
 *
 * Root cause: the three duplicate "Christopher"/"Ghulam"/"Nasira" rows
 * (role = 'Test staff', no phone, no notes, no consent, created in a single
 * 7-second window on 2026-07-13) were never created through the app's only
 * production write path, createPerson() in src/lib/people.ts (a plain
 * .insert(draft) with no duplicate guard, called from PersonForm). Their
 * shape -- no phone/notes/consent, batch-created seconds apart -- is
 * inconsistent with anything that flow produces. They were written directly
 * via privileged database access during an earlier engineering/testing
 * session, bypassing the application entirely.
 *
 * A unique-name constraint is deliberately NOT used here: legitimate
 * distinct people (e.g. two staff both named "Ahmed") may share a first
 * name, and that must keep working.
 *
 * Instead this targets the actual, specific failure signature: a row whose
 * role is an obvious test/fixture marker. This is enforceable at the
 * database level against every write path, including direct/service-role
 * SQL access -- the exact vector that caused the incident and the one no
 * application-layer guard can reach.
 */

ALTER TABLE public.people
  ADD CONSTRAINT people_role_not_test_fixture_check
  CHECK (
    role IS NULL
    OR lower(btrim(role)) NOT IN ('test staff', 'test', 'fixture', 'test fixture', 'seed', 'dummy')
  );
