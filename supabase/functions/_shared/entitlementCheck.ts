/**
 * Shared Entitlement Check Utility for Edge Functions (v3)
 *
 * Unified source of truth: delegates to the SQL functions
 *   - check_org_app_access(org, app_id)
 *   - check_org_feature_access_v2(org, feature_key)  -- now resolves
 *       feature_key as app id OR via app_included_features fallback
 *   - check_org_app_installed(org, app_id)
 *
 * This helper exposes structured error codes so the frontend can show
 * accurate messages instead of a generic "not included in plan" toast.
 */

export type EntitlementCode =
  | "ORG_NOT_FOUND"
  | "ORG_SUSPENDED"
  | "SUBSCRIPTION_INACTIVE"
  | "APP_NOT_IN_PLAN"
  | "FEATURE_NOT_IN_PLAN"
  | "APP_NOT_INSTALLED"
  | "INTERNAL_ERROR";

export interface EntitlementResult {
  allowed: boolean;
  code?: EntitlementCode;
  reason?: string;
  orgStatus?: string;
}

interface OrgRow {
  subscription_status: string | null;
  subscription_ends_at: string | null;
  trial_ends_at: string | null;
  is_suspended: boolean | null;
}

async function loadOrg(supabase: any, orgId: string): Promise<OrgRow | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("subscription_status, subscription_ends_at, trial_ends_at, is_suspended")
    .eq("id", orgId)
    .maybeSingle();
  if (error || !data) return null;
  return data as OrgRow;
}

function classifySubscription(org: OrgRow): EntitlementResult | null {
  if (org.is_suspended) {
    return {
      allowed: false,
      code: "ORG_SUSPENDED",
      reason: "Organization is suspended",
      orgStatus: "suspended",
    };
  }
  const now = new Date();
  const isActive =
    org.subscription_status === null ||
    (org.subscription_status === "active" &&
      (!org.subscription_ends_at || new Date(org.subscription_ends_at) > now)) ||
    (org.subscription_status === "trial" &&
      (!org.trial_ends_at || new Date(org.trial_ends_at) > now));
  if (!isActive) {
    return {
      allowed: false,
      code: "SUBSCRIPTION_INACTIVE",
      reason: "Subscription is not active",
      orgStatus: org.subscription_status ?? undefined,
    };
  }
  return null;
}

/**
 * Check whether the organization's plan grants this APP (e.g. "hr", "banking", "etims").
 * Use this in edge functions that gate at the app level — most module gates.
 */
export async function checkAppEntitlement(
  supabase: any,
  orgId: string,
  appId: string,
  options: { requireInstalled?: boolean } = {},
): Promise<EntitlementResult> {
  if (!orgId) return { allowed: false, code: "ORG_NOT_FOUND", reason: "No organization specified" };
  if (!appId) return { allowed: false, code: "INTERNAL_ERROR", reason: "No app specified" };

  const org = await loadOrg(supabase, orgId);
  if (!org) return { allowed: false, code: "ORG_NOT_FOUND", reason: "Organization not found" };

  const subFail = classifySubscription(org);
  if (subFail) return subFail;

  const { data: hasAccess, error } = await supabase.rpc("check_org_app_access", {
    _org_id: orgId,
    _app_id: appId,
  });
  if (error) {
    console.error("check_org_app_access error:", error);
    return { allowed: false, code: "INTERNAL_ERROR", reason: "Error checking app access" };
  }
  if (!hasAccess) {
    return {
      allowed: false,
      code: "APP_NOT_IN_PLAN",
      reason: `The '${appId}' app is not included in your plan`,
    };
  }

  if (options.requireInstalled) {
    const { data: installed, error: instErr } = await supabase.rpc("check_org_app_installed", {
      _org_id: orgId,
      _app_id: appId,
    });
    if (instErr) {
      console.error("check_org_app_installed error:", instErr);
      return { allowed: false, code: "INTERNAL_ERROR", reason: "Error checking app installation" };
    }
    if (!installed) {
      return {
        allowed: false,
        code: "APP_NOT_INSTALLED",
        reason: `The '${appId}' app is not installed for this organization`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Check whether the organization has access to a specific FEATURE.
 * The unified SQL resolver also accepts app ids and resolves features
 * to their parent app via app_included_features, so legacy call sites
 * that pass an app id keep working correctly.
 */
export async function checkEntitlement(
  supabase: any,
  orgId: string,
  featureKey: string,
): Promise<EntitlementResult> {
  if (!orgId) return { allowed: false, code: "ORG_NOT_FOUND", reason: "No organization specified" };
  if (!featureKey) return { allowed: false, code: "INTERNAL_ERROR", reason: "No feature specified" };

  const org = await loadOrg(supabase, orgId);
  if (!org) return { allowed: false, code: "ORG_NOT_FOUND", reason: "Organization not found" };

  const subFail = classifySubscription(org);
  if (subFail) return subFail;

  const { data: hasAccess, error } = await supabase.rpc("check_org_feature_access_v2", {
    _org_id: orgId,
    _feature_key: featureKey,
  });
  if (error) {
    console.error("check_org_feature_access_v2 error:", error);
    return { allowed: false, code: "INTERNAL_ERROR", reason: "Error checking feature access" };
  }
  if (!hasAccess) {
    return {
      allowed: false,
      code: "FEATURE_NOT_IN_PLAN",
      reason: `'${featureKey}' is not included in your plan`,
    };
  }
  return { allowed: true };
}

/**
 * Subscription-only check (no feature/app check).
 */
export async function checkSubscriptionActive(
  supabase: any,
  orgId: string,
): Promise<EntitlementResult> {
  if (!orgId) return { allowed: false, code: "ORG_NOT_FOUND", reason: "No organization specified" };
  const org = await loadOrg(supabase, orgId);
  if (!org) return { allowed: false, code: "ORG_NOT_FOUND", reason: "Organization not found" };
  const subFail = classifySubscription(org);
  if (subFail) return subFail;
  return { allowed: true };
}

/**
 * 403 helper for entitlement failures.
 */
export function entitlementDeniedResponse(
  result: EntitlementResult,
  corsHeaders: Record<string, string>,
) {
  return new Response(
    JSON.stringify({
      error: result.reason || "Access denied",
      code: result.code || "ENTITLEMENT_DENIED",
      orgStatus: result.orgStatus,
    }),
    {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}
