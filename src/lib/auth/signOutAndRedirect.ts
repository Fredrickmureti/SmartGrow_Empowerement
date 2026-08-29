/**
 * signOutAndRedirect
 *
 * Sign-out helper. The single-institution deployment has one internal login
 * (`/login`) plus the vendor portal, so the destination depends only on
 * whether the user was inside the portal.
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
