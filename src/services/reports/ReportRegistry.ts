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
  Building2, BookOpen, Wallet, ScrollText, Landmark, HandCoins,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/permissions";

export type ReportCategory =
  | "statutory"
  | "management"
  | "lending"
  | "cash_bank"
  | "fixed_assets"
  | "audit"
  | "intelligence";

/**
 * Reporting domains. A domain is the workspace a report belongs to — the set
 * of reports a user moves between without leaving their reporting context.
 */
export type ReportDomain =
  | "finance"
  | "lending";

export const REPORT_DOMAIN_LABELS: Record<ReportDomain, string> = {
  finance: "Finance",
  lending: "Lending",
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
  lending: "Lending & Portfolio",
  management: "Management & Analytics",
  cash_bank: "Cash & Banking",
  fixed_assets: "Fixed Assets",
  audit: "Audit & Compliance",
};

export const REPORT_CATEGORY_ORDER: ReportCategory[] = [
  "lending",
  "statutory",
  "cash_bank",
  "audit",
  "management",
  "fixed_assets",
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

  // ─── Lending & portfolio ───
  {
    id: "loan-portfolio",
    name: "Loan Portfolio",
    description: "Outstanding principal, interest and fees per loan",
    category: "lending",
    path: "/lending/reports/portfolio",
    icon: HandCoins,
    permission: "viewReports",
    reportType: "loan-portfolio",
    domain: "lending",
    keywords: ["loan portfolio", "outstanding", "loans", "principal", "lending"],
  },
  {
    id: "loan-arrears",
    name: "Arrears & PAR",
    description: "Overdue installments, aging buckets and portfolio at risk",
    category: "lending",
    path: "/lending/reports/arrears",
    icon: Clock,
    permission: "viewReports",
    reportType: "loan-arrears",
    domain: "lending",
    keywords: ["arrears", "par", "portfolio at risk", "aging", "dpd", "overdue"],
  },
  {
    id: "loan-collections",
    name: "Collections",
    description: "Repayments received in the selected period",
    category: "lending",
    path: "/lending/reports/collections",
    icon: Wallet,
    permission: "viewReports",
    reportType: "loan-collections",
    domain: "lending",
    keywords: ["collections", "repayments", "receipts", "lending"],
  },
  {
    id: "loan-disbursements",
    name: "Disbursements",
    description: "Loans disbursed in the selected period",
    category: "lending",
    path: "/lending/reports/disbursements",
    icon: Landmark,
    permission: "viewReports",
    reportType: "loan-disbursements",
    domain: "lending",
    keywords: ["disbursements", "disbursed", "payouts", "lending"],
  },
  {
    id: "client-statement",
    name: "Client statement",
    description: "Disbursements and repayments for one client across all their loans",
    category: "lending",
    path: "/lending/reports/client-statement",
    icon: Receipt,
    permission: "viewReports",
    reportType: "client-statement",
    domain: "lending",
    keywords: ["client statement", "statement", "account", "client", "history", "lending"],
  },
  {
    id: "officer-collections",
    name: "Officer & branch collections",
    description: "Collections performance by loan officer and branch",
    category: "lending",
    path: "/lending/reports/officer-collections",
    icon: Wallet,
    permission: "viewReports",
    reportType: "officer-collections",
    domain: "lending",
    keywords: ["officer", "branch", "collections", "performance", "lending"],
  },
  {
    id: "par-aging",
    name: "PAR aging",
    description: "Portfolio at risk by days-past-due bucket",
    category: "lending",
    path: "/lending/reports/par-aging",
    icon: Clock,
    permission: "viewReports",
    reportType: "par-aging",
    domain: "lending",
    keywords: ["par", "aging", "dpd", "risk", "arrears", "lending"],
  },
  {
    id: "product-performance",
    name: "Product performance",
    description: "Disbursement, yield and arrears by loan product",
    category: "lending",
    path: "/lending/reports/product-performance",
    icon: BarChart3,
    permission: "viewReports",
    reportType: "product-performance",
    domain: "lending",
    keywords: ["product", "performance", "yield", "loan product", "lending"],
  },
  {
    id: "client-exposure",
    name: "Client exposure",
    description: "Total outstanding exposure per client across loans",
    category: "lending",
    path: "/lending/reports/client-exposure",
    icon: Users,
    permission: "viewReports",
    reportType: "client-exposure",
    domain: "lending",
    keywords: ["client", "exposure", "outstanding", "concentration", "lending"],
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






  // ─── Budget & Fixed Assets ───

  // ─── Analytic accounting (management dimension of the GL) ───

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

  // ─── Module-local reports (Phase A: registered so the command palette,
  // favorites, permissions, and access-log apply uniformly across modules).
  // The pages themselves continue to live in their modules; the registry is
  // purely the index. Do NOT create a parallel module-local registry. ───
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
  ["/lending/reports", "lending"],
  ["/finance/reports", "finance"],
  ["/reports", "finance"],
];

/**
 * The domain a report belongs to. Explicit `domain` wins, then the path
 * prefix; finance is the fallback.
 */
export function getReportDomain(def: ReportDefinition): ReportDomain {
  if (def.domain) return def.domain;
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
  ["depreciation-report", "financial-statements"],
  ["control-account-reconciliation", "partner-ledger"],
  ["bank-reconciliation-report", "cash-flow"],
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
 * the longest matching registered path so `/finance/reports/general-ledger`
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
