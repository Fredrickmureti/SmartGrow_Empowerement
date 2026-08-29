/**
 * Post-login redirect resolver.
 *
 * Single source of truth for "where should this authenticated user land?".
 *
 * Account model (do not collapse these):
 *   - auth.users         → identity (email/password)
 *   - user_roles         → institution membership and role
 *
 * The platform-admin (SaaS operator) persona was removed by the microfinance
 * convergence: this is a single-institution deployment.
 */
import type { User } from "@supabase/supabase-js";

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
 *   2. Onboarded user       → intendedPath || /home
 *   3. Not onboarded user   → /onboarding-setup
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
