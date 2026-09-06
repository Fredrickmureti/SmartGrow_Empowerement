# PIN login outside Lovable Preview — findings, fix, validation

## Root cause (confirmed by tracing, not assumption)

- The string "PIN login is not configured" exists in exactly one place:
  `src/lib/pinLogin.functions.ts`, in the server-side `pinLogin` handler.
- It is returned when any of three server values is absent at request time:
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_ANON_KEY`.
- The repo's `.env` supplies only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_PROJECT_ID` and their `VITE_` twins. It contains **no**
  service-role key. That key is present in the Lovable runtime because Lovable
  injects it; nothing supplies it locally or on Vercel.
- Therefore the failure is a missing, implicitly-provided server secret — not a
  database, RLS, tenant, PIN-data, or build-vs-runtime evaluation problem. All
  values were already read inside the handler (runtime), which is correct.

Category: deployment/configuration problem, compounded by an application
problem — a single opaque message that named none of the three requirements.

Also checked and found sound: the browser Supabase client resolves `VITE_*`
first with a server fallback; the preview session-sharing helper
(`src/integrations/supabase/previewAuthStorage.ts`) falls back to normal browser
storage on any non-Lovable host, so no Lovable-only client dependency remains.

## Changes made

1. `src/lib/serverSupabaseConfig.server.ts` (new) — one server-only resolver for
   the Supabase URL, publishable key and service-role key. Reads `process.env`
   at call time, reports exactly which names are missing, and never logs or
   returns a secret value.
2. `src/lib/pinLogin.functions.ts` — uses that resolver. On missing config it
   logs the full actionable detail server-side and returns
   "PIN login is not configured: missing SUPABASE_SERVICE_ROLE_KEY" (or whichever
   names are missing). No check bypassed, nothing hardcoded, no branching per
   environment.
3. `.env.example` (new) and the README "Environment Configuration" section — the
   complete required-variable list, marking the service-role key as server-only
   and secret.

## Validation performed

- Typecheck clean.
- Resolver with the Lovable environment: no missing names, config resolved.
- Resolver with the service-role key removed: reports
  `SUPABASE_SERVICE_ROLE_KEY` and produces the actionable message.
- Using only keys resolved through the new module against the live backend:
  `verify_pin_full` (service role) returned `{"success":false,"error":"Invalid
  credentials"}` for an unknown email, and `check_pin_status` (publishable key)
  succeeded — so both credentials are valid and the flow past the config gate is
  intact in Preview.
- Login page renders and the password path is untouched.

Not verifiable from here: an actual successful PIN sign-in (requires a real
user's PIN, and repeated wrong attempts trigger their lockout), and Vercel
Preview/Production, which need the variables below to be set first.

## Remaining deployment configuration (must be done in Vercel)

Set for **Production, Preview and Development**:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`

Service-role key: Supabase Dashboard → Project Settings → API. Never give it a
`VITE_` prefix — `VITE_` variables are bundled into the browser. Locally, copy
`.env.example` to `.env.local` with the same values.
