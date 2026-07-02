/**
 * Centralized "From" identity resolver for all outbound email channels.
 *
 * The platform has two distinct kinds of outbound mail:
 *
 *   1. Tenant-facing mail (documents, notifications, invitations, vendor
 *      portal, PO confirmations) — MUST be branded with the tenant's
 *      legal/business identity, never the SaaS platform name.
 *
 *   2. Platform-level mail (admin alerts, support, auth, contact-form) —
 *      branded with the SaaS platform identity. These are the ONLY
 *      categories permitted to fall back to `platform_settings.resend_from_name`.
 *
 * Every edge function that emits email should resolve sender identity via
 * this helper instead of re-reading `platform_settings.resend_from_name`
 * directly. See ADR 0023.
 */

import { getOrganizationBranding } from "./getOrganizationBranding.ts";

export type SenderCategory =
  | "tenant_document"
  | "system_notification"
  | "user_invitation"
  | "vendor_portal"
  | "platform_admin"
  | "support"
  | "auth";

export type SenderSource =
  | "business_display_name"
  | "business_legal_name"
  | "business_name"
  | "org_name"
  | "platform";

export interface ResolvedSenderIdentity {
  from_name: string;
  from_email: string;
  reply_to: string | null;
  business_id: string | null;
  source: SenderSource;
}

export interface ResolveSenderIdentityInput {
  organization_id?: string | null;
  business_id?: string | null;
  branch_id?: string | null;
  category: SenderCategory;
  /** Explicit override (e.g. caller already resolved). Wins when present. */
  explicit_from_name?: string | null;
  /** Explicit reply-to override. */
  explicit_reply_to?: string | null;
}

const PLATFORM_CATEGORIES: ReadonlySet<SenderCategory> = new Set([
  "platform_admin",
  "support",
  "auth",
]);

interface PlatformDefaults {
  from_name: string;
  from_email: string;
  support_reply_to: string | null;
  platform_admin_reply_to: string | null;
}

async function loadPlatformDefaults(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<PlatformDefaults> {
  const { data } = await supabase
    .from("platform_settings")
    .select("setting_key, setting_value")
    .in("setting_key", [
      "resend_from_name",
      "resend_from_email",
      "support_reply_to_email",
      "platform_admin_reply_to_email",
    ]);
  const m: Record<string, string> = {};
  for (const r of data ?? []) {
    if (r.setting_value) m[r.setting_key] = r.setting_value;
  }
  return {
    from_name: m.resend_from_name || "AccrualFlow",
    from_email: m.resend_from_email || "noreply@accrualflow.systems",
    support_reply_to: m.support_reply_to_email || null,
    platform_admin_reply_to: m.platform_admin_reply_to_email || null,
  };
}

function categoryReplyTo(
  category: SenderCategory,
  business_reply_to: string | null,
  defaults: PlatformDefaults,
): string | null {
  switch (category) {
    case "tenant_document":
    case "system_notification":
    case "vendor_portal":
      // Tenant-facing: prefer business reply-to, else no reply-to
      // (avoid leaking platform support address into tenant mail).
      return business_reply_to ?? null;
    case "user_invitation":
    case "support":
      return defaults.support_reply_to;
    case "platform_admin":
      return defaults.platform_admin_reply_to;
    case "auth":
    default:
      return null;
  }
}

/**
 * Resolve the sender identity for an outbound email.
 *
 * Order for tenant-facing categories:
 *   1. explicit_from_name (caller override)
 *   2. businesses.email_display_name
 *   3. businesses.legal_name
 *   4. businesses.name
 *   5. organizations.name      (only as a last-ditch tenant fallback)
 *   6. platform default        (only allowed for platform categories)
 */
export async function resolveSenderIdentity(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  input: ResolveSenderIdentityInput,
): Promise<ResolvedSenderIdentity> {
  const defaults = await loadPlatformDefaults(supabase);
  const { category } = input;

  // Platform categories: short-circuit to platform identity.
  if (PLATFORM_CATEGORIES.has(category)) {
    return {
      from_name: input.explicit_from_name?.trim() || defaults.from_name,
      from_email: defaults.from_email,
      reply_to:
        input.explicit_reply_to ??
        categoryReplyTo(category, null, defaults),
      business_id: null,
      source: input.explicit_from_name ? "business_display_name" : "platform",
    };
  }

  // Tenant-facing categories: resolve business branding.
  let source: SenderSource = "platform";
  let from_name = "";
  let business_id: string | null = null;
  let business_reply_to: string | null = null;

  if (input.organization_id || input.business_id) {
    const branding = await getOrganizationBranding(
      supabase,
      input.organization_id ?? "",
      input.business_id ?? null,
      input.branch_id ?? null,
    );
    if (branding) {
      business_id = branding.id ?? null;
      business_reply_to = branding.email_reply_to ?? branding.email ?? null;
      if (branding.email_display_name) {
        from_name = branding.email_display_name;
        source = "business_display_name";
      } else if (branding.legal_name) {
        from_name = branding.legal_name;
        source = "business_legal_name";
      } else if (branding.name) {
        from_name = branding.name;
        source = "business_name";
      }
    }
  }

  // Last-ditch tenant fallback: organization name.
  if (!from_name && input.organization_id) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", input.organization_id)
      .maybeSingle();
    if (org?.name) {
      from_name = org.name;
      source = "org_name";
    }
  }

  // Absolute final fallback. We do NOT want this to ever happen for
  // tenant-facing mail, but we must not crash if the tenant has no
  // business and no org name. Log it via source="platform" so the
  // architecture test / audit log can surface it.
  if (!from_name) {
    from_name = defaults.from_name;
    source = "platform";
  }

  // Caller override wins (but we still want the resolved business_id
  // and reply-to context).
  if (input.explicit_from_name?.trim()) {
    from_name = input.explicit_from_name.trim();
    source = "business_display_name";
  }

  return {
    from_name,
    from_email: defaults.from_email,
    reply_to:
      input.explicit_reply_to ??
      categoryReplyTo(category, business_reply_to, defaults),
    business_id,
    source,
  };
}
