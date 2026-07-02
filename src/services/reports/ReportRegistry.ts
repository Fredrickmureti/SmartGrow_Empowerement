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

export interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  category: ReportCategory;
  /** Full route, may include query string for deep-linking into a tab. */
  path: string;
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
    icon: Boxes,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "inventory-gl-reconciliation",
    keywords: ["inventory", "stock", "reconciliation", "gl", "drift", "valuation", "integrity"],
  },
  {
    id: "bank-reconciliation-report",
    name: "Bank Reconciliation Report",
    description: "Every reconciliation session with matched / unmatched / drift",
    category: "audit",
    path: "/finance/reports/bank-reconciliation",
    icon: Landmark,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "bank-reconciliation",
    keywords: ["bank", "reconciliation", "statement", "matched", "unmatched", "drift"],
  },
  {
    id: "pos-shift-gl-integrity",
    name: "POS Shift GL Integrity",
    description: "Per-shift GL posting status and close-time errors",
    category: "audit",
    path: "/finance/reports/pos-shift-gl-integrity",
    icon: ShieldCheck,
    requiredFeature: "reports_financial",
    permission: "viewReports",
    reportType: "pos-shift-gl-integrity",
    keywords: ["pos", "shift", "gl", "posting", "integrity", "close errors"],
  },
  {
    id: "stock-adjustments-report",
    name: "Stock Adjustments Report",
    description: "Operational adjustments with cost impact",
    category: "inventory",
    path: "/finance/reports/stock-adjustments",
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
    icon: Boxes,
    requiredFeature: "reports_stock",
    permission: "viewReports",
    reportType: "stock",
    keywords: ["stock", "inventory", "valuation", "movement", "warehouse"],
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
    path: "/hr/employees/reports",
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
