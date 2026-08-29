/**
 * App Registry Module
 *
 * Centralized exports for the Odoo-style app system.
 * Retired apps (Sales, Purchases, Inventory, Warehouse, POS, CRM, Projects,
 * SMS, Hardware, and the HR sub-apps other than Employees) are no longer
 * exported — they are not part of the microfinance platform.
 */

// Types
export * from "./types";

// Registry and utilities
export {
  APP_REGISTRY,
  FINANCE_APP,
  CONTACTS_APP,
  HR_APP,
  EMPLOYEES_APP,
  REPORTS_APP,
  STUDIO_APP,
  PLATFORM_APP,
  DASHBOARD_APP,
  ME_APP,
  getAppById,
  getAppByPath,
  getModuleByPath,
  getAppGroups,
  LEGACY_ROUTE_MAPPINGS,
  getLegacyRouteRedirect,
} from "./registry";
