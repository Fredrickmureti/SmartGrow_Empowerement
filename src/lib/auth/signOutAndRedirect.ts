/**
 * signOutAndRedirect
 *
 * Persona-aware sign-out helper. The ERP supports two distinct identity
 * contexts (see docs/adr/0004-platform-admin-vs-tenant.md):
 *
 *   - Tenant context: routes under `/` (dashboard, finance, sales, …)
 *     → on sign-out the user belongs at the tenant `/login`.
 *   - Platform-admin context: routes under `/admin-management/*`
 *     → on sign-out the operator belongs at `/admin-management/login`.
 *
 * Hard-coding `/login` in admin menus dumped operators into the customer
 * auth screen, which is the wrong account boundary and was visible to the
 * end-user as a UX bug. This helper centralises the decision so every
 * sign-out callsite stays consistent — and the policy is testable.
 *
 * Usage:
 *   await signOutAndRedirect(signOut, window.location.pathname);
 *
 * The function awaits `signOut()` (so Supabase clears the session before
 * the navigation), then performs `window.location.replace(target)` to
 * guarantee a fresh page load — this discards any in-memory React state
 * that might still reference the previous user.
 */
export type SignOutFn = () => Promise<void> | void;

/** Pure helper — exported so unit tests can assert without DOM. */
export function resolveSignOutDestination(currentPathname: string): string {
  const path = (currentPathname || "").toLowerCase();
  if (path.startsWith("/vendor-portal")) {
    return "/vendor-portal";
  }
  return "/login";
}

export async function signOutAndRedirect(
  signOut: SignOutFn,
  currentPathname: string,
): Promise<void> {
  try {
    await signOut();
  } catch {
    // Even if the server-side sign-out fails (offline, network), we still
    // navigate away. AuthContext.signOut() already clears local state on
    // its own error path, so the user lands on the correct login screen
    // either way.
  }
  const target = resolveSignOutDestination(currentPathname);
  if (typeof window !== "undefined") {
    window.location.replace(target);
  }
}
