# S01 isolated verifier deployment proposal — NOT EXECUTED

Preparation is authorized; production-target deployment, shared Production changes,
promotion and release are not. This artifact is a temporary diagnostic derivative,
not the Carson application and never a release/rollback target for the live domain.

## Artifact boundary and offline recipe

Use a clean checkout of the approved final PR SHA. Rebuild the actual Vite browser
assets from that checkout using an explicitly approved public browser project URL
and appropriate public client key; do not inherit unknown local dotenv files. No
privileged key is needed for the browser build. Record the build command, SHA and
asset hashes privately without recording any key value. The intended browser URL
is not evidence of the old deployment's binding.

Invoke `node scripts/s01-verifier-artifact.mjs <fresh-output-directory> dist/assets
<approved-sha> <approved-project-ref>` from ra7etbal-v2. The packager validates HEAD
and a clean working tree, loads verifier source through `git show <sha>:<path>`,
refuses mixed/stale output and browser symlinks/conflicting project references.
It packages only the existing verifier module, a transport adapter, one Node.js
function at `/api/send-whatsapp-task`, and static JS assets from the browser build.
No app index, service worker, ordinary API functions, node_modules, environment
files, crons, webhook or provider modules are included. Hash every manifest-listed
file again immediately before deployment. The manifest is not itself a signature
or a substitute for independent build/source-origin evidence.

All paths except POST `/api/send-whatsapp-task` and GET/HEAD `/assets/<name>.js`
are 403. The adapter rejects ordinary/mixed bodies even with internal/session auth,
non-JSON, oversized/malformed requests, query paths, missing activation, wrong SHA,
and wrong project. Only the existing Ed25519 challenge verifier runs. Its only
external operation is nonce SET NX EX in the dedicated store. It does not call
Supabase, WhatsApp, AI, push, SMS, reminder, automation, webhook or payment code.

## Deployment-only configuration proposal

Target only ra7etbal-v2 / prj_f32jTzGmYS5m8pc2XU6E0Apw6Y1K and the approved final SHA.
Keep all shared project Production variables, domains and integrations untouched.
Use the supported prebuilt Build Output deployment path with Production target
and automatic custom-domain assignment disabled (`--prod --skip-domain` semantics).
Deployment identity/system Git SHA must be independently established: prebuilt
builds may lack Git system variables. If VERCEL_GIT_COMMIT_SHA cannot be bound to
the independently verified source/artifact SHA, STOP; do not label a caller-set
SHA alone provider-attested identity. Do not use an ordinary Git-source deploy:
that would include normal application functions and fail this containment gate.

Prepare only these per-deployment overrides, using a private in-memory deployment
request, never command-line secret values, .vc-config environment secrets, files,
logs or shared Production variable writes:

- S01_VERIFIER_ONLY=true and S01_VERIFICATION_ENABLED=true.
- S01_VERIFICATION_PUBLIC_KEY: existing approved Ed25519 public key; corresponding
  private signer remains on the operator Mac, never deployed.
- S01_NONCE_STORE_URL and S01_NONCE_STORE_TOKEN: canonical bindings to the dedicated
  S01 Free nonce resource, independently recheck isolation, no eviction/paid upgrade,
  and exclusive authorization. Staging connection alone does not establish suitability.
  Native KV aliases are deliberately not inherited by this transport adapter.

The function uses the target deployment's inherited SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY only inside the signed proof. Do not override these
with a convenient known key: that would attest the injected key rather than
which target credential was actually inherited. Other inherited credentials
may still exist in process memory; this mechanism proves execution containment,
not their absence. There is no ordinary/provider module or executable UI to use
them. If policy requires those credentials to be absent, STOP for an alternative
explicitly approved credential-isolation method; do not change shared settings.

## Required independent gates and proof

Before deployment, recheck all four automatic previews disabled, exact draft PR
SHA and green CI, target protection on unpromoted URLs, no deployment hooks/crons,
GitHub automation containment, dedicated nonce resource and authorized private
Supabase API Keys/API Key Secrets Read access. Obtain supported confirmation of
prebuilt-only artifact handling, per-deployment overrides, no promotion and immutable
Git/artifact association; missing evidence is a STOP, not an assumption.

After separately approved creation, inspect immutable ID, SHA/source association,
function inventory, routing, empty crons, effective protection and no live-domain
alias change before any authenticated request. Confirm unauthenticated requests
are stopped by Vercel protection. Access only exact immutable URL and inert assets;
never open the app UI. Use existing authorized Vercel access, never weaken protection.
Download/hash the browser assets; verify the compiled Supabase client binding
against pinned source and build provenance, not merely a substring.

Enter the scoped PAT through one hidden owner prompt, keep it and independently
retrieved project-specific privileged key in memory only. Issue fresh signed
60-second deployment-ID/SHA/project challenge. Compare response HMAC against the
key returned by authenticated Supabase admin API with privileged type metadata.
Record only match/mismatch, evidence IDs, SHA, artifact hashes and timestamps.
Never decode a JWT or infer issuing project from its unsigned claims, URL or hash.
A PASS proves this isolated deployment's effective server URL/key and compiled
browser assets, not the old deployment, production records, ordinary application
execution, or a subsequently rebuilt/full-app release.

## Rollback and release gates

Cancel/delete the exact temporary deployment and verify it is gone; preserve
live-domain assignments and previous live deployment. Do not promote this artifact.
No shared variables need restoration. Dedicated nonce markers expire; deletion
cannot undo external effects, hence ordinary execution must remain impossible.
If aliasing, unexpected functions, wrong nonce resource, missing protection, mismatched
proof or provider/data activity is observed, stop before proceeding; do not change
production to recover an unapproved operation.

Historical compatibility remains BLOCKED. Any read-only application-record assessment
or full Carson release must satisfy separate identity/authorization gates. This
proposal does not grant that access or close S01's production release decision.

Official references:
- https://vercel.com/docs/build-output-api/configuration
- https://vercel.com/docs/build-output-api/primitives
- https://vercel.com/docs/cli/deploy#skip-domain
- https://supabase.com/docs/reference/api/v1-get-project-api-keys
