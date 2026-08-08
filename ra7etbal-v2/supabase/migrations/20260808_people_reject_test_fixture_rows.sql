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

-- NOT VALID first: ADD CONSTRAINT without it takes an ACCESS EXCLUSIVE lock
-- for the duration of a full-table scan validating every existing row.
-- people is tiny today, but this is the correct pattern regardless of table
-- size, and costs nothing extra here since we validate immediately after.
ALTER TABLE public.people
  ADD CONSTRAINT people_role_not_test_fixture_check
  CHECK (
    role IS NULL
    OR lower(btrim(role)) NOT IN ('test staff', 'test', 'fixture', 'test fixture', 'seed', 'dummy')
  ) NOT VALID;

ALTER TABLE public.people
  VALIDATE CONSTRAINT people_role_not_test_fixture_check;
