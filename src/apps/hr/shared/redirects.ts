/**
 * HR Domain redirects map (Wave 1).
 *
 * Old → new path map for the URL moves introduced by the Wave-1
 * architectural split (Org / Contracts / Lifecycle / Reports).
 *
 * Consumed by the HR dispatcher (`routes.tsx`) and any tool that needs
 * to resolve a legacy bookmark, edge-function callback, or notification
 * deep link. Adding an entry here is enough — do not duplicate the
 * mapping in individual sub-app routers.
 *
 * The map is intentionally a typed `Record` (not an array) so the type
 * system catches duplicate keys at compile time.
 */

export type HrRedirectMap = Record<string, string>;

export const HR_REDIRECTS: HrRedirectMap = {
  // Departments, Job positions, Work locations and the Org chart are
  // built-in features of the Employees app (Odoo `hr` pattern), not a
  // separate workspace. Legacy /hr/org/* URLs redirect into Employees.
  "/hr/departments": "/hr/employees/departments",
  "/hr/job-positions": "/hr/employees/positions",
  "/hr/work-locations": "/hr/employees/locations",
  "/hr/org-chart": "/hr/employees/org-chart",
  "/hr/org": "/hr/employees",
  "/hr/org/departments": "/hr/employees/departments",
  "/hr/org/positions": "/hr/employees/positions",
  "/hr/org/locations": "/hr/employees/locations",
  "/hr/org/chart": "/hr/employees/org-chart",
  "/hr/org/analytics": "/hr/employees/dashboard",
  "/hr/org/history": "/hr/employees/dashboard",

  // Contracts workspace: lifted out of the employee profile drawer
  "/hr/employee-contracts": "/hr/contracts",

  // Talent workspace owns performance + competencies
  "/hr/performance": "/hr/talent/dashboard",
  "/hr/configuration/competencies": "/hr/talent/competencies",

  // Time Off owns public holidays (deduped from Employees configuration)
  "/hr/configuration/public-holidays": "/hr/leave/holidays",

  // Self-service surfaces live under /me/* — legacy /hr/* aliases preserved
  "/hr/my-profile": "/me/profile",
  "/hr/my-portal": "/me",
  "/hr/timesheets": "/me/timesheets",
  "/hr/documents": "/me/documents",
};

/**
 * Returns the new path for a legacy HR path, or null if no mapping.
 * Preserves any trailing path segments (e.g. an id) and the query string.
 */
export function resolveHrRedirect(pathname: string, search = ""): string | null {
  // Exact match
  if (HR_REDIRECTS[pathname]) {
    return HR_REDIRECTS[pathname] + search;
  }
  // Prefix match — preserve the tail
  for (const [oldPath, newPath] of Object.entries(HR_REDIRECTS)) {
    if (pathname.startsWith(oldPath + "/")) {
      return newPath + pathname.slice(oldPath.length) + search;
    }
  }
  return null;
}