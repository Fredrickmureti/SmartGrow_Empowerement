# PIN login fails outside Lovable Preview — investigation and fix

## What I traced

Login screen (`src/components/auth/EnhancedLoginForm.tsx`, line 182) calls the
server-side `pinLogin` function in `src/lib/pinLogin.functions.ts`. That
function is the only place in the whole project where the text
"PIN login is not configured" exists (line 46).

It appears when **any** of three server-side values is missing at the moment the
function runs:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEY`

Everything after that check (PIN verification in the database, the magic-link
exchange, session creation) is environment-independent — it never runs, so the
failure is not a database, RLS, tenant, or PIN-data problem.

## Root cause (verified, not assumed)

The project's checked-in `.env` contains only `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_ID` and their `VITE_` twins. It
does **not** contain a service-role key. I confirmed the service-role key is
present in the Lovable runtime environment but supplied by Lovable itself, not
by the repo.

So: PIN login works in Preview because Lovable injects the service-role key at
runtime, and fails locally and on Vercel because nothing supplies it there.
The one required value is invisible in the codebase and the error message names
none of the three, which is why the cause was unclear.

Classification: primarily a **deployment/configuration problem** (the required
server secret is only ever provided implicitly by Lovable), compounded by an
**application problem** — the check fails with one vague message instead of
naming what is missing, and the app has no documented list of required server
variables.

Secondary findings, both fine as-is: the browser Supabase client falls back
correctly between `VITE_*` and server variables, and the preview-only session
sharing helper (`previewAuthStorage.ts`) already falls back to normal browser
storage on any non-Lovable host — so there is no Lovable-only dependency in the
client login path.

## What I will change

1. **Make the requirement explicit and self-describing.** Replace the single
   vague message with a check that names exactly which server values are
   missing, e.g. "PIN login is not configured: missing SUPABASE_SERVICE_ROLE_KEY".
   The message is logged in full on the server; the browser gets an actionable
   but non-sensitive version. No check is bypassed, nothing is hardcoded, and no
   secret is exposed to the browser.
2. **One shared place that resolves server Supabase configuration**, used by
   PIN login, so the same clear failure and the same variable names apply
   everywhere instead of each file inventing its own fallbacks.
3. **`.env.example` + a short "Required environment variables" section in
   README**, listing every value each environment needs and marking the
   service-role key as server-only and secret. This is the piece that makes
   local and Vercel runs work without depending on Lovable.

## What you will need to do on Vercel (I cannot set this for you)

Add these to Vercel for **Production, Preview and Development**:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`

The service-role key comes from the Supabase dashboard (Project Settings, API).
Keep it as a plain server variable — never with a `VITE_` prefix, since anything
`VITE_` is shipped to the browser. For local runs, put the same values in
`.env.local` (already ignored by version control).

## Validation

- Confirm the flow still logs in inside Preview.
- Simulate a missing service-role key and confirm the error now names it.
- Confirm the built app reads configuration at request time, so the same build
  works in Vercel Preview and Production once the variables are set.
- Confirm existing email/password and other sign-in paths are untouched.
- After you add the Vercel variables, log in on the deployment to close it out.

Full PIN login on Vercel and local cannot be verified from here until those
variables are set; I will state that plainly rather than claim it works.
