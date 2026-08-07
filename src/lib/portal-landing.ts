/**
 * Determines the correct landing page for portal users.
 * Portal users should only land on /hr/my-portal if the HR app is installed.
 * Otherwise, they land on /dashboard.
 */
export function getPortalLandingPath(isHrInstalled: boolean): string {
  return isHrInstalled ? "/me" : "/dashboard";
}
