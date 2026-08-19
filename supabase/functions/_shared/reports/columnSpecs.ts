/**
 * Per-report column registry — single source of truth for how every
 * server-rendered report lays out its table.
 *
 * Why this file exists (Stage B):
 *   `render-report` previously inferred columns from the first data row,
 *   producing unstable header order and ugly auto-humanised labels
 *   ("Open Dr" instead of "Opening DR", "Mov Cr" instead of "Movement CR").
 *   `process-scheduled-reports` carried its own copy of the same column
 *   definitions, guaranteeing drift.
 *
 *   This module is the ONE place those column specs live. Both the live
 *   render path and the scheduled path read from here.
 *
 * Adding a new report:
 *   1. Add the report key to `ReportType` (or operational reports map).
 *   2. Add an entry to `REPORT_SPECS` with columns + orientation + title.
 *   3. Done. Both endpoints pick it up automatically.
 */

import type { ReportColumn } from "../reportPdfGenerator.ts";

/**
 * "financial" — statutory accounting reports (BS / P&L / TB / CF / GL).
 *   Renders the formal masthead: COMPANY → Title → Period/As-of → Subtitle
 *   → Prepared on. Numbers already render as `(1,234.00)` for negatives
 *   and `—` for empty/zero (handled by DataTable + formatAccountingNumber).
 *
 * "operational" — listings, ops dashboards, ageing, stock, CRM exports.
 *   Renders the existing logo-left / title-right header. Same number
 *   formatting (negatives in parentheses is correct for any monetary
 *   column), but no formal masthead order.
 */
export type ReportFormatProfile = "financial" | "operational";

// Product requirement: every report carries the SAME masthead. That is now
// enforced in the renderer (`drawBrandedHeader` always draws the operational
// masthead — see mem/features/report-masthead-single-layout.md), so
// `formatProfile` no longer selects a header layout at all. It selects
// wording ("As of ..." vs "For the period ...") and typography density:
//   financial  → statutory statement face (10pt, statement presentation)
//   operational → register / ledger face
const TRIAL_BALANCE_PDF_PROFILE: ReportFormatProfile = "operational";

export interface ReportSpec {
  /** Default human title (overridable per-call). */
  title: string;
  /** Page orientation. Wide tables use landscape. */
  orientation: "portrait" | "landscape";
  /** Strict column order, headers, alignment, format. */
  columns: ReportColumn[];
  /**
   * Stage 3: drives masthead style + future format conventions.
   * Defaults to "operational" when omitted, so unregistered or legacy
   * reports keep their current behavior.
   */
  formatProfile?: ReportFormatProfile;
  /** Optional default subtitle (e.g. "Accrual Basis"). */
  subtitle?: string;
  /**
   * Optional pin for the PDF presentation profile (typography + density).
   * Leave unset for the standard derivation: "financial" reports render as
   * `statement`, and everything else grades to `ledger` or `operational`
   * by column count. Pin it only when a specific report needs to defy that
   * (e.g. a wide statutory schedule that must stay statement-sized).
   */
  presentationProfile?: "statement" | "ledger" | "operational";
}

/**
 * The canonical registry. Keys must exactly match the report_type
 * string used by `buildReportData` and the scheduled-report DB rows.
 */
export const REPORT_SPECS: Record<string, ReportSpec> = {
  // ─── Statutory / financial reports ───────────────────────────────
  balance_sheet: {
    title: "Balance Sheet",
    orientation: "portrait",
    columns: [
      { key: "name", header: "Account", width: 60, align: "left", format: "text" },
      { key: "balance", header: "Balance", width: 40, align: "right", format: "currency" },
    ],
    formatProfile: "financial",
    presentationProfile: "statement",
  },
  trial_balance: {
    title: "Trial Balance",
    orientation: "landscape",
    formatProfile: TRIAL_BALANCE_PDF_PROFILE,
    columns: [
      { key: "code", header: "Code", width: 10, align: "left", format: "text" },
      { key: "name", header: "Account Name", width: 22, align: "left", format: "text" },
      { key: "open_dr", header: "Opening DR", width: 12, align: "right", format: "currency" },
      { key: "open_cr", header: "Opening CR", width: 12, align: "right", format: "currency" },
      { key: "mov_dr", header: "Movement DR", width: 12, align: "right", format: "currency" },
      { key: "mov_cr", header: "Movement CR", width: 12, align: "right", format: "currency" },
      { key: "close_dr", header: "Closing DR", width: 10, align: "right", format: "currency" },
      { key: "close_cr", header: "Closing CR", width: 10, align: "right", format: "currency" },
    ],
  },
  income_statement: {
    title: "Income Statement",
    orientation: "portrait",
    formatProfile: "financial",
    presentationProfile: "statement",
    subtitle: "Accrual Basis",
    columns: [
      { key: "name", header: "Account", width: 60, align: "left", format: "text" },
      { key: "amount", header: "Amount", width: 40, align: "right", format: "currency" },
    ],
  },
  profit_and_loss: {
    title: "Profit and Loss",
    orientation: "portrait",
    formatProfile: "financial",
    presentationProfile: "statement",
    subtitle: "Accrual Basis",
    columns: [
      { key: "name", header: "Account", width: 60, align: "left", format: "text" },
      { key: "amount", header: "Amount", width: 40, align: "right", format: "currency" },
    ],
  },
  cash_flow: {
    title: "Cash Flow Statement",
    orientation: "portrait",
    // A cash flow statement is a statutory statement: sections are semantic
    // LINES (`_kind: "section"`), never a repeated text COLUMN. The old
    // three-column "Section | Item | Amount" grid is what made the scheduled
    // PDF differ from the interactive one.
    formatProfile: "financial",
    presentationProfile: "statement",
    subtitle: "Indirect Method",
    columns: [
      { key: "item", header: "Item", width: 70, align: "left", format: "text" },
      { key: "amount", header: "Amount", width: 30, align: "right", format: "currency" },
    ],
  },
  general_ledger: {
    title: "General Ledger",
    orientation: "landscape",
    columns: [
      { key: "date", header: "Date", width: 14, align: "left", format: "date" },
      { key: "entry", header: "Entry #", width: 14, align: "left", format: "text" },
      { key: "description", header: "Description", width: 30, align: "left", format: "text" },
      { key: "debit", header: "Debit", width: 16, align: "right", format: "currency" },
      { key: "credit", header: "Credit", width: 16, align: "right", format: "currency" },
      { key: "balance", header: "Balance", width: 16, align: "right", format: "currency" },
    ],
  },
  partner_ledger: {
    title: "Partner Ledger",
    orientation: "landscape",
    columns: [
      { key: "entry_date", header: "Date", width: 14, align: "left", format: "date" },
      { key: "entry_number", header: "Entry #", width: 12, align: "left", format: "text" },
      { key: "partner_name", header: "Partner", width: 24, align: "left", format: "text" },
      { key: "partner_type", header: "Type", width: 12, align: "left", format: "text" },
      { key: "debit", header: "Debit", width: 16, align: "right", format: "currency" },
      { key: "credit", header: "Credit", width: 16, align: "right", format: "currency" },
    ],
  },
  journal_report: {
    title: "Journal Report",
    orientation: "landscape",
    columns: [
      { key: "entry_date", header: "Date", width: 13, align: "left", format: "date" },
      { key: "entry_number", header: "Entry #", width: 11, align: "left", format: "text" },
      { key: "account_name", header: "Account", width: 18, align: "left", format: "text" },
      { key: "description", header: "Description", width: 22, align: "left", format: "text" },
      { key: "source_type", header: "Source", width: 11, align: "left", format: "text" },
      { key: "debit", header: "Debit", width: 12, align: "right", format: "currency" },
      { key: "credit", header: "Credit", width: 12, align: "right", format: "currency" },
    ],
  },
  budget_vs_actual: {
    title: "Budget vs. Actual",
    orientation: "landscape",
    columns: [
      { key: "account_name", header: "Account", width: 24, align: "left", format: "text" },
      { key: "account_type", header: "Type", width: 12, align: "left", format: "text" },
      { key: "budgeted", header: "Budget", width: 16, align: "right", format: "currency" },
      { key: "actual", header: "Actual", width: 16, align: "right", format: "currency" },
      { key: "variance", header: "Variance", width: 16, align: "right", format: "currency" },
      { key: "variance_percent", header: "Var %", width: 12, align: "right", format: "percent" },
    ],
  },
  depreciation_schedule: {
    title: "Depreciation Schedule",
    orientation: "landscape",
    columns: [
      { key: "name", header: "Asset", width: 20, align: "left", format: "text" },
      { key: "asset_code", header: "Code", width: 12, align: "left", format: "text" },
      { key: "acquisition_cost", header: "Cost", width: 14, align: "right", format: "currency" },
      { key: "salvage_value", header: "Salvage", width: 12, align: "right", format: "currency" },
      { key: "accumulated_depreciation", header: "Accum Depr", width: 15, align: "right", format: "currency" },
      { key: "net_book_value", header: "NBV", width: 14, align: "right", format: "currency" },
      { key: "method", header: "Method", width: 12, align: "left", format: "text" },
    ],
  },
  audit_trail: {
    title: "Audit Trail",
    orientation: "landscape",
    columns: [
      { key: "created_at", header: "Date", width: 18, align: "left", format: "date" },
      { key: "action", header: "Action", width: 14, align: "left", format: "text" },
      { key: "entity_type", header: "Entity Type", width: 18, align: "left", format: "text" },
      { key: "entity_name", header: "Entity", width: 22, align: "left", format: "text" },
      { key: "changes_summary", header: "Summary", width: 28, align: "left", format: "text" },
    ],
  },

  // ─── Operational reports (used by scheduled reports) ─────────────
  invoice_aging: {
    title: "Invoice Aging",
    orientation: "landscape",
    columns: [
      { key: "invoice_number", header: "Invoice #", width: 18, align: "left", format: "text" },
      { key: "due_date", header: "Due Date", width: 15, align: "left", format: "date" },
      { key: "total", header: "Amount", width: 14, align: "right", format: "currency" },
      { key: "amount_paid", header: "Paid", width: 14, align: "right", format: "currency" },
      { key: "balance_due", header: "Balance Due", width: 15, align: "right", format: "currency" },
      { key: "days_overdue", header: "Days", width: 10, align: "right", format: "text" },
      { key: "bucket", header: "Bucket", width: 14, align: "left", format: "text" },
    ],
  },
  aged_payables: {
    title: "Aged Payables",
    orientation: "landscape",
    columns: [
      { key: "bill_number", header: "Bill #", width: 18, align: "left", format: "text" },
      { key: "due_date", header: "Due Date", width: 15, align: "left", format: "date" },
      { key: "total", header: "Amount", width: 14, align: "right", format: "currency" },
      { key: "amount_paid", header: "Paid", width: 14, align: "right", format: "currency" },
      { key: "balance_due", header: "Balance Due", width: 15, align: "right", format: "currency" },
      { key: "days_overdue", header: "Days", width: 10, align: "right", format: "text" },
      { key: "bucket", header: "Bucket", width: 14, align: "left", format: "text" },
    ],
  },
  sales_summary: {
    title: "Sales Summary",
    orientation: "landscape",
    columns: [
      { key: "invoice_number", header: "Invoice #", width: 18, align: "left", format: "text" },
      { key: "issue_date", header: "Date", width: 15, align: "left", format: "date" },
      { key: "status", header: "Status", width: 13, align: "left", format: "text" },
      { key: "total", header: "Total", width: 16, align: "right", format: "currency" },
      { key: "amount_paid", header: "Paid", width: 16, align: "right", format: "currency" },
      { key: "outstanding", header: "Outstanding", width: 18, align: "right", format: "currency" },
    ],
  },
  stock_report: {
    title: "Stock Report",
    orientation: "landscape",
    columns: [
      { key: "name", header: "Product", width: 28, align: "left", format: "text" },
      { key: "sku", header: "SKU", width: 18, align: "left", format: "text" },
      { key: "stock_quantity", header: "Qty", width: 12, align: "right", format: "text" },
      { key: "unit_price", header: "Unit Price", width: 16, align: "right", format: "currency" },
      { key: "total_value", header: "Total Value", width: 18, align: "right", format: "currency" },
    ],
  },
  // ─── Inventory: quantity ledger vs value ledger (Phase 2) ────────
  // Server-built from public.report_stock_ledger() /
  // public.report_inventory_valuation_as_of() via inventoryData.ts, so the
  // export carries the full dataset rather than the browser's page.
  stock_ledger: {
    title: "Stock Ledger",
    orientation: "landscape",
    subtitle: "Quantity ledger — opening, movement and closing quantities",
    columns: [
      { key: "product_name", header: "Product", width: 24, align: "left", format: "text" },
      { key: "sku", header: "SKU", width: 14, align: "left", format: "text" },
      { key: "warehouse_name", header: "Warehouse", width: 18, align: "left", format: "text" },
      { key: "opening_qty", header: "Opening", width: 11, align: "right", format: "text" },
      { key: "qty_in", header: "In", width: 10, align: "right", format: "text" },
      { key: "qty_out", header: "Out", width: 10, align: "right", format: "text" },
      { key: "closing_qty", header: "Closing", width: 11, align: "right", format: "text" },
      { key: "movement_count", header: "Movements", width: 10, align: "right", format: "text" },
    ],
  },
  inventory_valuation: {
    title: "Inventory Valuation",
    orientation: "landscape",
    formatProfile: "financial",
    subtitle: "Valued from cost layers as at the reporting date",
    columns: [
      { key: "product_name", header: "Product", width: 24, align: "left", format: "text" },
      { key: "sku", header: "SKU", width: 14, align: "left", format: "text" },
      { key: "warehouse_name", header: "Warehouse", width: 18, align: "left", format: "text" },
      { key: "qty_on_hand", header: "Qty on Hand", width: 12, align: "right", format: "text" },
      { key: "avg_unit_cost", header: "Avg Unit Cost", width: 14, align: "right", format: "currency" },
      { key: "total_value", header: "Total Value", width: 16, align: "right", format: "currency" },
      { key: "oldest_receipt_at", header: "Oldest Receipt", width: 14, align: "left", format: "text" },
      { key: "layer_count", header: "Layers", width: 8, align: "right", format: "text" },
    ],
  },

  customer_analysis: {
    title: "Customer Analysis",
    orientation: "landscape",
    columns: [
      { key: "name", header: "Name", width: 26, align: "left", format: "text" },
      { key: "email", header: "Email", width: 28, align: "left", format: "text" },
      { key: "company", header: "Company", width: 22, align: "left", format: "text" },
      { key: "is_active", header: "Active", width: 12, align: "left", format: "text" },
    ],
  },
  tax_report: {
    title: "Tax Report",
    orientation: "landscape",
    columns: [
      { key: "invoice_number", header: "Invoice #", width: 32, align: "left", format: "text" },
      { key: "tax_amount", header: "Tax Amount", width: 30, align: "right", format: "currency" },
      { key: "total", header: "Total", width: 30, align: "right", format: "currency" },
    ],
  },
  expense_report: {
    title: "Expense Report",
    orientation: "landscape",
    columns: [
      { key: "date", header: "Date", width: 14, align: "left", format: "date" },
      { key: "description", header: "Description", width: 22, align: "left", format: "text" },
      { key: "category", header: "Category", width: 14, align: "left", format: "text" },
      { key: "vendor", header: "Supplier", width: 16, align: "left", format: "text" },
      { key: "amount", header: "Amount", width: 14, align: "right", format: "currency" },
      { key: "tax", header: "Tax", width: 10, align: "right", format: "currency" },
      { key: "status", header: "Status", width: 10, align: "left", format: "text" },
    ],
  },
  purchase_orders_report: {
    title: "Purchase Orders Report",
    orientation: "landscape",
    columns: [
      { key: "po_number", header: "PO #", width: 16, align: "left", format: "text" },
      { key: "order_date", header: "Date", width: 14, align: "left", format: "date" },
      { key: "vendor", header: "Supplier", width: 20, align: "left", format: "text" },
      { key: "status", header: "Status", width: 12, align: "left", format: "text" },
      { key: "subtotal", header: "Subtotal", width: 14, align: "right", format: "currency" },
      { key: "tax", header: "Tax", width: 10, align: "right", format: "currency" },
      { key: "total", header: "Total", width: 14, align: "right", format: "currency" },
    ],
  },
  crm_pipeline_report: {
    title: "CRM Pipeline Report",
    orientation: "landscape",
    columns: [
      { key: "name", header: "Lead", width: 20, align: "left", format: "text" },
      { key: "contact", header: "Contact", width: 16, align: "left", format: "text" },
      { key: "company", header: "Company", width: 16, align: "left", format: "text" },
      { key: "stage", header: "Stage", width: 14, align: "left", format: "text" },
      { key: "expected_revenue", header: "Revenue", width: 14, align: "right", format: "currency" },
      { key: "probability", header: "Prob %", width: 10, align: "right", format: "text" },
      { key: "status", header: "Status", width: 10, align: "left", format: "text" },
    ],
  },
  contacts_directory: {
    title: "Contacts Directory",
    orientation: "landscape",
    columns: [
      { key: "name", header: "Name", width: 20, align: "left", format: "text" },
      { key: "company", header: "Company", width: 18, align: "left", format: "text" },
      { key: "type", header: "Type", width: 12, align: "left", format: "text" },
      { key: "email", header: "Email", width: 22, align: "left", format: "text" },
      { key: "phone", header: "Phone", width: 16, align: "left", format: "text" },
      { key: "city", header: "City", width: 12, align: "left", format: "text" },
    ],
  },

  // ─── Attendance (HR) reports ─────────────────────────────────────
  attendance_daily_log: {
    title: "Attendance — Daily Log",
    orientation: "landscape",
    columns: [
      { key: "employee", header: "Employee", width: 24, align: "left", format: "text" },
      { key: "employee_number", header: "Emp #", width: 12, align: "left", format: "text" },
      { key: "date", header: "Date", width: 14, align: "left", format: "date" },
      { key: "clock_in", header: "Clock In", width: 12, align: "left", format: "text" },
      { key: "clock_out", header: "Clock Out", width: 12, align: "left", format: "text" },
      { key: "worked_hours", header: "Hours", width: 10, align: "right", format: "number" },
      { key: "overtime_hours", header: "OT", width: 10, align: "right", format: "number" },
      { key: "status", header: "Status", width: 12, align: "left", format: "text" },
    ],
  },
  attendance_late_arrivals: {
    title: "Attendance — Late Arrivals",
    orientation: "landscape",
    columns: [
      { key: "employee", header: "Employee", width: 24, align: "left", format: "text" },
      { key: "date", header: "Date", width: 14, align: "left", format: "date" },
      { key: "clock_in", header: "Clock In", width: 14, align: "left", format: "text" },
      { key: "late_minutes", header: "Late (min)", width: 14, align: "right", format: "number" },
      { key: "branch", header: "Branch", width: 18, align: "left", format: "text" },
    ],
  },
  attendance_absences: {
    title: "Attendance — Absences vs Scheduled",
    orientation: "landscape",
    columns: [
      { key: "employee", header: "Employee", width: 24, align: "left", format: "text" },
      { key: "department", header: "Department", width: 18, align: "left", format: "text" },
      { key: "date", header: "Scheduled Day", width: 18, align: "left", format: "date" },
      { key: "reason", header: "Reason", width: 24, align: "left", format: "text" },
    ],
  },
  attendance_payroll_ready: {
    title: "Attendance — Payroll-Ready Hours",
    orientation: "landscape",
    columns: [
      { key: "employee", header: "Employee", width: 24, align: "left", format: "text" },
      { key: "date", header: "Date", width: 14, align: "left", format: "date" },
      { key: "worked_hours", header: "Hours", width: 12, align: "right", format: "number" },
      { key: "overtime_hours", header: "OT", width: 12, align: "right", format: "number" },
      { key: "locked", header: "Locked", width: 12, align: "left", format: "text" },
    ],
  },
  attendance_period_summary: {
    title: "Attendance — Period Summary",
    orientation: "portrait",
    columns: [
      { key: "employee", header: "Employee", width: 32, align: "left", format: "text" },
      { key: "days_worked", header: "Days", width: 10, align: "right", format: "number" },
      { key: "total_hours", header: "Hours", width: 14, align: "right", format: "number" },
      { key: "overtime_hours", header: "OT", width: 12, align: "right", format: "number" },
      { key: "absences", header: "Absences", width: 12, align: "right", format: "number" },
      { key: "late_days", header: "Late", width: 10, align: "right", format: "number" },
      { key: "avg_hours", header: "Avg/Day", width: 12, align: "right", format: "number" },
    ],
  },
};

// ─── Payroll reports (Stage 4) ───────────────────────────────────
REPORT_SPECS["payroll_register"] = {
  title: "Payroll Register",
  orientation: "landscape",
  columns: [
    { key: "employee", header: "Employee", width: 22, align: "left", format: "text" },
    { key: "employee_number", header: "Emp #", width: 10, align: "left", format: "text" },
    { key: "gross", header: "Gross", width: 14, align: "right", format: "currency" },
    { key: "statutory", header: "Statutory", width: 14, align: "right", format: "currency" },
    { key: "other_deductions", header: "Other Ded.", width: 14, align: "right", format: "currency" },
    { key: "employer_cost", header: "Employer", width: 14, align: "right", format: "currency" },
    { key: "net_pay", header: "Net Pay", width: 14, align: "right", format: "currency" },
  ],
};
REPORT_SPECS["payroll_summary"] = {
  title: "Payroll Summary",
  orientation: "landscape",
  formatProfile: "financial",
  columns: [
    { key: "payroll_number", header: "Run #", width: 14, align: "left", format: "text" },
    { key: "period", header: "Period", width: 22, align: "left", format: "text" },
    { key: "status", header: "Status", width: 12, align: "left", format: "text" },
    { key: "employee_count", header: "Employees", width: 12, align: "right", format: "number" },
    { key: "total_gross", header: "Gross", width: 14, align: "right", format: "currency" },
    { key: "total_deductions", header: "Deductions", width: 14, align: "right", format: "currency" },
    { key: "total_employer", header: "Employer", width: 14, align: "right", format: "currency" },
    { key: "total_net", header: "Net Pay", width: 14, align: "right", format: "currency" },
  ],
};
REPORT_SPECS["employer_contributions"] = {
  title: "Employer Contributions",
  orientation: "portrait",
  columns: [
    { key: "rule_code", header: "Rule", width: 22, align: "left", format: "text" },
    { key: "label", header: "Description", width: 36, align: "left", format: "text" },
    { key: "employee_count", header: "Employees", width: 14, align: "right", format: "number" },
    { key: "total_employer", header: "Employer Total", width: 28, align: "right", format: "currency" },
  ],
};
REPORT_SPECS["statutory_liabilities"] = {
  title: "Statutory Liabilities",
  orientation: "landscape",
  columns: [
    { key: "rule_code", header: "Code", width: 16, align: "left", format: "text" },
    { key: "label", header: "Liability", width: 22, align: "left", format: "text" },
    { key: "employee", header: "Employee", width: 14, align: "right", format: "currency" },
    { key: "employer", header: "Employer", width: 14, align: "right", format: "currency" },
    { key: "total", header: "Total", width: 14, align: "right", format: "currency" },
    { key: "paid", header: "Paid", width: 14, align: "right", format: "currency" },
    { key: "outstanding", header: "Outstanding", width: 14, align: "right", format: "currency" },
  ],
};
REPORT_SPECS["employee_earnings"] = {
  title: "Employee Earnings",
  orientation: "landscape",
  columns: [
    { key: "employee", header: "Employee", width: 22, align: "left", format: "text" },
    { key: "employee_number", header: "Emp #", width: 10, align: "left", format: "text" },
    { key: "period", header: "Period", width: 22, align: "left", format: "text" },
    { key: "gross", header: "Gross", width: 14, align: "right", format: "currency" },
    { key: "deductions", header: "Deductions", width: 14, align: "right", format: "currency" },
    { key: "net_pay", header: "Net Pay", width: 14, align: "right", format: "currency" },
    { key: "status", header: "Status", width: 10, align: "left", format: "text" },
  ],
};
REPORT_SPECS["branch_payroll_cost"] = {
  title: "Branch Payroll Cost",
  orientation: "portrait",
  columns: [
    { key: "branch", header: "Branch", width: 30, align: "left", format: "text" },
    { key: "headcount", header: "Headcount", width: 14, align: "right", format: "number" },
    { key: "gross", header: "Gross", width: 18, align: "right", format: "currency" },
    { key: "employer_cost", header: "Employer Cost", width: 18, align: "right", format: "currency" },
    { key: "total_cost", header: "Total Cost", width: 20, align: "right", format: "currency" },
  ],
};
REPORT_SPECS["department_payroll_cost"] = {
  title: "Department Payroll Cost",
  orientation: "portrait",
  columns: [
    { key: "department", header: "Department", width: 30, align: "left", format: "text" },
    { key: "headcount", header: "Headcount", width: 14, align: "right", format: "number" },
    { key: "gross", header: "Gross", width: 18, align: "right", format: "currency" },
    { key: "employer_cost", header: "Employer Cost", width: 18, align: "right", format: "currency" },
    { key: "total_cost", header: "Total Cost", width: 20, align: "right", format: "currency" },
  ],
};
REPORT_SPECS["payroll_overtime"] = {
  title: "Overtime Report",
  orientation: "portrait",
  columns: [
    { key: "employee", header: "Employee", width: 28, align: "left", format: "text" },
    { key: "employee_number", header: "Emp #", width: 12, align: "left", format: "text" },
    { key: "line_count", header: "Lines", width: 10, align: "right", format: "number" },
    { key: "amount", header: "Overtime Pay", width: 20, align: "right", format: "currency" },
  ],
};
REPORT_SPECS["payroll_variance"] = {
  title: "Payroll Variance (Period vs Period)",
  orientation: "landscape",
  columns: [
    { key: "payroll_number", header: "Run #", width: 12, align: "left", format: "text" },
    { key: "period", header: "Period", width: 22, align: "left", format: "text" },
    { key: "headcount", header: "Headcount", width: 12, align: "right", format: "number" },
    { key: "gross", header: "Gross", width: 14, align: "right", format: "currency" },
    { key: "net_pay", header: "Net Pay", width: 14, align: "right", format: "currency" },
    { key: "employer_cost", header: "Employer", width: 14, align: "right", format: "currency" },
    { key: "gross_delta", header: "Δ Gross", width: 14, align: "right", format: "currency" },
    { key: "gross_delta_pct", header: "Δ Gross %", width: 12, align: "right", format: "number" },
    { key: "net_delta", header: "Δ Net", width: 14, align: "right", format: "currency" },
    { key: "net_delta_pct", header: "Δ Net %", width: 12, align: "right", format: "number" },
  ],
};

// ─── Payroll extended reports (Phase 4) ──────────────────────────
REPORT_SPECS["payroll_gl_posting"] = {
  title: "Payroll GL Posting",
  orientation: "landscape",
  formatProfile: "financial",
  columns: [
    { key: "entry_date", header: "Date", width: 12, align: "left", format: "date" },
    { key: "entry_number", header: "Entry #", width: 14, align: "left", format: "text" },
    { key: "payroll_number", header: "Run #", width: 14, align: "left", format: "text" },
    { key: "account", header: "Account", width: 30, align: "left", format: "text" },
    { key: "description", header: "Description", width: 30, align: "left", format: "text" },
    { key: "debit", header: "Debit", width: 14, align: "right", format: "currency" },
    { key: "credit", header: "Credit", width: 14, align: "right", format: "currency" },
    { key: "status", header: "Status", width: 10, align: "left", format: "text" },
  ],
};
REPORT_SPECS["payroll_audit_trail"] = {
  title: "Payroll Audit Trail",
  orientation: "landscape",
  columns: [
    { key: "when", header: "When", width: 18, align: "left", format: "date" },
    { key: "actor", header: "Actor", width: 22, align: "left", format: "text" },
    { key: "action", header: "Action", width: 14, align: "left", format: "text" },
    { key: "entity_type", header: "Entity", width: 18, align: "left", format: "text" },
    { key: "entity", header: "Ref", width: 20, align: "left", format: "text" },
    { key: "summary", header: "Change", width: 40, align: "left", format: "text" },
  ],
};
REPORT_SPECS["payroll_work_entries"] = {
  title: "Payroll Work Entries",
  orientation: "landscape",
  columns: [
    { key: "employee", header: "Employee", width: 22, align: "left", format: "text" },
    { key: "employee_number", header: "Emp #", width: 10, align: "left", format: "text" },
    { key: "entry_type", header: "Type", width: 18, align: "left", format: "text" },
    { key: "period", header: "Period", width: 22, align: "left", format: "text" },
    { key: "hours", header: "Hours", width: 12, align: "right", format: "number" },
    { key: "overtime_hours", header: "OT Hours", width: 12, align: "right", format: "number" },
    { key: "holiday_hours", header: "Holiday Hrs", width: 12, align: "right", format: "number" },
    { key: "source", header: "Source", width: 12, align: "left", format: "text" },
  ],
};

// ─── Project reports ─────────────────────────────────────────────
REPORT_SPECS["project_portfolio"] = {
  title: "Project Portfolio",
  orientation: "landscape",
  columns: [
    { key: "project_number", header: "Code", width: 12, align: "left", format: "text" },
    { key: "name", header: "Project", width: 36, align: "left", format: "text" },
    { key: "status", header: "Status", width: 14, align: "left", format: "text" },
    { key: "end_date", header: "End Date", width: 16, align: "left", format: "date" },
    { key: "progress", header: "Progress", width: 14, align: "right", format: "text" },
  ],
};
REPORT_SPECS["project_profitability"] = {
  title: "Project Profitability",
  orientation: "landscape",
  formatProfile: "financial",
  columns: [
    { key: "project_number", header: "Code", width: 12, align: "left", format: "text" },
    { key: "name", header: "Project", width: 26, align: "left", format: "text" },
    { key: "revenue", header: "Revenue", width: 16, align: "right", format: "currency" },
    { key: "cost", header: "Cost", width: 16, align: "right", format: "currency" },
    { key: "margin", header: "Margin", width: 16, align: "right", format: "currency" },
    { key: "margin_pct", header: "Margin %", width: 12, align: "right", format: "percent" },
  ],
};
REPORT_SPECS["project_workload"] = {
  title: "Project Workload",
  orientation: "landscape",
  columns: [
    { key: "project", header: "Project", width: 30, align: "left", format: "text" },
    { key: "total_hours", header: "Total Hours", width: 14, align: "right", format: "number" },
    { key: "billable_hours", header: "Billable", width: 14, align: "right", format: "number" },
    { key: "non_billable_hours", header: "Non-billable", width: 14, align: "right", format: "number" },
    { key: "billable_pct", header: "Billable %", width: 12, align: "right", format: "percent" },
  ],
};
REPORT_SPECS["project_timesheet_detail"] = {
  title: "Project Timesheet Detail",
  orientation: "landscape",
  columns: [
    { key: "date", header: "Date", width: 12, align: "left", format: "date" },
    { key: "project", header: "Project", width: 22, align: "left", format: "text" },
    { key: "employee", header: "Employee", width: 18, align: "left", format: "text" },
    { key: "description", header: "Description", width: 28, align: "left", format: "text" },
    { key: "hours", header: "Hours", width: 10, align: "right", format: "number" },
    { key: "billable", header: "Billable", width: 10, align: "left", format: "text" },
  ],
};
REPORT_SPECS["project_status"] = {
  title: "Project Status",
  orientation: "landscape",
  columns: [
    { key: "project_number", header: "Code", width: 12, align: "left", format: "text" },
    { key: "name", header: "Project", width: 22, align: "left", format: "text" },
    { key: "status", header: "Status", width: 14, align: "left", format: "text" },
    { key: "last_update", header: "Latest Update", width: 16, align: "left", format: "text" },
    { key: "last_update_at", header: "When", width: 14, align: "left", format: "date" },
    { key: "summary", header: "Summary", width: 30, align: "left", format: "text" },
  ],
};
REPORT_SPECS["project_full_export"] = {
  title: "Project Full Export",
  orientation: "landscape",
  formatProfile: "financial",
  columns: [
    { key: "section", header: "Section", width: 18, align: "left", format: "text" },
    { key: "label", header: "Label", width: 36, align: "left", format: "text" },
    { key: "detail", header: "Detail", width: 30, align: "left", format: "text" },
    { key: "date", header: "Date", width: 14, align: "left", format: "date" },
    { key: "hours", header: "Hours", width: 10, align: "right", format: "number" },
    { key: "amount", header: "Amount", width: 16, align: "right", format: "currency" },
  ],
};

/**
 * Look up a spec by report type. Returns null if unknown — callers should
 * fall back to first-row inference for legacy/unregistered reports.
 */
export function getReportSpec(reportType: string): ReportSpec | null {
  return REPORT_SPECS[reportType] ?? null;
}

/**
 * Default human title for a report type. Used when the caller does not
 * pass an explicit title.
 */
export function getReportTitle(reportType: string): string {
  return REPORT_SPECS[reportType]?.title ?? "Report";
}
