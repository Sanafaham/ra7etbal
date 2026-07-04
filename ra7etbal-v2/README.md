# Ra7etBal v2

Clean rebuild of Ra7etBal. Deployed on Vercel with custom domain **https://ra7etbal.com**.

## Deployment note

Production is Vercel only. GitHub Pages is not the production deployment
surface for Ra7etBal; if GitHub Pages is enabled for this repository, treat it
as a legacy/static preview only. Do not use GitHub Pages for app routing,
serverless APIs, auth callbacks, WhatsApp confirmation links, or production
verification.

## Stack

- Vite 5 + React 18 + TypeScript
- Tailwind CSS v4 (`@tailwindcss/vite`)
- Zustand for state
- React Router v6
- Supabase JS v2 (same project + same tables as v1)
- Vercel serverless functions in `api/`

## Scripts

```bash
npm install
npm run dev        # local dev server
npm run build      # type-check + production build to dist/
npm run preview    # serve the built dist/
npm run typecheck  # type-check only
```

## Vercel setup (one-time)

1. New Vercel project.
2. Connect to the same GitHub repo.
3. **Root Directory** = `ra7etbal-v2`.
4. Framework preset = **Vite** (auto-detected).
5. Environment variables (copy from the v1 Vercel project):
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `VITE_SUPABASE_URL` (public)
   - `VITE_SUPABASE_ANON_KEY` (public)

After deploy, hit `/api/health` to verify the function runtime, then visit `/` to verify the SPA shell.

## Architecture rules (do not violate)

1. **Supabase is the only database.** No localStorage mirror of Supabase data.
2. **One Supabase client.** Imported from `src/lib/supabase.ts`. Never re-created.
3. **One auth listener.** Registered in `src/lib/session.ts` on module load.
4. **No `window.location.reload()` or `window.location.href = ...`.** Use React Router.
5. **Recovery mode is a Zustand flag**, not a URL or DOM check.
6. **All errors surface.** No silent catches.
7. **Mobile-first.** Test in iOS Safari before claiming done.

See `regression-checklist.md` for the per-step verification matrix.
