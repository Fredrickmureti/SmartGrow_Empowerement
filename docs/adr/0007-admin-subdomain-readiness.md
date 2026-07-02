# ADR 0007: Admin routes are subdomain-ready (path now, host later)

Status: Accepted (2026-04-24)

## Context

The platform-admin console lives under `/admin-management/*` (path-based)
rather than `admin.<host>` (host-based). The operator asked whether we
should restructure to a subdomain so they can later point
`admin.accrualflow.systems` at the admin console without showing tenant
auth screens.

## Decision

Keep path-based routing today. The current shape is already
subdomain-ready and will not require a code restructure when the operator
adds the CNAME.

### Why path-based is fine today

1. React Router matches `/admin-management/*` regardless of host — the
   same code serves both `app.example.com/admin-management/login` and
   `admin.example.com/admin-management/login`.
2. The persona-aware sign-out helper (`signOutAndRedirect`) already
   inspects the current pathname and routes admins to
   `/admin-management/login` instead of the tenant `/login`.
3. `RedirectIfAuthenticated` + `resolvePostLoginDestination` already send
   platform admins to `/admin-management` regardless of which login form
   they used.

### What changes when we add `admin.<host>`

Three small things, no code rewrite:

1. **Hosting rule**: rewrite `/` on the admin host to
   `/admin-management/login` (Vercel/Cloudflare/Caddy one-liner). This
   prevents an operator typing `admin.example.com` from ever seeing the
   tenant marketing page.
2. **Cookie domain for SSO**: set `Set-Cookie: …; Domain=.example.com`
   on Supabase auth cookies so a session on `app.example.com` is shared
   with `admin.example.com`. Configure in the Supabase project's auth
   cookie settings — no app-code change.
3. **CORS / allowed origins**: add `admin.example.com` to the Supabase
   auth project's Site URL allow-list and to any edge-function CORS
   `Access-Control-Allow-Origin` checks (we currently use `*`, so no
   change needed).

## Consequences

- We avoid a multi-week subdomain migration in flight while the platform
  is still being hardened.
- The "tenant /login showing on the admin host" risk is eliminated by
  the hosting rewrite, which is a one-line config — not a code change.
- No tenant signup screen is reachable from any admin route or admin
  email. This is enforced by the architecture test
  `src/test/architecture/no-tenant-signup-in-admin.test.ts`.

## Related

- ADR-0004: Platform admins are not tenants.
- ADR-0005: Fat edge functions (relevant when we hit the 100-function
  ceiling — `provider-run` already uses the fat-function pattern for
  scheduled batches).
