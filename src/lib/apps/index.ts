/**
 * App Registry Module
 * 
 * Centralized exports for the Odoo-style app system.
 */

// Types
export * from "./types";

// Registry and utilities
export {
  APP_REGISTRY,
  FINANCE_APP,
  SALES_APP,
  CONTACTS_APP,
  PURCHASES_APP,
  INVENTORY_APP,
  POS_APP,
  CRM_APP,
  HR_APP,
  EMPLOYEES_APP,
  TIME_OFF_APP,
  ATTENDANCE_APP,
  TIMESHEETS_APP,
  PAYROLL_APP,
  // RECRUITMENT_APP retired 2026-05-09
  PROJECTS_APP,
  STUDIO_APP,
  PLATFORM_APP,
  SMS_APP,
  HARDWARE_APP,
  getAppById,
  getAppByPath,
  getModuleByPath,
  getAppGroups,
  LEGACY_ROUTE_MAPPINGS,
  getLegacyRouteRedirect,
} from "./registry";
