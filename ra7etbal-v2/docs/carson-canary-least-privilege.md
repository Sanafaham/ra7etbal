# Carson production canary: least-privilege boundary

## Required information

The Supabase half of the canary needs only two derived invariants:

1. Group `whatsapp_health_state` by `phone_number_id` and count groups with
   more than one row. Return `canonical_binding_healthy` and
   `ambiguous_binding_count`.
2. For the last 30 days, count `whatsapp_deliveries` rows whose `person_id`
   is null, whose `automation_run_id` resolves through `automation_runs` to
   an `automations` row, and whose automation has a non-null `assignee_id`.
   Return `person_id_continuity_healthy`, `violating_row_count`, and the
   computed lower-bound timestamp.

No check needs a row id, user id, phone number, person name, message,
recipient, task description, automation title/instruction, or arbitrary
caller-selected time range/filter.

## Chosen interface

`public.carson_production_canary_health(text)` is a `STABLE`,
`SECURITY DEFINER` RPC with a fixed safe `search_path`, a five-second
statement timeout, no dynamic SQL, and no mutation. It returns exactly one
bounded aggregate row.

Its `NOLOGIN` owner has column-level `SELECT` only on the columns required by
the two fixed queries. Four SELECT-only RLS policies let that owner see the
rows needed for the global invariants. The owner cannot create objects and
has no INSERT, UPDATE, DELETE, TRUNCATE, role, database, replication,
superuser, or RLS-bypass privilege.

The RPC is revoked from `PUBLIC`, `authenticated`, and `service_role` and is
explicitly executable only by `anon`. This grant does not make the result
public: the function authenticates a 32–256-byte high-entropy token before
scanning any production table. The database stores only its SHA-256 digest
in `carson_canary_private.config`, a table with no API-role privileges.
GitHub stores the plaintext token as `CANARY_RPC_TOKEN`; its Supabase
publishable key and URL are non-secret repository variables. GitHub never
receives `SUPABASE_SERVICE_ROLE_KEY`.

### Rejected alternatives

- A custom PostgreSQL login was rejected. Every login inherits PostgreSQL's
  `PUBLIC` privileges and receives catalog/query surface beyond this single
  health result; preventing that safely would require broad privilege
  changes to the existing database.
- An authenticated Supabase service account was rejected. A stolen account
  session would inherit the application's broader `authenticated` grants.
- A new Vercel route was rejected because the Hobby deployment is already at
  its 12-function limit. Reusing a reminder/webhook route would mix this
  diagnostic with protected production behavior.
- A GitHub OIDC-to-Supabase client-credentials exchange is not currently
  provided by Supabase. Minting custom Supabase JWTs would require placing a
  signing secret in GitHub, a materially stronger credential than the
  canary token.

## Threat model

- **Unauthenticated invocation / enumeration:** callers without the token
  receive one generic authentication error. Missing configuration and a bad
  token are indistinguishable. Validation happens before production scans.
- **Information disclosure:** a valid caller receives two booleans, two
  counts, and the fixed-window timestamp only. No raw rows or identifiers.
- **SQL injection / search-path attacks:** the only input is used for a
  bounded hash comparison. There is no dynamic SQL. Every relation and hash
  function is schema-qualified; `search_path` is `pg_catalog`.
- **Privilege escalation / RLS bypass:** the function owner is `NOLOGIN`,
  `NOBYPASSRLS`, and column-scoped. Dedicated SELECT-only policies expose
  only the four source tables to that owner. The API caller acquires none of
  the owner's privileges outside the fixed function body.
- **Replay / credential theft:** the token is intentionally replayable for
  scheduled checks. Theft exposes only aggregate health and bounded query
  capacity. Rotation replaces one stored digest and one GitHub secret; no
  application or service-role credential rotates.
- **Log leakage:** the canary never logs request bodies. HTTP headers are
  redacted before errors are printed. GitHub masks `CANARY_RPC_TOKEN`.
- **Accidental mutation:** the SQL function contains no mutation and its
  owner lacks mutation privileges. Real-Postgres tests prove both properties
  and reject mutation counterfactuals.
- **Abuse / rate:** invalid tokens fail before table scans; valid calls have a
  five-second statement timeout and return one row. GitHub's workflow remains
  manual (`workflow_dispatch`) rather than externally scheduled.

## Vercel credential decision

`VERCEL_TOKEN` remains required. GitHub's repository deployment records are
stale for this repository, and a request to `www.ra7etbal.com` proves only
that the hostname responds from Vercel. Neither source proves all three
required facts together: exact deployed Git SHA, deployment `READY` state,
and canonical production alias assignment/no alias error. The Vercel
deployments API is the existing authoritative source for those facts. The
token should be scoped to the relevant Vercel account/team and used only by
this manually dispatched workflow.

## Manual production configuration

After the migration is deployed, an operator generates a new high-entropy
token outside chat and stores only its SHA-256 digest in
`carson_canary_private.config`. The plaintext is added to GitHub as the
`CANARY_RPC_TOKEN` secret. `VERCEL_TOKEN` is the other secret.

Repository variables are `VERCEL_PROJECT_ID`, `SUPABASE_URL`, and
`SUPABASE_PUBLISHABLE_KEY`; `VERCEL_TEAM_ID` is optional. No service-role key
is configured.
