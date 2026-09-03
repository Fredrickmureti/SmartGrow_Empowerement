/**
 * App Registry — Smart Grow Empowerment (single-institution microfinance).
 *
 * Five workspaces only: Home, Lending, Finance, Reports, Settings.
 * The ERP catalogue (Sales, Purchases, Inventory, Warehouse, POS, CRM, HR,
 * Payroll, Contacts, Projects, SMS, Hardware, My Workspace) was retired in C10.
 */

import {
  PiggyBank,
  Users,
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
  Wallet,
  CreditCard,
  Calculator,
  BarChart3,
  Clock,
  History,
  HandCoins,
  UserPlus,
  Wand2,
  LayoutGrid,
  LayoutDashboard,
  Bell,
  Sparkles,
  Inbox,
  Tags,
  Zap,
  Shield,
  CalendarClock,
  Building2,
} from "lucide-react";
import { AppDefinition, AppGroup, ModuleDefinition } from "./types";

/**
 * Finance — the institution's accounting core (posting, banking, settlement).
 */
export const FINANCE_APP: AppDefinition = {
  id: "finance",
  name: "Finance",
  description: "Accounting, banking, and financial reports",
  icon: PiggyBank,
  color: "hsl(142, 76%, 36%)",
  basePath: "/finance",
  requiredPermissions: ["viewFinancials"],
  sortOrder: 3,
  defaultModule: "dashboard",
  internalOnly: true,
  modules: [
    { id: "dashboard", name: "Dashboard", path: "/dashboard", icon: PiggyBank, permission: "viewFinancials" },
    { id: "receivables", name: "Receivables", path: "/receivables", icon: Wallet, permission: "viewFinancials" },
    { id: "payables", name: "Payables", path: "/payables", icon: CreditCard, permission: "viewFinancials" },
    { id: "accounts", name: "Chart of Accounts", path: "/accounts", icon: BookOpen, permission: "viewFinancials" },
    { id: "journal-entries", name: "Journal Entries", path: "/journal-entries", icon: FileText, permission: "viewFinancials" },
    { id: "fiscal-periods", name: "Fiscal Periods", path: "/fiscal-periods", icon: CalendarCheck, permission: "viewFinancials" },
    { id: "fixed-assets", name: "Fixed Assets", path: "/fixed-assets", icon: Building, permission: "viewFinancials" },
    { id: "banking", name: "Banking", path: "/banking", icon: Landmark, permission: "viewFinancials" },
    { id: "bank-feeds", name: "Bank Feeds", path: "/bank-feeds", icon: ListFilter, permission: "viewFinancials" },
    { id: "reconciliation", name: "Reconciliation", path: "/reconciliation", icon: GitCompare, permission: "viewFinancials" },
    { id: "reports", name: "Financial Reports", path: "/reports", icon: BarChart3, permission: "viewReports" },
    { id: "settings", name: "Settings", path: "/settings", icon: FileText, permission: "viewFinancials" },
  ],
};

/**
 * Lending — the microfinance business domain.
 */
export const LENDING_APP: AppDefinition = {
  id: "lending",
  name: "Lending",
  description: "Clients, groups, loan products, applications, loans and collections",
  icon: HandCoins,
  color: "hsl(152, 60%, 40%)",
  basePath: "/lending",
  requiredPermissions: ["viewContacts"],
  sortOrder: 2,
  internalOnly: true,
  defaultModule: "clients",
  modules: [
    { id: "clients", name: "Clients", path: "", icon: Users, permission: "viewContacts" },
    { id: "groups", name: "Groups", path: "/groups", icon: Users, permission: "viewContacts" },
    { id: "products", name: "Loan Products", path: "/products", icon: Tags, permission: "viewContacts" },
    { id: "applications", name: "Applications", path: "/applications", icon: ClipboardList, permission: "viewContacts" },
    { id: "loans", name: "Loans", path: "/loans", icon: HandCoins, permission: "viewContacts" },
    { id: "repayments", name: "Repayments", path: "/repayments", icon: Wallet, permission: "viewContacts" },
    { id: "collections", name: "Collections", path: "/collections", icon: Target, permission: "viewContacts" },
  ],
};

/**
 * Reports — mounted under the Finance router (/finance/reports/*).
 */
export const REPORTS_APP: AppDefinition = {
  id: "reports",
  name: "Reports",
  description: "Portfolio, collections, arrears and financial reports",
  icon: BarChart3,
  color: "hsl(280, 65%, 60%)",
  basePath: "/finance/reports",
  requiredPermissions: ["viewReports"],
  sortOrder: 10,
  internalOnly: true,
  defaultModule: "reports",
  modules: [
    { id: "reports", name: "All Reports", path: "", icon: BarChart3, permission: "viewReports" },
    { id: "financial", name: "Financial Statements", path: "/financial", icon: PiggyBank, permission: "viewReports" },
    { id: "trial-balance", name: "Trial Balance", path: "/trial-balance", icon: Calculator, permission: "viewReports" },
    { id: "general-ledger", name: "General Ledger", path: "/general-ledger", icon: BookOpen, permission: "viewReports" },
    { id: "journal-report", name: "Journal Report", path: "/journal-report", icon: BookOpen, permission: "viewReports" },
    { id: "aging", name: "Aging Reports", path: "/aging", icon: Clock, permission: "viewReports" },
    { id: "depreciation", name: "Depreciation", path: "/depreciation", icon: Building2, permission: "viewReports" },
    { id: "cash-flow", name: "Cash Flow", path: "/cash-flow", icon: Wallet, permission: "viewReports" },
    { id: "audit-trail", name: "Audit Trail", path: "/audit-trail", icon: History, permission: "viewReports" },
  ],
};

/**
 * Studio — document templates, fields, automations, report scheduling.
 */
export const STUDIO_APP: AppDefinition = {
  id: "studio",
  name: "Studio",
  description: "Customize fields, forms, automations, and report scheduling",
  icon: Wand2,
  color: "hsl(270, 70%, 50%)",
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
 * Settings — institution, team, audit.
 */
export const PLATFORM_APP: AppDefinition = {
  id: "platform",
  name: "Settings",
  description: "Institution settings, team management, and configuration",
  icon: Settings,
  color: "hsl(0, 0%, 45%)",
  basePath: "/settings",
  requiredPermissions: [],
  sortOrder: 100,
  alwaysAvailable: true,
  defaultModule: "general",
  modules: [
    { id: "general", name: "General", path: "", icon: Settings, permission: "editSettings" },
    { id: "team", name: "Team", path: "/team", icon: UserPlus, permission: "manageTeam" },
    { id: "studio", name: "Studio", path: "/studio", icon: Wand2, permission: "editSettings", description: "Customize fields, forms, and workflows" },
    { id: "audit-logs", name: "Audit Logs", path: "/audit-logs", icon: History, permission: "viewAuditLogs" },
  ],
};

/**
 * Home — the global dashboard workspace.
 */
export const DASHBOARD_APP: AppDefinition = {
  id: "dashboard",
  name: "Home",
  description: "Overview, activity, approvals, and key insights across your institution",
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

export const APP_REGISTRY: AppDefinition[] = [
  DASHBOARD_APP,
  LENDING_APP,
  FINANCE_APP,
  REPORTS_APP,
  STUDIO_APP,
  PLATFORM_APP,
];

export function getAppById(appId: string): AppDefinition | undefined {
  return APP_REGISTRY.find(app => app.id === appId);
}

export function getAppByPath(path: string): AppDefinition | undefined {
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  const firstSegment = cleanPath.split("/")[0];
  return APP_REGISTRY.find(app => {
    const appSegment = app.basePath.replace(/^\//, "");
    return appSegment === firstSegment;
  });
}

export function getModuleByPath(app: AppDefinition, path: string): ModuleDefinition | undefined {
  const relativePath = path.replace(app.basePath, "") || "/";
  return app.modules.find(module => {
    const modulePath = module.path || "/";
    return relativePath === modulePath || relativePath.startsWith(modulePath + "/");
  });
}

/**
 * Group apps for the app switcher. Exhaustive by construction: anything not
 * explicitly categorised lands in "Other apps".
 */
export function getAppGroups(): AppGroup[] {
  const bySortOrder = (a: AppDefinition, b: AppDefinition) =>
    (a.sortOrder || 0) - (b.sortOrder || 0);

  const CATEGORY_MEMBERSHIP: Array<{ label: string; ids: string[] }> = [
    { label: "Core", ids: ["lending", "finance"] },
    { label: "Operations", ids: ["studio"] },
    { label: "Analytics", ids: ["reports"] },
  ];

  const switchable = APP_REGISTRY.filter((app) => !app.hideAppSwitcher);

  const groups: AppGroup[] = CATEGORY_MEMBERSHIP.map(({ label, ids }) => ({
    label,
    apps: switchable.filter((app) => ids.includes(app.id)).sort(bySortOrder),
  }));

  const systemApps = switchable.filter((app) => app.alwaysAvailable).sort(bySortOrder);
  groups.push({ label: "System", apps: systemApps });

  const placed = new Set(groups.flatMap((g) => g.apps.map((a) => a.id)));
  const uncategorised = switchable.filter((app) => !placed.has(app.id)).sort(bySortOrder);
  if (uncategorised.length > 0) {
    groups.push({ label: "Other apps", apps: uncategorised });
  }

  return groups.filter((group) => group.apps.length > 0);
}

/**
 * Legacy flat routes → app routes.
 */
export const LEGACY_ROUTE_MAPPINGS: Record<string, string> = {
  "/accounts": "/finance/accounts",
  "/journal-entries": "/finance/journal-entries",
  "/fiscal-periods": "/finance/fiscal-periods",
  "/fixed-assets": "/finance/fixed-assets",
  "/banking": "/finance/banking",
  "/bank-feeds": "/finance/bank-feeds",
  "/bank-reconciliation": "/finance/reconciliation",
  "/reports": "/finance/reports",
  "/reports/financial": "/finance/reports/financial",
  "/reports/trial-balance": "/finance/reports/trial-balance",
  "/reports/general-ledger": "/finance/reports/general-ledger",
  "/reports/aging": "/finance/reports/aging",
  "/reports/management": "/finance/reports/management",
  "/settings": "/settings",
  "/team": "/settings/team",
  "/studio": "/settings/studio",
  "/audit-logs": "/settings/audit-logs",
};

export function getLegacyRouteRedirect(path: string): string | null {
  return LEGACY_ROUTE_MAPPINGS[path] || null;
}
