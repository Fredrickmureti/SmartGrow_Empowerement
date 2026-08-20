/**
 * Report Registry — single source of truth for ALL reports
 *
 * Consumed by:
 *  - The global command palette (`src/lib/command/buildIndex.ts`)
 *  - The Report Center page (`src/pages/finance/ReportCenter.tsx`)
 *  - The in-page report search (`ReportSearchPalette`)
 *
 * Adding a new report? Add ONE entry here. Both palette and Report
 * Center will pick it up. Never duplicate this list inside a page.
 */

import {
  FileText, BarChart3, PieChart, TrendingUp, Calculator,
  Receipt, Users, ShieldCheck, Boxes, DollarSign, Clock, Scale,
  Building2, BookOpen, Wallet, ScrollText, Landmark,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/permissions";

export type ReportCategory =
  | "statutory"
  | "management"
  | "receivables"
  | "payables"
  | "cash_bank"
  | "tax"
  | "budget"
  | "fixed_assets"
  | "inventory"
  | "audit"
  | "intelligence";

/**
 * Reporting domains. A domain is the workspace a report belongs to — the set
 * of reports a user moves between without leaving their reporting context.
 */
export type ReportDomain =
  | "finance"
  | "payroll"
  | "hr"
  | "sales"
  | "purchases"
  | "inventory"
  | "pos"
  | "projects"
  | "crm";

export const REPORT_DOMAIN_LABELS: Record<ReportDomain, string> = {
  finance: "Finance",
  payroll: "Payroll",
  hr: "People",
  sales: "Sales",
  purchases: "Purchases",
  inventory: "Inventory",
  pos: "Point of sale",
  projects: "Projects",
  crm: "CRM",
};

export interface ReportDefinition {
  id: string;
  name: string;

  description: string;
  category: ReportCategory;
  /** Full route, may include query string for deep-linking into a tab. */
  path: string;
  /**
   * Dual-host mounts. Inventory reports are reachable from BOTH the Finance
   * reports shell and the Inventory app shell — same page component, two
   * mount points — so a user never gets thrown into another app by clicking a
   * report. `path` stays the canonical URL (search, scheduling, run history).
   * Resolve a link with `resolveReportPath(def, pathname)`.
   */
  paths?: { finance: string; inventory: string };
  icon: LucideIcon;
  /** Plan/feature gate (secondary). Permission is the primary gate. */
  requiredFeature?: string;
  /** Permission required — primary gate. */
  permission?: Permission;
  /** Aliases & search tokens. */
  keywords: string[];
  /** Stable identifier used by access logging / favorites. */
  reportType: string;
  /** Optional: groups child leaves under a parent hub for UI rendering. */
  parentId?: string;
  /**
   * Reporting domain. Drives the in-report switcher strip: a report can only
   * switch to siblings inside its own domain. Derived from `path` when omitted
   * (see `getReportDomain`) so existing entries need no per-entry annotation.
   */
  domain?: ReportDomain;
  /**
   * Cross-domain relationships that are semantically meaningful (Trial Balance
   * ⇄ General Ledger, Payroll Summary ⇄ Statutory). Ids only; never invent a
   * relationship that does not exist in the business model.
   */
  relatedReports?: string[];
  /**
   * Drill-down capability of this report, for classification and for the UI
   * to decide whether to advertise investigation affordances.
   *  - `none`   : aggregate has no legitimate underlying detail (D0/D4)
   *  - `dialog` : detail opens in place, preserving report context (D1)
   *  - `route`  : detail is a separate route carrying scope params forward
   */
  drillDown?: "none" | "dialog" | "route";
}


export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  statutory: "Financial Statements",
  management: "Management & Analytics",
  receivables: "Receivables & Sales",
  payables: "Payables & Purchases",
  cash_bank: "Cash & Banking",
  tax: "Tax & Compliance",
  budget: "Budget & Planning",
  fixed_assets: "Fixed Assets",
  inventory: "Inventory & Stock",
  audit: "Audit & Compliance",
  intelligence: "Business Intelligence",
};

export const REPORT_CATEGORY_ORDER: ReportCategory[] = [
  "statutory",
  "receivables",
  "payables",
  "cash_bank",
  "audit",
  "tax",
  "management",
  "budget",
  "fixed_assets",
  "inventory",
  "intelligence",
];

export const REPORT_REGISTRY: ReportDefinition[] = [
  // ─── Statutory / Financial Statements ───
  {
    id: "financial-statements",
    name: "Financial Statements",
    description: "P&L and Balance Sheet (IAS 1 / IFRS presentation)",
    category: "statutory",
    path: "/finance/reports/financial",
    icon: FileText,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "financial",
    keywords: ["financial statements", "statements", "ifrs", "ias"],
  },
  {
    id: "profit-and-loss",
    name: "Profit & Loss",
    description: "Income and expenses for a period",
    category: "statutory",
    path: "/finance/reports/financial?view=pnl",
    icon: TrendingUp,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "financial",
    parentId: "financial-statements",
    keywords: ["p&l", "pnl", "profit", "loss", "income statement", "revenue", "earnings"],
  },
  {
    id: "balance-sheet",
    name: "Balance Sheet",
    description: "Assets, liabilities, and equity as of a date",
    category: "statutory",
    path: "/finance/reports/financial?view=balance_sheet",
    icon: Scale,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "financial",
    parentId: "financial-statements",
    keywords: ["balance sheet", "bs", "assets", "liabilities", "equity", "financial position", "net worth"],
  },
  {
    id: "trial-balance",
    name: "Trial Balance",
    description: "Account balances with debit/credit totals",
    category: "statutory",
    path: "/finance/reports/trial-balance",
    icon: Calculator,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "trial-balance",
    keywords: ["trial", "balance", "tb", "debit", "credit", "verification"],
  },
  {
    id: "general-ledger",
    name: "General Ledger",
    description: "All transactions by account with running balances",
    category: "statutory",
    path: "/finance/reports/general-ledger",
    icon: BookOpen,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "general-ledger",
    keywords: ["general", "ledger", "gl", "transactions", "register", "account history"],
  },
  {
    id: "journal-report",
    name: "Journal Report",
    description: "Journal entries listed by date and reference",
    category: "statutory",
    path: "/finance/reports/journal-report",
    icon: ScrollText,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "journal-report",
    keywords: ["journal", "entries", "postings", "je"],
  },

  // ─── Cash & Banking ───
  {
    id: "cash-flow",
    name: "Cash Flow Statement",
    description: "Operating, investing, and financing cash flows",
    category: "cash_bank",
    path: "/finance/reports/cash-flow",
    icon: Wallet,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "cash-flow",
    keywords: ["cash", "flow", "cf", "operating", "investing", "financing"],
  },

  // ─── Receivables ───
  {
    id: "aged-receivables",
    name: "Aged Receivables",
    description: "Outstanding customer invoices by age bucket",
    category: "receivables",
    path: "/finance/reports/aging?type=receivable",
    icon: Clock,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "aging-receivable",
    keywords: ["aged receivables", "ar aging", "ar", "overdue customers", "collections", "receivables"],
  },
  {
    id: "aged-payables",
    name: "Aged Payables",
    description: "Outstanding vendor bills by age bucket",
    category: "payables",
    path: "/finance/reports/aging?type=payable",
    icon: Clock,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "aging-payable",
    keywords: ["aged payables", "ap aging", "ap", "overdue vendors", "payments due", "payables"],
  },
  {
    id: "purchase-reports",
    name: "Purchase Reports",
    description: "Spend analysis by supplier, product, category, account, branch or month",
    category: "payables",
    path: "/finance/reports/purchases",
    icon: TrendingUp,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "purchases",
    keywords: ["purchases", "spend", "supplier", "vendor", "bills", "procurement analysis"],
    // Supplier → their bills for the period, in place (context preserved).
    drillDown: "dialog",
  },
  {
    id: "partner-ledger",
    name: "Partner Ledger",
    description: "Transactions grouped by customer/supplier",
    category: "receivables",
    path: "/finance/reports/partner-ledger",
    icon: Users,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "partner-ledger",
    keywords: ["partner", "customer", "vendor", "supplier", "statement", "ledger"],
  },
  {
    id: "sales-reports",
    name: "Sales Reports",
    description: "Revenue analysis by customer, product, period",
    category: "receivables",
    path: "/finance/reports/sales",
    icon: TrendingUp,
    requiredFeature: "reports_sales",
    permission: "viewReports",
    reportType: "sales",
    keywords: ["sales", "revenue", "top customers", "top products"],
    // Customer → their invoices for the period, in place (context preserved).
    drillDown: "dialog",
  },

  // ─── Tax & Compliance ───
  {
    id: "tax-reports",
    name: "Tax Summary",
    description: "Tax collected and paid for a period",
    category: "tax",
    path: "/finance/reports/tax",
    icon: Receipt,
    requiredFeature: "reports_tax",
    permission: "viewReports",
    reportType: "tax",
    keywords: ["tax", "vat", "gst", "sales tax", "tax return", "compliance"],
  },

  // ─── Audit ───
  {
    id: "audit-trail",
    name: "Audit Trail",
    description: "Complete audit log of all system changes",
    category: "audit",
    path: "/finance/reports/audit-trail",
    icon: ShieldCheck,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "audit-trail",
    keywords: ["audit", "trail", "log", "changes", "activity", "compliance"],
    relatedReports: ["report-run-history"],
  },
  {
    id: "report-run-history",
    name: "Report Run History",
    description:
      "Every report rendition produced by the engine — actor, parameters, size and run hash",
    category: "audit",
    path: "/finance/reports/run-history",
    icon: ShieldCheck,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "report_run_history",
    keywords: ["report", "run", "history", "rendition", "export", "audit", "log"],
    relatedReports: ["audit-trail"],
  },
  {
    id: "control-account-reconciliation",
    name: "Control Account Reconciliation",
    description: "AR / AP sub-ledger vs GL control-account integrity check",
    category: "audit",
    path: "/finance/reports/control-account-reconciliation",
    icon: Scale,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "control-account-reconciliation",
    keywords: ["control account", "reconciliation", "ar", "ap", "subledger", "integrity", "drift"],
  },
  {
    id: "inventory-gl-reconciliation",
    name: "Inventory ⇄ GL Reconciliation",
    description: "Stock subledger (cost) vs General Ledger inventory account",
    category: "audit",
    path: "/finance/reports/inventory-gl-reconciliation",
    paths: { finance: "/finance/reports/inventory-gl-reconciliation", inventory: "/inventory-app/reports/inventory-gl-reconciliation" },
    icon: Boxes,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "inventory-gl-reconciliation",
    keywords: ["inventory", "stock", "reconciliation", "gl", "drift", "valuation", "integrity"],
  },
  {
    id: "bank-reconciliation-report",
    name: "Bank Reconciliation",
    description: "Bank-to-book proof at a date, plus the sessions behind it",
    category: "cash_bank",
    path: "/finance/reports/bank-reconciliation",
    icon: Landmark,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "bank-reconciliation",
    keywords: ["bank", "reconciliation", "statement", "matched", "unmatched", "drift"],
  },
  {
    id: "stock-adjustments-report",
    name: "Stock Adjustments Report",
    description: "Operational adjustments with cost impact",
    category: "inventory",
    path: "/finance/reports/stock-adjustments",
    paths: { finance: "/finance/reports/stock-adjustments", inventory: "/inventory-app/reports/stock-adjustments" },
    icon: Boxes,
    requiredFeature: "reports_stock",
    permission: "viewReports",
    reportType: "stock-adjustments",
    keywords: ["stock", "adjustment", "shrinkage", "wastage", "cost impact"],
  },
  {
    id: "stock-transfers-report",
    name: "Stock Transfers Report",
    description: "Inter-warehouse / inter-branch transfer activity",
    category: "inventory",
    path: "/finance/reports/stock-transfers",
    paths: { finance: "/finance/reports/stock-transfers", inventory: "/inventory-app/reports/stock-transfers" },
    icon: Boxes,
    requiredFeature: "reports_stock",
    permission: "viewReports",
    reportType: "stock-transfers",
    keywords: ["stock", "transfer", "warehouse", "branch", "in transit", "variance"],
  },
  {
    id: "fx-revaluation",
    name: "FX Revaluation",
    description: "Unrealized gain/loss on foreign-currency monetary balances",
    category: "statutory",
    path: "/finance/reports/fx-revaluation",
    icon: TrendingUp,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "fx-revaluation",
    keywords: ["fx", "foreign exchange", "revaluation", "unrealized", "gain", "loss", "currency"],
  },
  {
    id: "fx-exposure",
    name: "FX Exposure",
    description: "Open foreign-currency balances with the rate used and its source",
    category: "statutory",
    path: "/finance/reports/fx-exposure",
    icon: TrendingUp,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "fx-exposure",
    keywords: ["fx", "exposure", "foreign exchange", "currency", "receivable", "payable", "unrealized"],
  },





  // ─── Budget & Fixed Assets ───
  {
    id: "budget-report",
    name: "Budget vs Actual",
    description: "Compare budgeted amounts to actual results",
    category: "budget",
    path: "/finance/reports/budget",
    icon: PieChart,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "budget",
    keywords: ["budget", "variance", "actual", "forecast"],
  },
  {
    id: "depreciation-report",
    name: "Depreciation Schedule",
    description: "Asset depreciation over time",
    category: "fixed_assets",
    path: "/finance/reports/depreciation",
    icon: Landmark,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "depreciation",
    keywords: ["depreciation", "fixed assets", "amortization", "schedule"],
  },

  // ─── Inventory ───
  {
    id: "stock-reports",
    name: "Stock Reports",
    description: "Inventory valuation and movement",
    category: "inventory",
    path: "/finance/reports/stock",
    paths: { finance: "/finance/reports/stock", inventory: "/inventory-app/reports" },
    icon: Boxes,
    requiredFeature: "reports_stock",
    permission: "viewReports",
    reportType: "stock",
    keywords: ["stock", "inventory", "valuation", "movement", "warehouse"],
  },
  {
    // Value ledger, as at a date. Reads `report_inventory_valuation_as_of`
    // (cost-layer reconstruction), never live on-hand × current AVCO.
    id: "inventory-valuation",
    name: "Inventory Valuation",
    description: "Cost-layer inventory value as at a date",
    category: "inventory",
    path: "/inventory-app/reports/valuation",
    paths: { finance: "/finance/reports/inventory-valuation", inventory: "/inventory-app/reports/valuation" },
    icon: Boxes,
    requiredFeature: "reports_stock",
    permission: "viewReports",
    reportType: "inventory_valuation",
    keywords: ["inventory", "valuation", "cost", "avco", "as of", "stock value"],
  },
  {
    // Quantity ledger for a period. Reads `report_stock_ledger`; closing qty
    // ties to Inventory Valuation's qty on hand at the same date.
    id: "stock-ledger",
    name: "Stock Ledger",
    description: "Opening, movement and closing quantities per product",
    category: "inventory",
    path: "/inventory-app/reports/ledger",
    paths: { finance: "/finance/reports/stock-ledger", inventory: "/inventory-app/reports/ledger" },
    icon: Boxes,
    requiredFeature: "reports_stock",
    permission: "viewReports",
    reportType: "stock_ledger",
    keywords: ["stock", "ledger", "movement", "opening", "closing", "quantity"],
  },
  {
    // Ages remaining cost layers (not products) as at a date; bucket values
    // tie to Inventory Valuation total value for the same date.
    id: "stock-aging",
    name: "Stock Aging",
    description: "Cost layers bucketed by age as at a date",
    category: "inventory",
    path: "/inventory-app/reports/aging",
    paths: { finance: "/finance/reports/stock-aging", inventory: "/inventory-app/reports/aging" },
    icon: Boxes,
    requiredFeature: "reports_stock",
    permission: "viewReports",
    reportType: "inventory_aging",
    keywords: ["stock", "aging", "slow moving", "obsolete", "old stock", "buckets"],
  },
  {
    // Phase 7 — lot / serial traceability. Value uses the same shared cost-layer
    // helper as Inventory Valuation (lot grain), so totals tie at the same date.
    id: "lot-traceability",
    name: "Lot Traceability",
    description: "Lot / serial positions, expiry and control status as at a date",
    category: "inventory",
    path: "/inventory-app/reports/lot-traceability",
    paths: { finance: "/finance/reports/lot-traceability", inventory: "/inventory-app/reports/lot-traceability" },
    icon: Boxes,
    requiredFeature: "reports_stock",
    permission: "viewReports",
    reportType: "lot_traceability",
    keywords: [
      "lot",
      "batch",
      "serial",
      "traceability",
      "expiry",
      "shelf life",
      "recall",
      "quarantine",
      "genealogy",
    ],
  },

  // ─── Management & BI ───
  {
    id: "management-reports",
    name: "Management Reports",
    description: "KPIs, margins, and operational metrics",
    category: "management",
    path: "/finance/reports/management",
    icon: BarChart3,
    requiredFeature: "reports_management",
    permission: "viewReports",
    reportType: "management",
    keywords: ["management", "executive", "kpi", "margins", "summary", "dashboard"],
  },
  {
    id: "business-intelligence",
    name: "Business Intelligence",
    description: "Interactive dashboards and custom analysis",
    category: "intelligence",
    path: "/finance/reports/intelligence",
    icon: BarChart3,
    requiredFeature: "business_intelligence",
    permission: "viewReports",
    reportType: "intelligence",
    keywords: ["intelligence", "analytics", "insights", "dashboard", "bi", "custom", "forecast", "health"],
  },
  {
    id: "project-full-export",
    name: "Project Full Export",
    description: "Single-project deep export — overview, milestones, tasks, timesheets, profitability, updates",
    category: "management",
    path: "/projects-app/reports?key=project_full_export",
    icon: FileText,
    permission: "viewReports",
    reportType: "project_full_export",
    keywords: ["project", "export", "full", "deep", "profitability", "milestones", "timesheets"],
  },

  // ─── Module-local reports (Phase A: registered so the command palette,
  // favorites, permissions, and access-log apply uniformly across modules).
  // The pages themselves continue to live in their modules; the registry is
  // purely the index. Do NOT create a parallel module-local registry. ───
  {
    id: "pos-reports",
    name: "POS Reports",
    description: "X / Z / shift reports, payment mix, register performance",
    category: "management",
    path: "/pos/reports",
    icon: BarChart3,
    permission: "viewPOSReports",
    reportType: "pos",
    keywords: ["pos", "shift", "x report", "z report", "register", "till", "drawer"],
  },
  {
    id: "hr-reports",
    name: "HR Reports",
    description: "Headcount, turnover, employee analytics",
    category: "management",
    path: "/hr/reports",
    icon: Users,
    permission: "viewReports",
    reportType: "hr",
    keywords: ["hr", "people", "headcount", "turnover", "employees"],
  },
  {
    id: "attendance-reports",
    name: "Attendance Reports",
    description: "Clock-in / clock-out, lateness, presence",
    category: "management",
    path: "/hr/attendance/reports",
    icon: Clock,
    permission: "viewReports",
    reportType: "attendance",
    keywords: ["attendance", "clock", "presence", "lateness", "absence"],
  },
  {
    id: "payroll-reports",
    name: "Payroll Reports",
    description: "Payroll runs, payslips, statutory summaries",
    category: "management",
    path: "/hr/payroll/reports",
    icon: DollarSign,
    permission: "viewPayroll",
    reportType: "payroll",
    keywords: ["payroll", "payslip", "payslips", "salary", "statutory", "remittance"],
  },
  {
    id: "project-reports",
    name: "Project Reports",
    description: "Portfolio reports — profitability, milestones, burndown",
    category: "management",
    path: "/projects-app/reports",
    icon: BarChart3,
    permission: "viewReports",
    reportType: "projects",
    keywords: ["project", "portfolio", "burndown", "profitability"],
  },
  {
    id: "timesheet-reports",
    name: "Timesheet Reports",
    description: "Hours by employee / project / billable status",
    category: "management",
    path: "/timesheets/reports",
    icon: Clock,
    permission: "viewReports",
    reportType: "timesheets",
    keywords: ["timesheet", "hours", "billable", "utilization"],
  },
];

/** Search reports by keyword (name, description, or aliases). */
export function searchReports(query: string): ReportDefinition[] {
  if (!query.trim()) return REPORT_REGISTRY;
  const lower = query.toLowerCase();
  return REPORT_REGISTRY.filter(r =>
    r.name.toLowerCase().includes(lower) ||
    r.description.toLowerCase().includes(lower) ||
    r.keywords.some(k => k.includes(lower))
  );
}

/** Get reports grouped by category, in display order. */
export function getReportsByCategory(): Map<ReportCategory, ReportDefinition[]> {
  const map = new Map<ReportCategory, ReportDefinition[]>();
  for (const cat of REPORT_CATEGORY_ORDER) {
    const reports = REPORT_REGISTRY.filter(r => r.category === cat);
    if (reports.length > 0) map.set(cat, reports);
  }
  return map;
}

/** Lookup by reportType (used for favorites mapping). */
export function getReportsByType(reportType: string): ReportDefinition[] {
  return REPORT_REGISTRY.filter(r => r.reportType === reportType);
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace spine — domain resolution, report switching and relationships.
// One owner: no page may hard-code its sibling or related-report list.
// ─────────────────────────────────────────────────────────────────────────────

/** Path-prefix → domain. Longest prefix wins. */
const DOMAIN_BY_PATH_PREFIX: Array<[string, ReportDomain]> = [
  ["/hr/payroll/reports", "payroll"],
  ["/hr/attendance/reports", "hr"],
  ["/hr/reports", "hr"],
  ["/pos/reports", "pos"],
  ["/projects-app/reports", "projects"],
  ["/timesheets/reports", "projects"],
  ["/crm/reports", "crm"],
  ["/finance/reports", "finance"],
  ["/reports", "finance"],
];

/** Category → domain, used when the path is not decisive. */
const DOMAIN_BY_CATEGORY: Partial<Record<ReportCategory, ReportDomain>> = {
  inventory: "inventory",
  receivables: "sales",
  payables: "purchases",
};

/**
 * The domain a report belongs to. Explicit `domain` wins; then a
 * category override for inventory / receivables / payables (those live under
 * the finance routes but belong to their own reporting workspace); then the
 * path prefix; finance is the fallback.
 */
export function getReportDomain(def: ReportDefinition): ReportDomain {
  if (def.domain) return def.domain;
  const byCategory = DOMAIN_BY_CATEGORY[def.category];
  if (byCategory) return byCategory;
  const prefix = DOMAIN_BY_PATH_PREFIX
    .filter(([p]) => def.path.startsWith(p))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return prefix?.[1] ?? "finance";
}

/** Every report inside one reporting workspace, registry order preserved. */
export function getReportsByDomain(domain: ReportDomain): ReportDefinition[] {
  return REPORT_REGISTRY.filter((r) => getReportDomain(r) === domain);
}

/**
 * Semantic cross-domain relationships. Declared symmetrically — a pair listed
 * here is related in both directions. Derived from domain semantics only:
 * a report is related to another when an accountant / payroll officer would
 * routinely open the second to explain the first.
 */
const REPORT_RELATION_PAIRS: Array<[string, string]> = [
  ["trial-balance", "general-ledger"],
  ["trial-balance", "journal-report"],
  ["general-ledger", "journal-report"],
  ["general-ledger", "partner-ledger"],
  ["financial-statements", "trial-balance"],
  ["financial-statements", "cash-flow"],
  ["aged-receivables", "partner-ledger"],
  ["aged-receivables", "sales-reports"],
  ["aged-payables", "partner-ledger"],
  ["aged-payables", "purchase-reports"],
  ["purchase-reports", "sales-reports"],
  ["budget-report", "financial-statements"],
  ["depreciation-report", "financial-statements"],
  ["stock-reports", "inventory-gl-reconciliation"],
  ["stock-adjustments-report", "stock-reports"],
  ["stock-transfers-report", "stock-reports"],
  ["control-account-reconciliation", "partner-ledger"],
  ["bank-reconciliation-report", "cash-flow"],
  ["payroll-reports", "hr-reports"],
  ["payroll-reports", "attendance-reports"],
  ["timesheet-reports", "project-reports"],
  ["pos-reports", "sales-reports"],
];

/**
 * Reports related to `id`: the declared pairs above plus any explicit
 * `relatedReports` on the definition. Unknown ids are dropped, so a stale
 * relation can never render a dead link.
 */
export function getRelatedReports(id: string): ReportDefinition[] {
  const def = REPORT_REGISTRY.find((r) => r.id === id);
  const ids = new Set<string>(def?.relatedReports ?? []);
  for (const [a, b] of REPORT_RELATION_PAIRS) {
    if (a === id) ids.add(b);
    if (b === id) ids.add(a);
  }
  ids.delete(id);
  return REPORT_REGISTRY.filter((r) => ids.has(r.id));
}

/**
 * Resolve the registry entry for a pathname (ignoring query string). Prefers
 * the longest matching registered path so `/finance/reports/stock-transfers`
 * does not resolve to `/finance/reports/stock`.
 */
export function reportMountPaths(def: ReportDefinition): string[] {
  const all = def.paths
    ? [def.path, def.paths.finance, def.paths.inventory]
    : [def.path];
  return Array.from(new Set(all.map((p) => p.split("?")[0])));
}

export function findReportByPath(pathname: string): ReportDefinition | undefined {
  let best: { def: ReportDefinition; len: number } | undefined;
  for (const r of REPORT_REGISTRY) {
    for (const base of reportMountPaths(r)) {
      if (pathname === base || pathname.startsWith(`${base}/`)) {
        if (!best || base.length > best.len) best = { def: r, len: base.length };
      }
    }
  }
  return best?.def;
}
