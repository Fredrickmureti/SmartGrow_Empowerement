# Invitation branding + Accept-Invitation URL — findings and fix plan

Status: investigation complete (read-only). No code or data changed yet.

Note on the first request ("connect my Supabase project"): the project is already
connected to the external Supabase project `xwxqunklduknceoryrha` (service-role key
stored). Nothing to do there.

## Verdict (current state, proven from the live system)

| Area | Verdict | Root cause |
| --- | --- | --- |
| Branding | ARCHITECTURALLY WRONG (config + fallback) | `platform_settings.platform_name = "BookFlow"` (seeded 2026-08-29); hardcoded fallback `"AccrualFlow"` in the email function. `support_email = support@bookflow.app` too. |
| Invitation URL | BROKEN | The email builds the link from `platform_settings.website_url`, which is `https://bookflow.app`. Every invite currently points to `https://bookflow.app/accept-invitation?token=...` — an unrelated domain. Fallback is `https://accrualflow.systems`. Separately, the app has **no production URL yet**: it is not published and has no custom domain. |
| Complete lifecycle | WORKING WITH DEFECTS | Token generation, validation, server-side routing (signup/login/auto_accept), atomic accept RPC, org/role/employee linkage and expiry all exist and look sound. The only breaks are the link destination and the branding text. |

## Evidence

- `supabase/functions/send-invitation-email/index.ts`
  - line 143: reads `platform_name` and `website_url` from `platform_settings`
  - line 150: `platformName = ... || "AccrualFlow"`
  - line 151: `websiteUrl = ... || "https://accrualflow.systems"`
  - line 156: `acceptUrl = ${websiteUrl}/accept-invitation?token=...`
- Live `platform_settings` rows: `platform_name = BookFlow`, `website_url = https://bookflow.app`,
  `support_email = support@bookflow.app`, `app_base_url = NULL`, `resend_from_name = Growastep Ventures`.
- `supabase/functions/_shared/email/deepLink.ts` `resolveAppBaseUrl()` is the existing
  canonical "application URL" mechanism (setting `app_base_url`, falls back to a Lovable URL).
  Notification emails already use it; the invitation function bypasses it and misuses the
  marketing `website_url` instead. That is the architectural error.
- Project URLs: preview only; published URL = none; custom domain = none.
- One live pending invitation exists (Smart Grow Empowerment, role internal, expires 2026-09-12)
  that was sent with the bookflow.app link.
- `/accept-invitation` is served by the legacy SPA route in `src/App.tsx:169` via the TanStack
  catch-all `src/routes/$.tsx`. Route works on any domain the app is deployed to.
- Token: `gen_random_uuid()` inside `upsert_organization_invitation` (unpredictable, 7-day expiry).
  `validate-invitation` decides signup / login / auto_accept / already_member server-side; accept
  goes through `accept_organization_invitation_atomic` (single transaction; role, employee link,
  permission groups, mark accepted). No client-supplied org or role.
- `supabase/functions/invite-platform-admin/index.ts:131` builds its own `siteUrl` from a
  different source — platform-admin invites only, recorded as residue (not in scope).

## Decision on the correct destination

`https://www.growastepventures.co.ke/` is the organisation's public website, not the
application. Invitation links must go to the deployed application. Since the app is unpublished,
the canonical application URL will be the stable published URL
`https://project--c03af08b-cceb-4b1f-bcdb-838bcf5bf3db.lovable.app` (a custom subdomain such as
`app.growastepventures.co.ke` can replace it later by changing one setting). Publishing is a
one-click action only you can perform; it is the single blocker for Tests B–D on a real domain.

## Changes

### 1. Data fix (migration on `platform_settings`)
- `platform_name` → `Smart Grow Empowerment`
- `website_url` → `https://www.growastepventures.co.ke` (marketing site only; no longer used for links)
- `support_email` → keep as-is unless you supply the real support address (flagged below)
- `app_base_url` → `https://project--c03af08b-cceb-4b1f-bcdb-838bcf5bf3db.lovable.app`

### 2. `send-invitation-email` function
- Build the accept link with the shared `resolveAppBaseUrl()` (the `app_base_url` setting), not
  `website_url`. Strip trailing slash; URL-encode the token.
- Remove the `AccrualFlow` / `accrualflow.systems` fallbacks. If `platform_name` is empty, fall
  back to the organisation name; never a foreign brand.
- Copy: when platform name equals the organisation name, render "join **Smart Grow Empowerment**
  as a Internal" (no "on X"); otherwise keep "join Org on Platform". Fix the "a Internal" article.
- Redeploy the function.

### 3. Architecture guard (test)
- Add a small test asserting `send-invitation-email` contains no `AccrualFlow`, `accrualflow`,
  `bookflow` literal and does not read `website_url` for the accept link.

### 4. Existing pending invitation
- Re-send the invitation to the pending invitee from the Team page after the fix (no manual DB
  edit; the same token stays valid until 2026-09-12).

## Verification (after you publish)
- A: invoke `send-invitation-email` for a controlled test invite → HTML contains
  "Smart Grow Empowerment", role, expiry; no BookFlow/AccrualFlow; `accept_url` on the published domain.
- B: open the returned URL → lands on `/accept-invitation`, token validated, no 404.
- C: new invitee (no account) → signup branch → accept → lands in the organisation.
- D: existing user → login/auto_accept branch → accept → correct org and role.
- E/F: run the existing Deno tests for `accept-invitation` (expired → `expired`, used → `already_accepted`).
- Security re-check: confirm auth Site URL / redirect allow-list in Supabase Auth includes the
  published domain so signup confirmation links (`emailRedirectTo = window.location.origin/auth/callback`) also work.

## Out of scope (recorded, not touched)
- `invite-platform-admin` separate site-URL source.
- BookFlow/AccrualFlow strings in docs, printing, currency contexts, older migrations and marketing text files.
- `support_email = support@bookflow.app` — needs your real address; not invented.

## Blockers needing you
1. Publish the app (Publish button) so a production URL exists.
2. Optional: confirm the real support email and whether you want a custom subdomain for the app.
