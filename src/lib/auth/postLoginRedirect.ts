/**
 * Post-login redirect resolver.
 *
 * Single source of truth for "where should this authenticated user land?".
 *
 * Account model (do not collapse these):
 *   - auth.users         → identity (email/password)
 *   - platform_admins    → SaaS-level operator/owner (runs the platform)
 *   - user_roles         → tenant/customer workspace membership (uses the product)
 *
 * A single email may have BOTH (e.g. the SaaS owner who also runs a real
 * business inside the product), or only one. We must never force a platform
 * admin through the customer onboarding wizard just because they have no
 * tenant workspace — that would conflate the SaaS operator with a customer.
 */
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export interface PostLoginContext {
  user: User | null;
  /**
   * Optional explicit "return to" URL captured before login (e.g. router state).
   * Honored only when the user is allowed to land there.
   */
  intendedPath?: string | null;
}

/**
 * Resolve where the authenticated user should be sent right after login.
 *
 * Priority:
 *   1. Vendor portal users  → /vendor-portal
 *   2. Platform admins      → /admin-management  (NEVER forced into onboarding)
 *   3. Onboarded tenant     → intendedPath || /dashboard
 *   4. Not onboarded tenant → /onboarding-setup
 */
export async function resolvePostLoginDestination(
  ctx: PostLoginContext,
): Promise<string> {
  const { user, intendedPath } = ctx;
  if (!user) return "/login";

  // 1. Vendor portal short-circuit (already supported elsewhere).
  if (user.user_metadata?.is_vendor_portal === true) {
    return "/vendor-portal";
  }

  // 2. Platform admin short-circuit. This is the key fix: a SaaS operator
  // signing in must reach /admin-management directly, regardless of whether
  // they ever created a customer workspace.
  try {
    const { data, error } = await supabase
      .from("platform_admins")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();

    if (!error && data) {
      return "/admin-management";
    }
  } catch {
    // If the lookup fails we fall through to the tenant flow rather than
    // blocking the user; AdminProtectedRoute still gates /admin-management.
  }

  // 3. Tenant user with completed onboarding.
  const onboardingCompleted = user.user_metadata?.onboarding_completed === true;
  if (onboardingCompleted) {
    if (intendedPath && isSafeRedirect(intendedPath)) return intendedPath;
    // /home is the authenticated landing surface. /dashboard used to be
    // the implicit default here, which is why every login (and every
    // post-org-select redirect that fell back here) dumped users on the
    // dashboard regardless of where they were going.
    return "/home";
  }

  // 4. Tenant user that still needs to finish workspace setup.
  return "/onboarding-setup";
}

function isSafeRedirect(path: string): boolean {
  // Only allow same-origin in-app paths.
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//");
}
