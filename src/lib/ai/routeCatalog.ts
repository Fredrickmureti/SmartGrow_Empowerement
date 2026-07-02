/**
 * Route Catalog — the *only* allowlist of paths the AI assistant may emit.
 *
 * The assistant is told (via system prompt) that it can include action blocks
 * referencing any `id` from this catalog. The server validates ids before
 * streaming; the client navigates by `id` (never by raw path) so renames are
 * one-line edits here.
 *
 * Keep this file hand-curated. Do not auto-generate from the router — the
 * point is human review of which destinations are safe to surface to users.
 */

export interface CatalogEntry {
  id: string;
  label: string;
  path: string;
  /** App that must be installed for the path to function (matches APP_REGISTRY ids). */
  requires_app?: string;
  /** Permission needed to use the destination productively. */
  requires_permission?: string;
  /** Short human-readable summary the model can quote when proposing the link. */
  description: string;
}

export const ROUTE_CATALOG: Record<string, CatalogEntry> = {
  // ── Payroll ──────────────────────────────────────────────────────────────
  "payroll.overview": {
    id: "payroll.overview",
    label: "Payroll Overview",
    path: "/hr/payroll",
    requires_app: "payroll",
    description: "Payroll dashboard: readiness, next pay run, pending issues.",
  },
  "payroll.runs": {
    id: "payroll.runs",
    label: "Payroll Runs",
    path: "/hr/payroll/runs",
    requires_app: "payroll",
    description: "List of pay runs / batches.",
  },
  "payroll.payslips": {
    id: "payroll.payslips",
    label: "Payslips",
    path: "/hr/payroll/payslips",
    requires_app: "payroll",
    description: "Generated payslips, statuses, downloads.",
  },
  "payroll.payments": {
    id: "payroll.payments",
    label: "Payroll Payments",
    path: "/hr/payroll/payments",
    requires_app: "payroll",
    description: "Mark payroll as paid; payment batches.",
  },
  "payroll.gl_mappings": {
    id: "payroll.gl_mappings",
    label: "GL Account Mapping",
    path: "/hr/payroll/configuration/accounts",
    requires_app: "payroll",
    requires_permission: "managePayroll",
    description: "Map every payroll posting key to a chart-of-accounts entry.",
  },
  "payroll.salary_structures": {
    id: "payroll.salary_structures",
    label: "Salary Structures",
    path: "/hr/payroll/configuration/structures",
    requires_app: "payroll",
    requires_permission: "managePayroll",
    description: "Define salary structures and rules.",
  },
  "payroll.statutory_rules": {
    id: "payroll.statutory_rules",
    label: "Statutory Rules",
    path: "/hr/payroll/statutory-rules",
    requires_app: "payroll",
    requires_permission: "manageStatutoryRules",
    description: "Active country-specific statutory rules (PAYE, NSSF, SHIF, AHL, NITA…).",
  },
  "payroll.configuration": {
    id: "payroll.configuration",
    label: "Payroll Configuration",
    path: "/hr/payroll/configuration",
    requires_app: "payroll",
    requires_permission: "managePayroll",
    description: "All payroll settings: schedules, structures, accounts.",
  },
  "payroll.setup": {
    id: "payroll.setup",
    label: "Payroll Setup",
    path: "/hr/payroll/setup",
    requires_app: "payroll",
    requires_permission: "managePayroll",
    description: "Guided payroll setup wizard.",
  },
  "payroll.loans": {
    id: "payroll.loans",
    label: "Employee Loans",
    path: "/hr/payroll/loans",
    requires_app: "payroll",
    description: "Employee loan records and recoveries.",
  },
  "payroll.remittances": {
    id: "payroll.remittances",
    label: "Remittance Tracking",
    path: "/hr/remittances",
    requires_app: "payroll",
    description: "Statutory remittances per period.",
  },

  // ── HR adjacent ─────────────────────────────────────────────────────────
  "hr.employees": {
    id: "hr.employees",
    label: "Employees",
    path: "/hr/employees",
    requires_app: "employees",
    description: "Employee directory and records.",
  },
  "hr.attendance": {
    id: "hr.attendance",
    label: "Attendance",
    path: "/hr/attendance",
    requires_app: "attendance",
    description: "Attendance records and check-ins.",
  },
  "hr.time_off": {
    id: "hr.time_off",
    label: "Time Off",
    path: "/hr/leave",
    requires_app: "time-off",
    description: "Leave requests, balances, approvals.",
  },

  // ── Finance / Accounts ──────────────────────────────────────────────────
  "finance.chart_of_accounts": {
    id: "finance.chart_of_accounts",
    label: "Chart of Accounts",
    path: "/finance/accounts",
    requires_app: "finance",
    description: "All ledger accounts.",
  },
  "finance.journals": {
    id: "finance.journals",
    label: "Journal Entries",
    path: "/finance/journal-entries",
    requires_app: "finance",
    description: "All posted and draft journal entries.",
  },

  // ── Settings ────────────────────────────────────────────────────────────
  // NOTE: tenant settings live on two hubs (`/settings/workspace`,
  // `/settings/company`) with `?tab=` segments — there is no flat
  // `/settings/<thing>` URL. Keep the catalog pointing at real, working
  // destinations; do not invent flat paths.
  "settings.localization": {
    id: "settings.localization",
    label: "Localization Settings",
    path: "/settings/workspace?tab=localization",
    description: "Configure country localization for this workspace (currency, date format, statutory pack selection).",
  },
  "settings.access_groups": {
    id: "settings.access_groups",
    label: "Access Groups",
    path: "/settings/workspace?tab=access-groups",
    description: "Roles and permissions for users in this workspace.",
  },
  "settings.businesses": {
    id: "settings.businesses",
    label: "Companies & Branches",
    path: "/settings/company?tab=company",
    description: "Multi-business / branch configuration.",
  },

  // ── App marketplace ─────────────────────────────────────────────────────
  "apps.marketplace": {
    id: "apps.marketplace",
    label: "Apps Marketplace",
    path: "/apps",
    description: "Browse, install, and configure apps.",
  },
};

export type RouteCatalogId = keyof typeof ROUTE_CATALOG;

export function isCatalogId(id: string): id is RouteCatalogId {
  return Object.prototype.hasOwnProperty.call(ROUTE_CATALOG, id);
}

export function resolveCatalogPath(id: string): string | null {
  return isCatalogId(id) ? ROUTE_CATALOG[id].path : null;
}

/**
 * Compact catalog summary for injection into the system prompt.
 * Keep it terse — the model only needs `id → label + description + path`.
 */
export function buildCatalogPromptBlock(): string {
  const lines = Object.values(ROUTE_CATALOG).map(
    (e) => `- ${e.id} → ${e.label} (${e.path}) — ${e.description}`,
  );
  return [
    "AVAILABLE_NAVIGATION_TARGETS (only these ids may be used in action blocks):",
    ...lines,
  ].join("\n");
}
