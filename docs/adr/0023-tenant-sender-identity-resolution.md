# ADR 0023 — Tenant Sender Identity Resolution

**Status:** Accepted — 2026-05-31
**Owners:** Platform / Notifications
**Relates to:** ADR 0010 (localization), ADR 0019 (workspace governance), `_shared/branding/getOrganizationBranding.ts`

## Context

Outbound email on the platform is split across many edge functions
(`send-document-email`, `send-notification-email`, `send-invitation-email`,
`notify-po-confirmed`, `vendor-portal-invite`, `send-admin-email`,
`send-platform-email`, `send-contact-message`, …). Several of them
historically resolved the `From:` header by reading
`platform_settings.resend_from_name` directly, which is the SaaS
platform's identity ("AccrualFlow"). Tenant-facing communications
therefore appeared to recipients as if they were sent by the platform
vendor rather than by the tenant's own business.

A shared helper (`getOrganizationBranding`) existed for **body** branding
but did not load the tenant's `email_display_name` / `email_reply_to`
overrides, and was not used by the From-line decision at all.

## Decision

1. **Single resolver, single source of truth.** All sender-identity
   decisions go through `supabase/functions/_shared/branding/resolveSenderIdentity.ts`,
   composed on top of `getOrganizationBranding`. The helper now also loads
   `businesses.email_display_name` and `businesses.email_reply_to`.

2. **Category → fallback matrix:**

   | Category | From-name resolution order |
   |---|---|
   | `tenant_document`, `system_notification`, `user_invitation`, `vendor_portal` | `email_display_name` → `legal_name` → `name` → `organizations.name` → (warn + platform) |
   | `platform_admin`, `support`, `auth` | `platform_settings.resend_from_name` |

3. **`send-email` is the only transport.** Tenant-facing edge functions
   MUST invoke `send-email` and pass `organization_id` (and ideally
   `business_id`) instead of calling Resend directly. `send-email`
   resolves the identity when the caller omits `from_name`. Direct
   `fetch("https://api.resend.com/emails", …)` is reserved for the
   transport itself.

4. **Reply-To:** for tenant categories, prefer
   `businesses.email_reply_to` → `businesses.email`. The platform
   `support_reply_to_email` is used only for `user_invitation` and
   `support` categories. Tenant categories never silently inherit a
   platform admin address.

5. **Auditability.** Every send logs `metadata.sender_source`
   (`business_display_name` / `business_legal_name` / `business_name` /
   `org_name` / `platform`) so regressions are visible in
   `platform_email_logs`.

6. **Guardrail.** Vitest
   `src/test/architecture/no-direct-platform-from-name.test.ts` fails the
   build if any edge function outside the allowlist (`send-email`,
   `send-admin-email`, `send-platform-email`, `send-contact-message`,
   `_shared/**`) references `resend_from_name`.

## Consequences

**Positive**

- A tenant's customers, vendors, and staff receive mail branded with the
  tenant's business identity across documents, notifications,
  invitations, PO confirmations, and vendor-portal invites.
- New edge functions get correct branding for free by routing through
  `send-email`.
- The architecture test prevents regressions.

**Negative / cost**

- Two extra DB reads per send (business + platform_settings) on the
  transport. Acceptable — both are cached-friendly and small.
- Edge functions that bypassed `send-email` had to be refactored.

## Out of scope

- SMS sender identity (Twilio sender id) — same pattern needed; tracked
  separately.
- Customer portal subdomain branding.
- In-app notification "actor name" display in the bell popover.
