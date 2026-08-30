/**
 * App Registry
 * 
 * Central registry of all apps in the system, inspired by Odoo's modular architecture.
 * Each app is a self-contained domain with its own modules, permissions, and routes.
 */

import {
  PiggyBank,
  Receipt,
  ShoppingCart,
  Package,
  Monitor,
  Users,
  UserCheck,
  Building2,
  Briefcase,
  FolderKanban,
  Settings,
  BookOpen,
  FileText,
  Landmark,
  Target,
  Building,
  CalendarCheck,
  GitCompare,
  ListFilter,
  ClipboardList,
  Truck,
  RotateCcw,
  Wallet,
  FileCheck,
  CreditCard,
  Calculator,
  BarChart3,
  DollarSign,
  GraduationCap,
  Clock,
  CalendarOff,
  Warehouse,
  History,
  HandCoins,
  UserPlus,
  Wand2,
  Shield,
  FileBox,
  PenTool,
  FileSpreadsheet,
  LayoutGrid,
  LayoutDashboard,
  Bell,
  Sparkles,
  Inbox,
  ChefHat,
  Calendar,
  Tags,
  RefreshCw,
  MessageSquare,
  Zap,
  ScrollText,
  Ban,
  CalendarClock,
  MapPin,
  FileEdit,
  ShieldCheck,
  Cpu,
  Activity,
  type LucideIcon,
} from "lucide-react";
import { AppDefinition, AppGroup, ModuleDefinition } from "./types";

/**
 * Finance App - Accounting, banking, and financial management
 */
export const FINANCE_APP: AppDefinition = {
  id: "finance",
  name: "Finance",
  description: "Accounting, banking, and financial reports",
  icon: PiggyBank,
  color: "hsl(142, 76%, 36%)", // Emerald green
  basePath: "/finance",
  requiredPermissions: ["viewFinancials"],
  sortOrder: 1,
  defaultModule: "dashboard",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "Dashboard", path: "/dashboard", icon: PiggyBank, permission: "viewFinancials" },
    { id: "receivables", name: "Accounts Receivable", path: "/receivables", icon: Wallet, permission: "viewFinancials" },
    { id: "payables", name: "Accounts Payable", path: "/payables", icon: CreditCard, permission: "viewFinancials" },
    { id: "customer-credits", name: "Customer Credits", path: "/customer-credits", icon: Wallet, permission: "viewFinancials" },
    { id: "statements", name: "Customer Statements", path: "/statements", icon: ScrollText, permission: "viewFinancials" },
    { id: "accounts", name: "Chart of Accounts", path: "/accounts", icon: BookOpen, permission: "viewFinancials" },
    { id: "journal-entries", name: "Journal Entries", path: "/journal-entries", icon: FileText, permission: "viewFinancials" },
    { id: "fiscal-periods", name: "Fiscal Periods", path: "/fiscal-periods", icon: CalendarCheck, permission: "viewFinancials" },
    { id: "budgets", name: "Budgets", path: "/budgets", icon: Target, permission: "viewFinancials" },
    { id: "fixed-assets", name: "Fixed Assets", path: "/fixed-assets", icon: Building, permission: "viewFinancials" },
    { id: "banking", name: "Banking", path: "/banking", icon: Landmark, permission: "viewFinancials" },
    { id: "bank-feeds", name: "Bank Feeds", path: "/bank-feeds", icon: ListFilter, permission: "viewFinancials" },
    { id: "reconciliation", name: "Reconciliation", path: "/reconciliation", icon: GitCompare, permission: "viewFinancials" },
    { id: "reports", name: "Financial Reports", path: "/reports", icon: BarChart3, permission: "viewReports" },
    { id: "settings", name: "Settings", path: "/settings", icon: FileText, permission: "viewFinancials" },
  ],
};


/**
 * Contacts App - Central hub for all contacts (Odoo-style)
 */
export const CONTACTS_APP: AppDefinition = {
  id: "contacts",
  name: "Contacts",
  description: "Manage customers, suppliers, and all contacts",
  icon: Users,
  color: "hsl(215, 65%, 50%)", // Slate blue
  basePath: "/contacts-app",
  requiredPermissions: ["viewContacts"],
  sortOrder: 3,
  defaultModule: "all",
  internalOnly: true,
  modules: [
    { id: "all", name: "All Contacts", path: "", icon: Users, permission: "viewContacts" },
    { id: "customers", name: "Customers", path: "/customers", icon: UserCheck, permission: "viewContacts" },
    { id: "vendors", name: "Suppliers", path: "/vendors", icon: Building2, permission: "viewContacts" },
    { id: "companies", name: "Companies", path: "/companies", icon: Building, permission: "viewContacts" },
  ],
};






/**
 * Employees App — Foundational HR app (Odoo `hr` equivalent).
 *
 * Owns the employee record, departments, contracts, and people analytics.
 * Every other HR-domain app (Time Off, Attendance, Payroll, Recruitment)
 * depends on this app being installed first.
 *
 * Self-service surfaces (`my-portal`, `my-profile`, personal payslips/leave)
 * are NOT in this app — they live under `/me/*` (My Workspace) and are
 * available to any authenticated user linked to an `employees` row.
 */
export const EMPLOYEES_APP: AppDefinition = {
  id: "employees",
  name: "Employees",
  description: "Employee directory, departments, contracts, and people analytics",
  icon: Users,
  color: "hsl(45, 93%, 47%)", // Amber
  basePath: "/hr",
  requiredPermissions: ["viewEmployees", "viewDirectory"],
  sortOrder: 8,
  defaultModule: "employees",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "Dashboard", path: "/dashboard", icon: Users, permission: "viewEmployees" },
    { id: "employees", name: "Employees", path: "/employees", icon: Users, permission: "viewEmployees" },
    { id: "departments", name: "Departments", path: "/departments", icon: Building, permission: "manageDepartments" },
    { id: "job-positions", name: "Job Positions", path: "/job-positions", icon: Briefcase, permission: "viewEmployees" },
    { id: "work-locations", name: "Work Locations", path: "/work-locations", icon: MapPin, permission: "viewEmployees" },
    { id: "org-chart", name: "Org Chart", path: "/org-chart", icon: Users, permission: "viewEmployees" },
    { id: "reports", name: "HR Reports", path: "/reports", icon: BarChart3, permission: "viewEmployees" },
    { id: "configuration", name: "Employee Configuration", path: "/configuration", icon: Settings, permission: "manageEmployees" },
  ],
};





/**
 * RECRUITMENT_APP retired 2026-05-09 — out of accounting scope.
 */








/**
 * @deprecated Use EMPLOYEES_APP / TIME_OFF_APP / ATTENDANCE_APP / PAYROLL_APP / RECRUITMENT_APP instead.
 * Kept ONLY as a compatibility alias for legacy entitlement rows where `app_id='hr'`
 * still exists in `plan_app_access` / `organization_installed_apps`. The routing layer
 * resolves `hr` to `employees`. New code MUST NOT reference HR_APP.
 */
export const HR_APP: AppDefinition = EMPLOYEES_APP;


/**
 * Reports App - Business intelligence and analytics
 */
export const REPORTS_APP: AppDefinition = {
  id: "reports",
  name: "Reports",
  description: "Financial reports, analytics, and business intelligence",
  icon: BarChart3,
  color: "hsl(280, 65%, 60%)", // Violet
  // Reports have no standalone router mount — they live under the Finance app
  // routes (/finance/reports/*). Pointing the tile at /reports 404'd.
  basePath: "/finance/reports",
  requiredPermissions: ["viewReports"],
  sortOrder: 10,
  internalOnly: true,
  defaultModule: "reports",
  modules: [
    { id: "reports", name: "All Reports", path: "", icon: BarChart3, permission: "viewReports" },
    { id: "financial", name: "Financial Statements", path: "/financial", icon: PiggyBank, permission: "viewReports" },
    { id: "trial-balance", name: "Trial Balance", path: "/trial-balance", icon: Calculator, permission: "viewReports" },
    { id: "consolidated-trial-balance", name: "Consolidated TB", path: "/consolidated-trial-balance", icon: Calculator, permission: "viewReports" },
    { id: "consolidated-statements", name: "Consolidated Statements", path: "/consolidated-statements", icon: FileText, permission: "viewReports" },
    { id: "intercompany", name: "Intercompany", path: "/intercompany", icon: FileText, permission: "viewReports" },
    { id: "eliminations", name: "Eliminations", path: "/eliminations", icon: FileText, permission: "viewReports" },
    { id: "general-ledger", name: "General Ledger", path: "/general-ledger", icon: BookOpen, permission: "viewReports" },
    { id: "partner-ledger", name: "Partner Ledger", path: "/partner-ledger", icon: FileText, permission: "viewReports" },
    { id: "journal-report", name: "Journal Report", path: "/journal-report", icon: BookOpen, permission: "viewReports" },
    { id: "aging", name: "Aging Reports", path: "/aging", icon: Clock, permission: "viewReports" },
    { id: "budget", name: "Budget vs Actual", path: "/budget", icon: Target, permission: "viewReports" },
    { id: "depreciation", name: "Depreciation", path: "/depreciation", icon: Building2, permission: "viewReports" },
    { id: "cash-flow", name: "Cash Flow", path: "/cash-flow", icon: Wallet, permission: "viewReports" },
    { id: "audit-trail", name: "Audit Trail", path: "/audit-trail", icon: History, permission: "viewReports" },
    { id: "sales", name: "Sales Reports", path: "/sales", icon: FileText, permission: "viewReports" },
    { id: "management", name: "Management", path: "/management", icon: BarChart3, permission: "viewReports" },
    { id: "tax", name: "Tax Reports", path: "/tax", icon: Receipt, permission: "viewReports" },
    // Inventory family — dual-hosted (ADR 0143). These paths are the Finance
    // mounts; the Inventory shell mounts the same pages under /inventory-app.
    { id: "stock", name: "Stock Reports", path: "/stock", icon: Package, permission: "viewReports" },
    { id: "inventory-valuation", name: "Inventory Valuation", path: "/inventory-valuation", icon: Package, permission: "viewReports" },
    { id: "stock-ledger", name: "Stock Ledger", path: "/stock-ledger", icon: BookOpen, permission: "viewReports" },
    { id: "stock-aging", name: "Stock Aging", path: "/stock-aging", icon: Clock, permission: "viewReports" },
    { id: "lot-traceability", name: "Lot Traceability", path: "/lot-traceability", icon: Package, permission: "viewReports" },
    { id: "stock-adjustments", name: "Stock Adjustments", path: "/stock-adjustments", icon: Package, permission: "viewReports" },
    { id: "stock-transfers", name: "Stock Transfers", path: "/stock-transfers", icon: Package, permission: "viewReports" },
    { id: "intelligence", name: "Business Intelligence", path: "/intelligence", icon: BarChart3, permission: "viewReports" },
  ],
};

/**
 * Documents App retired 2026-05-16 — productivity-only file storage, not part of accounting.
 */

/**
 * SIGN_APP and SPREADSHEETS_APP retired 2026-05-09 — out of accounting scope.
 * Pages, hooks, components, and edge functions deleted. Marketplace tiles
 * no longer registered.
 */

/**
 * Studio App - Customization, automation, and report scheduling
 */
export const STUDIO_APP: AppDefinition = {
  id: "studio",
  name: "Studio",
  description: "Customize fields, forms, automations, and report scheduling",
  icon: Wand2,
  color: "hsl(270, 70%, 50%)", // Purple
  basePath: "/studio",
  requiredPermissions: ["editSettings"],
  sortOrder: 15,
  internalOnly: true,
  defaultModule: "fields",
  modules: [
    { id: "fields", name: "Fields", path: "", icon: Wand2, permission: "editSettings" },
    { id: "forms", name: "Forms", path: "/forms", icon: LayoutGrid, permission: "editSettings" },
    { id: "automations", name: "Automations", path: "/automations", icon: Zap, permission: "editSettings" },
    { id: "views", name: "Views", path: "/views", icon: BarChart3, permission: "editSettings" },
    { id: "approvals", name: "Approvals", path: "/approvals", icon: Shield, permission: "editSettings" },
    { id: "reports", name: "Reports", path: "/reports", icon: FileText, permission: "editSettings" },
    { id: "scheduling", name: "Scheduling", path: "/scheduling", icon: CalendarClock, permission: "editSettings" },
  ],
};

/**
 * Platform App - Settings, team, and system configuration
 */
export const PLATFORM_APP: AppDefinition = {
  id: "platform",
  name: "Settings",
  description: "Organization settings, team management, and configuration",
  icon: Settings,
  color: "hsl(0, 0%, 45%)", // Gray
  basePath: "/settings",
  requiredPermissions: [],
  sortOrder: 100,
  alwaysAvailable: true,
  defaultModule: "general",
  modules: [
    { id: "general", name: "General", path: "", icon: Settings, permission: "editSettings" },
    { id: "team", name: "Team", path: "/team", icon: UserPlus, permission: "manageTeam" },
    { id: "migration", name: "Data Migration", path: "/migration", icon: GitCompare, permission: "editSettings", description: "Import financial data from another system" },
    { id: "studio", name: "Studio", path: "/studio", icon: Wand2, permission: "editSettings", description: "Customize fields, forms, and workflows" },
    { id: "audit-logs", name: "Audit Logs", path: "/audit-logs", icon: History, permission: "viewAuditLogs" },
    { id: "compliance", name: "Compliance", path: "/compliance", icon: Shield, permission: "viewReports" },
  ],
};




/**
 * My Workspace App — personal employee self-service shell.
 *
 * Treated as just another app so portal users and internal users alike get
 * the same `AppWorkspaceLayout` top-bar + module-tabs experience instead of
 * a parallel sidebar codebase. `hideAppSwitcher` suppresses the grid icon
 * and "Switch App" menu since this shell is single-purpose.
 *
 * Excluded from the global app switcher / marketplace by explicit filter in
 * useAppNavigation and getAppGroups.
 */
export const ME_APP: AppDefinition = {
  id: "me",
  name: "My Workspace",
  description: "Your personal workspace — profile, documents and settings",
  icon: LayoutGrid,
  color: "hsl(217, 91%, 60%)",
  basePath: "/me",
  requiredPermissions: [],
  sortOrder: 0,
  defaultModule: "home",
  alwaysAvailable: true,
  internalOnly: false,
  hideAppSwitcher: true,
  // Leave / timesheets / attendance / shifts / payslips / loans / exit were
  // retired with the HR excision — their routes no longer exist.
  modules: [
    { id: "home",        name: "Home",        path: "",            icon: LayoutGrid },
    { id: "documents",   name: "Documents",   path: "/documents",   icon: FileText },
    { id: "onboarding",  name: "Onboarding",  path: "/onboarding",  icon: ClipboardList },
    { id: "profile",     name: "Profile",     path: "/profile",     icon: UserCheck },
    { id: "settings",    name: "Settings",    path: "/settings",    icon: Settings },
  ],
};

/**
 * Dashboard App — the global home / executive workspace.
 *
 * Promotes the legacy "/dashboard" page to a first-class workspace inside
 * the unified PlatformShell, retiring the parallel DashboardLayout +
 * AppAwareSidebar chrome. Sits at sortOrder 1 so it's the first icon on
 * the AppRail right after Home.
 */
export const DASHBOARD_APP: AppDefinition = {
  id: "dashboard",
  name: "Home",
  description: "Overview, activity, approvals, and key insights across your workspace",
  icon: LayoutDashboard,
  color: "hsl(217, 91%, 60%)",
  basePath: "/dashboard",
  requiredPermissions: [],
  sortOrder: 1,
  defaultModule: "overview",
  alwaysAvailable: true,
  modules: [
    { id: "overview",  name: "Overview",  path: "",           icon: LayoutDashboard },
    { id: "activity",  name: "Activity",  path: "/activity",  icon: Bell },
    { id: "approvals", name: "Approvals", path: "/approvals", icon: Inbox },
    { id: "insights",  name: "Insights",  path: "/insights",  icon: Sparkles },
  ],
};

/**
 * Complete app registry — the apps retained by the microfinance convergence.
 *
 * Sales, Purchases, Inventory, Warehouse, POS, CRM, Projects, SMS, Hardware and
 * the HR sub-apps other than Employees (Time Off, Attendance, Timesheets,
 * Payroll, Talent, Contracts, Org) were retired: they have no routes, no pages
 * and no business meaning for a microfinance institution.
 */
export const APP_REGISTRY: AppDefinition[] = [
  DASHBOARD_APP,
  ME_APP,
  FINANCE_APP,
  CONTACTS_APP,
  EMPLOYEES_APP,
  REPORTS_APP,
  STUDIO_APP,
  PLATFORM_APP,
];

/**
 * Get an app by its ID
 */
export function getAppById(appId: string): AppDefinition | undefined {
  return APP_REGISTRY.find(app => app.id === appId);
}

/**
 * Get an app by a route path
 */
export function getAppByPath(path: string): AppDefinition | undefined {
  // Remove leading slash and get first segment
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  const firstSegment = cleanPath.split("/")[0];
  
  return APP_REGISTRY.find(app => {
    const appSegment = app.basePath.replace(/^\//, "");
    return appSegment === firstSegment;
  });
}

/**
 * Get module by path within an app
 */
export function getModuleByPath(app: AppDefinition, path: string): ModuleDefinition | undefined {
  // Get the path after the app's base path
  const relativePath = path.replace(app.basePath, "") || "/";
  
  return app.modules.find(module => {
    const modulePath = module.path || "/";
    return relativePath === modulePath || relativePath.startsWith(modulePath + "/");
  });
}

/**
 * Group apps by category for the app switcher.
 *
 * Categories are curated, but the grouping is **exhaustive by construction**:
 * any registered app that isn't explicitly categorised falls into "Other apps"
 * instead of silently disappearing from the switcher (the bug that hid
 * Warehouse and Talent). `me` is the only deliberate exclusion — it has its
 * own single-purpose shell (`hideAppSwitcher`).
 */
export function getAppGroups(): AppGroup[] {
  const bySortOrder = (a: AppDefinition, b: AppDefinition) =>
    (a.sortOrder || 0) - (b.sortOrder || 0);

  const CATEGORY_MEMBERSHIP: Array<{ label: string; ids: string[] }> = [
    { label: "Core", ids: ["finance", "contacts"] },
    { label: "Operations", ids: ["studio"] },
    { label: "Human Resources", ids: ["employees"] },
    { label: "Analytics", ids: ["reports"] },
  ];

  const switchable = APP_REGISTRY.filter(
    (app) => app.id !== "me" && !app.hideAppSwitcher,
  );

  const groups: AppGroup[] = CATEGORY_MEMBERSHIP.map(({ label, ids }) => ({
    label,
    apps: switchable.filter((app) => ids.includes(app.id)).sort(bySortOrder),
  }));

  const systemApps = switchable.filter((app) => app.alwaysAvailable).sort(bySortOrder);
  groups.push({ label: "System", apps: systemApps });

  // Catch-all: anything registered but not placed above.
  const placed = new Set(groups.flatMap((g) => g.apps.map((a) => a.id)));
  const uncategorised = switchable.filter((app) => !placed.has(app.id)).sort(bySortOrder);
  if (uncategorised.length > 0) {
    groups.push({ label: "Other apps", apps: uncategorised });
  }

  return groups.filter((group) => group.apps.length > 0);

}

/**
 * Legacy route mappings for backward compatibility
 * Maps old flat routes to new app-based routes
 */
export const LEGACY_ROUTE_MAPPINGS: Record<string, string> = {
  // Finance
  "/accounts": "/finance/accounts",
  "/journal-entries": "/finance/journal-entries",
  "/fiscal-periods": "/finance/fiscal-periods",
  "/budgets": "/finance/budgets",
  "/fixed-assets": "/finance/fixed-assets",
  "/banking": "/finance/banking",
  "/bank-feeds": "/finance/bank-feeds",
  "/bank-reconciliation": "/finance/reconciliation",
  
  // Contacts (using contacts-app for the central hub)
  "/contacts": "/contacts-app",

  // HR (Employees only — the other HR sub-apps were retired)
  "/employees": "/hr/employees",
  "/departments": "/hr/employees/departments",
  
  
  // Reports (mounted under the Finance app router)
  "/reports": "/finance/reports",
  "/reports/financial": "/finance/reports/financial",
  "/reports/trial-balance": "/finance/reports/trial-balance",
  "/reports/consolidated-trial-balance": "/finance/reports/consolidated-trial-balance",
  "/reports/consolidated-statements": "/finance/reports/consolidated-statements",
  "/reports/intercompany": "/finance/reports/intercompany",
  "/reports/eliminations": "/finance/reports/eliminations",
  "/reports/consolidation": "/finance/reports/cross-company",
  "/reports/general-ledger": "/finance/reports/general-ledger",
  "/reports/aging": "/finance/reports/aging",
  "/reports/management": "/finance/reports/management",
  "/reports/tax": "/finance/reports/tax",
  "/business-intelligence": "/finance/reports/intelligence",
  
  // Platform/Settings
  "/settings": "/settings",
  "/team": "/settings/team",
  "/studio": "/settings/studio",
  "/audit-logs": "/settings/audit-logs",
  "/compliance": "/settings/compliance",
};

/**
 * Get the new route for a legacy path
 */
export function getLegacyRouteRedirect(path: string): string | null {
  return LEGACY_ROUTE_MAPPINGS[path] || null;
}
