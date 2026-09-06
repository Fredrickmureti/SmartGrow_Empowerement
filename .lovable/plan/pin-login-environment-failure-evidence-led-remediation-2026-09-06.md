# PIN login environment failure — evidence-led remediation

## Confirmed findings

- The exact message comes only from the server-side PIN handler. It is returned
  before any PIN or session request when server configuration is incomplete.
- The login sequence is: login form → server PIN handler → `verify_pin_full`
  database function → privileged magic-link creation → token exchange → browser
  session installation.
- The privileged credential is not an optional PIN feature flag. It is required
  for both the service-only PIN verification function and session creation. The
  six values supplied include the URL, project ID, and public key twice (browser
  and server forms), but do **not** include `SUPABASE_SERVICE_ROLE_KEY`.
- The Lovable runtime currently has all three server bindings, including the
  service-role key. The repository `.env` has the URL and public key but not the
  service-role key. This exactly accounts for Preview succeeding and a plain
  local run failing.
- The app configuration and database configuration both reference project
  `xwxqunklduknceoryrha`. This rules out a different-project mismatch in the
  checked configuration.
- The live database contains the expected PIN functions and one usable,
  enabled PIN record. `check_pin_status` is callable publicly while
  `verify_pin_full` is not; this is intentional. Therefore PIN data, the RPC,
  and public access rules do not explain the configuration error, which occurs
  before those calls.
- Browser variables are read through `VITE_SUPABASE_*`; server values are read
  at request time through `process.env`. There is no evidence of a build-time
  evaluation bug or a Lovable-only browser dependency in this path.

**Root-cause classification:** deployment configuration is the direct cause.
Lovable injects a privileged server binding that local and Vercel environments
must receive explicitly. The previous vague error was an application
observability problem; changing it to name the missing binding exposed the real
configuration gap rather than creating it.

## Remediation

1. Rebind the connected backend credentials in Lovable and verify that the
   runtime binding belongs to project `xwxqunklduknceoryrha`; do not rotate or
   expose the credential.
2. Keep PIN verification and session minting server-only. Do not weaken RPC
   grants, move the privileged key into a `VITE_` variable, bypass checks, or
   hardcode a project/key.
3. Consolidate the PIN handler on the generated server-only backend client where
   practical, while retaining request-time configuration reads and a safe,
   actionable failure. Add focused tests for missing configuration and the
   successful handoff from PIN verification to session creation.
4. Keep the documented environment contract explicit. Local execution must use
   `.env.local` containing `SUPABASE_SERVICE_ROLE_KEY`; the checked-in `.env`
   must never contain that secret.
5. In Vercel, confirm the exact name `SUPABASE_SERVICE_ROLE_KEY` exists for
   Production, Preview, and Development. The values shown in the report do not
   establish that. Redeploy after adding/changing it because an existing
   deployment does not acquire newly saved variables retroactively.

## Validation and handoff

- Verify the server reports all required bindings as present without printing
  their values, and that the URL/project reference is the intended backend.
- Exercise the Preview and local server paths with a non-user test request to
  prove they pass configuration and reach `verify_pin_full` without risking the
  real user's PIN lockout.
- Run targeted tests and confirm password login remains unchanged.
- A successful real PIN login requires the owner to test with their PIN. Vercel
  Preview and Production can only be declared working after the secret is
  confirmed in each Vercel environment, a new deployment is created, and that
  deployment is tested. Record those outcomes here rather than claiming access
  this workspace does not have.

## Required environment contract

Server-only in every runtime:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_PROJECT_ID`
- `SUPABASE_SERVICE_ROLE_KEY` — secret; never prefix with `VITE_`

Browser-safe build values:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_PROJECT_ID`
