/**
 * Module-to-App Mapping
 * 
 * Maps permission modules (from Access Groups) to app IDs.
 * Used to determine which apps should be visible based on a user's Access Group rules.
 * 
 * This is the Odoo-aligned "Layer 1" filter: if a user's Access Groups don't grant
 * at least `can_read` on any module mapped to an app, that app is hidden entirely.
 */

import type { PermissionModule, PermissionGroupRule } from "@/lib/permissions";

/**
 * Maps each permission module to the app IDs it grants visibility to.
 * A user needs `can_read` on at least one module mapped to an app to see that app.
 */
export const MODULE_TO_APP_MAP: Record<PermissionModule, string[]> = {
  contacts:    ["contacts", "crm"],
  products:    ["inventory"],
  sales:       ["sales"],
  purchases:   ["purchases"],
  financials:  ["finance", "reports"],
  // HR domain — one module per Odoo-aligned sub-app
  employees:   ["employees"],
  leave:       ["time-off"],
  attendance:  ["attendance"],
  recruitment: [], // retired 2026-05-09
  payroll:     ["payroll"],
  // Deprecated aliases — kept as keys to satisfy the PermissionModule enum
  // but no longer grant lateral visibility to other apps. Legacy `hr` is fully
  // split into 5 sub-apps (employees/time-off/attendance/payroll/recruitment);
  // legacy `timesheets` only grants visibility to its own app.
  hr:          [],
  timesheets:  ["timesheets"],
  projects:    ["projects"],
  pos:         ["pos"],
  // sign: retired 2026-05-09
  settings:    ["platform", "studio"],
  team:        ["platform"],
};

/**
 * Given a set of Access Group rules, returns the set of app IDs the user should be able to see.
 * Only modules with `can_read: true` grant app visibility.
 * 
 * Platform apps (settings, studio) are always included as they have their own internal gating.
 */
export function getAccessibleAppIdsFromGroupRules(groupRules: PermissionGroupRule[]): Set<string> {
  const appIds = new Set<string>();

  // Always grant access to platform apps — they handle their own permission checks internally
  appIds.add("platform");

  for (const rule of groupRules) {
    if (rule.can_read) {
      const mappedApps = MODULE_TO_APP_MAP[rule.module];
      if (mappedApps) {
        for (const appId of mappedApps) {
          appIds.add(appId);
        }
      }
    }
  }

  return appIds;
}

/**
 * Core / always-on permission modules that exist independently of any
 * installable app surface. Settings + Team + the financial backbone
 * (financials/sales/purchases/contacts/products) ship with every workspace
 * and must always be configurable in Access Groups regardless of which
 * apps are installed.
 */
export const ALWAYS_ON_PERMISSION_MODULES: ReadonlySet<PermissionModule> = new Set([
  "settings",
  "team",
  "contacts",
  "products",
  "sales",
  "purchases",
  "financials",
]);

/**
 * Returns true when at least one of the apps mapped to `module` is part of
 * the provided installed-app id set, OR the module is a core/always-on one.
 *
 * Used by the Access Groups editor to dim/hide rows for uninstalled apps
 * while still preserving any rules already saved against them (Odoo's
 * "module not installed" behaviour: hide the configuration UI but keep the
 * data so re-installing the app restores access).
 */
export function isModuleAppInstalled(
  module: PermissionModule,
  installedAppIds: Set<string>,
): boolean {
  if (ALWAYS_ON_PERMISSION_MODULES.has(module)) return true;
  const mappedApps = MODULE_TO_APP_MAP[module] ?? [];
  return mappedApps.some((appId) => installedAppIds.has(appId));
}
