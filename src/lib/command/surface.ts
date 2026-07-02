/**
 * Command Palette — Surface Detection
 *
 * The palette is route-driven, not role-driven: the workspace surface
 * the user is *currently on* decides which entries appear, not the
 * roles they hold elsewhere.
 *
 *  - Inside `/admin-management/*` → "platform" surface (admin console).
 *  - Anywhere else                → "tenant" surface (org workspace).
 *
 * Why route-driven and not role-driven: a platform admin who navigates
 * into a tenant workspace is operating as a tenant user in that moment
 * (impersonation / support / their own org). Forcing role-based
 * filtering would break those flows. The palette mirrors the surface
 * the user is on; the route guards still control who can be there.
 */

export type ActiveSurface = "tenant" | "platform";

const PLATFORM_PREFIX = "/admin-management";

/**
 * Decide which surface a given route belongs to.
 *
 * @param pathname        Current `location.pathname`.
 * @param _isPlatformAdmin Reserved for a future "always show admin" toggle.
 *                         Intentionally unused today — see file header.
 */
export function detectSurface(
  pathname: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _isPlatformAdmin: boolean,
): ActiveSurface {
  if (
    pathname === PLATFORM_PREFIX ||
    pathname.startsWith(`${PLATFORM_PREFIX}/`)
  ) {
    return "platform";
  }
  return "tenant";
}
