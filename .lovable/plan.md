# PIN Login Environment Investigation

## Root cause

The exact `PIN login is not configured` response originates in `src/lib/pinLogin.functions.ts` before any database or authentication call. It is returned when the server-side Supabase configuration resolver cannot find the URL, service-role key, or publishable key.

The previous diagnosis that the service-role key was absent from local configuration was incorrect: the current local `.env` and `.env.local` contain it. The actual application defect was the configuration boundary. Vite loads dotenv files for build-time `import.meta.env` values, but the TanStack Start/Nitro request handler reads Node `process.env`; local server execution was not explicitly loading the dotenv files. In addition, the PIN resolver and the server Supabase client used different environment lookup rules. Lovable supplies server bindings automatically, which masked this defect. Vercel must supply server variables to its function runtime, and local SSR must load them explicitly.

This is primarily an application architecture/configuration problem, not a PIN-data, tenant, RLS, or Supabase-project problem. The PIN RPC and session exchange are reached only after the configuration check passes.

## Remediation

- Added an explicit server-only dotenv loader for `.env.local` followed by `.env`; deployment-provided `process.env` values always take precedence.
- Centralized the server URL, service-role key, and publishable-key resolution and made `supabaseAdmin` use that same resolver, eliminating the prior split-brain lookup.
- Kept the service-role key out of all `VITE_*` variables and browser code.
- Added the `dotenv` runtime dependency.

## Validation

- Focused server configuration tests pass: 2 tests, 2 passed.
- Targeted ESLint passed for the changed authentication/configuration modules.
- Production build completed successfully. Existing third-party `use client` bundler warnings remain.
- Generated browser assets were checked and do not contain the supplied service-role token.
- The complete real-user PIN login was not exercised from this workspace because it requires the user's PIN and live deployment access.

## Deployment requirements

For local SSR, keep `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`; never prefix the service-role key with `VITE_`.

For Vercel, configure those same three server variables for Production, Preview, and Development, plus the browser-safe `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_SUPABASE_PROJECT_ID`. Redeploy after changing variables. Confirm each deployment targets the intended Supabase project `xwxqunklduknceoryrha` and test password login plus PIN login in each environment.

The service-role key included in the user-provided message is exposed and must be rotated in Supabase, then replaced in local/Vercel server configuration.
