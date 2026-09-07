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
 *
 * Scope: this is a Kenyan microfinance system. The catalog covers lending,
 * finance and settings only. The retired ERP/HR/payroll destinations were
 * removed because those routes no longer exist in the application.
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
  // ── Lending ─────────────────────────────────────────────────────────────
  "lending.overview": {
    id: "lending.overview",
    label: "Lending Overview",
    path: "/lending",
    requires_app: "microfinance",
    description: "Portfolio dashboard: active loans, arrears, collections.",
  },
  "lending.clients": {
    id: "lending.clients",
    label: "Borrowers",
    path: "/lending/clients",
    requires_app: "microfinance",
    description: "Borrower directory, KYC records and loan history.",
  },
  "lending.groups": {
    id: "lending.groups",
    label: "Groups",
    path: "/lending/groups",
    requires_app: "microfinance",
    description: "Groups and centres, membership and meeting schedules.",
  },
  "lending.applications": {
    id: "lending.applications",
    label: "Loan Applications",
    path: "/lending/applications",
    requires_app: "microfinance",
    description: "Applications with assessment and approval status.",
  },
  "lending.loans": {
    id: "lending.loans",
    label: "Loans",
    path: "/lending/loans",
    requires_app: "microfinance",
    description: "Loan accounts, schedules and balances.",
  },
  "lending.repayments": {
    id: "lending.repayments",
    label: "Repayments",
    path: "/lending/repayments",
    requires_app: "microfinance",
    description: "Recorded repayments, receipts and allocations.",
  },
  "lending.collections": {
    id: "lending.collections",
    label: "Collections",
    path: "/lending/collections",
    requires_app: "microfinance",
    description: "Officer collection sheets and follow-up.",
  },
  "lending.products": {
    id: "lending.products",
    label: "Loan Products",
    path: "/lending/products",
    requires_app: "microfinance",
    requires_permission: "canEditSettings",
    description: "Loan product master data: terms, interest, fees, penalties.",
  },
  "lending.accounting_config": {
    id: "lending.accounting_config",
    label: "Lending Accounting Mapping",
    path: "/lending/configuration/accounting",
    requires_app: "microfinance",
    requires_permission: "canEditSettings",
    description: "Map lending events to chart-of-accounts entries.",
  },
  "lending.reports_portfolio": {
    id: "lending.reports_portfolio",
    label: "Portfolio Report",
    path: "/lending/reports/portfolio",
    requires_app: "microfinance",
    description: "Portfolio composition and outstanding principal.",
  },
  "lending.reports_arrears": {
    id: "lending.reports_arrears",
    label: "Arrears Report",
    path: "/lending/reports/arrears",
    requires_app: "microfinance",
    description: "Loans in arrears with days overdue.",
  },
  "lending.reports_par_aging": {
    id: "lending.reports_par_aging",
    label: "PAR Ageing",
    path: "/lending/reports/par-aging",
    requires_app: "microfinance",
    description: "Portfolio at risk by ageing bucket.",
  },
  "lending.reports_collections": {
    id: "lending.reports_collections",
    label: "Collections Report",
    path: "/lending/reports/collections",
    requires_app: "microfinance",
    description: "Collections by period, branch and officer.",
  },
  "lending.reports_disbursements": {
    id: "lending.reports_disbursements",
    label: "Disbursements Report",
    path: "/lending/reports/disbursements",
    requires_app: "microfinance",
    description: "Disbursements by period, branch and product.",
  },
  "lending.reports_client_statement": {
    id: "lending.reports_client_statement",
    label: "Client Statement",
    path: "/lending/reports/client-statement",
    requires_app: "microfinance",
    description: "Statement of a borrower's loans and repayments.",
  },

  // ── Finance / Accounts ──────────────────────────────────────────────────
  "finance.dashboard": {
    id: "finance.dashboard",
    label: "Finance Dashboard",
    path: "/finance/dashboard",
    requires_app: "finance",
    description: "Cash, ledger and period overview.",
  },
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
  "finance.banking": {
    id: "finance.banking",
    label: "Banking",
    path: "/finance/banking",
    requires_app: "finance",
    description: "Bank accounts and bank transactions.",
  },
  "finance.reconciliation": {
    id: "finance.reconciliation",
    label: "Bank Reconciliation",
    path: "/finance/reconciliation",
    requires_app: "finance",
    description: "Match bank transactions to recorded payments.",
  },
  "finance.fiscal_periods": {
    id: "finance.fiscal_periods",
    label: "Fiscal Periods",
    path: "/finance/fiscal-periods",
    requires_app: "finance",
    description: "Open and close accounting periods.",
  },
  "finance.reports": {
    id: "finance.reports",
    label: "Financial Reports",
    path: "/finance/reports",
    requires_app: "finance",
    description: "Trial balance, P&L, balance sheet and ledgers.",
  },
  "finance.settings": {
    id: "finance.settings",
    label: "Finance Settings",
    path: "/finance/settings",
    requires_app: "finance",
    requires_permission: "canEditSettings",
    description: "Default GL accounts and accounting configuration.",
  },

  // ── Settings ────────────────────────────────────────────────────────────
  // NOTE: tenant settings live on two hubs (`/settings/workspace`,
  // `/settings/company`) with `?tab=` segments — there is no flat
  // `/settings/<thing>` URL. Keep the catalog pointing at real, working
  // destinations; do not invent flat paths.
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
    description: "Institution and branch configuration.",
  },
  "settings.numbering": {
    id: "settings.numbering",
    label: "Document Numbering",
    path: "/settings/company?tab=numbering",
    requires_permission: "canEditSettings",
    description: "Prefixes and formats for client, loan, application and receipt numbers.",
  },
  "settings.payment_channels": {
    id: "settings.payment_channels",
    label: "Payment Channels",
    path: "/settings/company?tab=payments",
    requires_permission: "canEditSettings",
    description: "Cash, M-Pesa PayBill and bank collection channels.",
  },
  "settings.audit_logs": {
    id: "settings.audit_logs",
    label: "Audit Logs",
    path: "/settings/audit-logs",
    description: "Who changed what, and when.",
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
