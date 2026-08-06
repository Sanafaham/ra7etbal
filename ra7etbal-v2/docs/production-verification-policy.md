# Production verification policy

Permanent engineering standard, adopted 2026-08-06 (Workstream 3). This
governs how any feature is verified against real, live behavior before it
is trusted as production-correct — the same question kept recurring across
workstreams until it was documented once, here.

## Why this exists

Workstream 3's PR #187 could not be verified against its Vercel preview
deployment for the WhatsApp-reply-driven half of the change. The owner's
real WhatsApp "Yes" reply was delivered by Meta to whatever URL is
registered in the Meta Business dashboard as the webhook endpoint —
`www.ra7etbal.com` (production) — regardless of which URL a person had open
in a browser. Runtime logs confirmed the reply was processed by `main`
(pre-WS3), not by the PR's preview deployment, which is why the resulting
staff-facing message still showed the old copy.

Two ways around this were considered and rejected as unsafe defaults:

- **Repoint the live Meta webhook to the preview URL for the test window.**
  Rejected: this disconnects real production WhatsApp traffic for every
  household using the app during the window, and preview URLs are ephemeral
  (new one per commit), so this cannot be a routine step.
- **Send a synthetic webhook payload directly to the preview URL,
  bypassing Meta.** Rejected: `api/whatsapp-webhook.js` verifies Meta's
  `X-Hub-Signature-256` HMAC against `META_APP_SECRET` before processing
  anything (`verifyMetaSignature`, `api/whatsapp-webhook.js:158`) — a
  synthetic payload without a valid signature is rejected with 401, and
  computing a valid one requires handling the real app secret, which should
  never be pasted into an agent session.

## The rule

**1. Browser/app-driven features** (any action reached by a person clicking
something in the Ra7etBal web app — the Alternative Review UI, the
in-app owner-escalation decision page at `/confirm?task={token}`, or any
other authenticated in-app action) —

> Verify on the PR's Vercel preview deployment before merge.

These go straight to whatever URL is open in the browser, so the preview
deployment genuinely exercises the PR's code with no routing ambiguity.

**2. Webhook-driven features** (any action reached via an inbound webhook
from a third party — WhatsApp inbound messages, WhatsApp delivery-status
callbacks, or any future webhook integration) —

> Verify on a dedicated staging webhook environment before merge.

Target architecture (not yet built — see below):
- A dedicated staging WhatsApp Business account, separate from the real
  household number(s) production serves.
- A dedicated Meta App for that staging account, with its own app secret.
- A dedicated staging webhook endpoint, permanently configured in that
  Meta App's dashboard to point at a stable staging deployment (not an
  ephemeral per-PR preview URL).
- A dedicated staging environment (Vercel deployment + database) that PRs
  can be pointed at for webhook-driven verification without ever touching
  real production traffic or data.

**3. Production** — once 1 and 2 have passed, merging and deploying gets a
**final smoke test only** in production. Production is confirmation that
the already-verified behavior deployed correctly, not the primary place
verification happens.

## Until the staging environment exists

Rule 2 is the target, not yet reality — no dedicated staging WhatsApp
account/Meta App/webhook/environment exists as of this writing. Any PR
touching a webhook-driven path must, until that infrastructure is built:

- State explicitly, in the PR description and in `RA7ETBAL_STATE.md`, that
  webhook-driven verification is happening as a **documented temporary
  exception**, not the standard — naming which specific behavior couldn't
  be preview-verified and why.
- Gate merge quality on the mandatory automated test suite
  (`npm run test:carson-protected`) as the pre-merge bar, since preview
  verification isn't available for that part of the change.
- Verify live in production immediately after merge/deploy, with a
  specific, ready rollback command (`git revert <merge-sha>` + redeploy)
  identified *before* merging, not improvised after a failure is found.

This is a stopgap, not a replacement for building the staging environment.
Do not let repeated use of this exception become the de facto standard —
if webhook-driven changes become frequent, that is the signal to build the
staging environment described above rather than keep documenting more
exceptions.
