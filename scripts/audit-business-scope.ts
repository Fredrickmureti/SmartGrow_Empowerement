#!/usr/bin/env bun
/**
 * Architecture audit: detect hooks that filter business-scoped tables by
 * organization_id ONLY, with no paired business_id filter. These are the
 * cross-Company contamination time bombs the Wave A audit flagged.
 *
 * Run:  bun scripts/audit-business-scope.ts
 *
 * Exits non-zero when violations are found, so this can be wired into CI.
 *
 * Limitations (intentional, to keep this a static heuristic):
 *   - We only inspect .from("...") chains that include .eq("organization_id"
 *   - A chain is considered safe if ANY of these appear within the same
 *     ~40-line window after the .from(...) call:
 *       - .eq("business_id"
 *       - .or("business_id...
 *       - _business_id:           (passed to an RPC)
 *       - _biz_id:                (alternate RPC convention)
 *   - Tables in BUSINESS_SCOPED_TABLES_ALLOWED_ORG_ONLY are skipped
 *     because the column exists but the table is legitimately org-wide
 *     in some flows (e.g. settings tables that fall back to org-level
 *     defaults when business_id is null).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Tables that have a `business_id` column. Keep this in sync with the DB.
// Source: SELECT table_name FROM information_schema.columns
//         WHERE table_schema='public' AND column_name='business_id'
const BUSINESS_SCOPED_TABLES = new Set<string>([
  "accounting_integrity_reports",
  "accounts",
  "ai_insights_cache",
  "analytic_accounts",
  "analytic_distributions",
  "analytic_groups",
  "approval_workflows",
  "asset_categories",
  "asset_maintenance",
  "attendance",
  "audit_logs",
  "automated_actions",
  "backorders",
  "bank_accounts",
  "bank_reconciliation_sessions",
  "bank_statements",
  "bank_transactions",
  "bill_payments",
  "bills",
  "branches",
  "budget_actuals",
  "budgets",
  "business_active_currencies",
  "compliance_checklist",
  "contacts",
  "credit_notes",
  "crm_activities",
  "crm_leads",
  "crm_stages",
  "customer_statements",
  "default_account_mappings",
  "default_account_settings",
  "delivery_notes",
  "departments",
  "depreciation_entries",
  "document_templates",
  "documents",
  "documents_folders",
  "email_templates",
  "employee_benefits",
  "employee_contracts",
  "employee_loans",
  "employees",
  "entity_field_configs",
  "estimates",
  "exchange_rates",
  "expense_categories",
  "expenses",
  "fiscal_periods",
  "fixed_assets",
  "gl_transaction_mappings",
  "goods_receipts",
  "installed_localization_packs",
  "invoice_items",
  "invoice_sequences",
  "invoices",
  "je_number_sequences",
  "journal_entries",
  "journal_entry_lines",
  "leave_allocations",
  "leave_requests",
  "loyalty_programs",
  "migration_sessions",
  "notification_alert_settings",
  "notifications",
  "onboarding_attempts",
  "onboarding_status",
  "organization_payment_gateways",
  "organization_payment_methods",
  "payment_requests",
  "payment_terms",
  "payments",
  "payroll_account_mappings",
  "payroll_periods",
  "payroll_remittances",
  "payroll_runs",
  "payslips",
  "pos_daily_sales_summary",
  "pos_daily_summary",
  "pos_payment_methods",
  "pos_registers",
  "pos_shifts",
  "pos_transactions",
  "price_lists",
  "product_reorder_rules",
  "products",
  "proforma_invoices",
  "projects",
  "purchase_orders",
  "purchase_returns",
  "reconciliation_sessions",
  "recurring_invoices",
  "recurring_journal_templates",
  "replenishment_logs",
  "report_run_log",
  "rfqs",
  "salary_structures",
  "sales_orders",
  "sales_returns",
  "sms_log",
  "sms_provider_configs",
  "sms_provider_configs_masked",
  "spreadsheets",
  "stock_adjustments",
  "stock_movements",
  "tax_rates",
  "timesheet_submissions",
  "timesheets",
  "transactions",
  "user_active_business",
  "user_branch_assignments",
  "user_business_access",
  "vendor_credit_notes",
  "vendor_pricelists",
  "vendor_statements",
  "warehouses",
]);

// Tables that legitimately support org-only queries (because business_id is
// nullable and the org-level row is a shared default). Contamination is
// architecturally OK here.
const BUSINESS_SCOPED_TABLES_ALLOWED_ORG_ONLY = new Set<string>([
  // Branches list THE businesses' branches — they're queried by org for
  // workspace switchers and admin views.
  "branches",
  // Membership-level tables: queried org-wide to enumerate user access.
  "user_business_access",
  "user_branch_assignments",
  "user_active_business",
  // Org-level pickers used during onboarding before a business is chosen.
  "onboarding_status",
  "onboarding_attempts",
  "businesses",
]);

// Heuristic safe-paired-filter indicators within the .from() chain window.
const SAFE_INDICATORS = [
  /\.eq\(\s*["']business_id["']/,
  /\.or\(\s*[`"']business_id/,
  /\.in\(\s*["']business_id["']/,
  /_business_id\s*:/,
  /_biz_id\s*:/,
];

// Marker comment that flags an intentional, audited cross-Company query.
// Must appear within ~200 chars BEFORE the `.from(...)` call to take effect.
// Mirrors the convention enforced by
// `src/test/architecture/business-scoped-queries.test.ts`.
const EXEMPT_MARKER = "SCOPE-EXEMPT:";
// Legacy marker used in some hooks predating the SCOPE-EXEMPT convention.
const LEGACY_EXEMPT_MARKER = "architecture-allow:";

// Walk a directory recursively and return all .ts/.tsx files.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  table: string;
  snippet: string;
}

const FROM_RE = /\.from\(\s*["']([a-z0-9_]+)["']\s*\)/g;

function inspectFile(filePath: string): Violation[] {
  const src = readFileSync(filePath, "utf8");
  const lines = src.split("\n");
  const violations: Violation[] = [];

  // Find each .from("table") position.
  let match: RegExpExecArray | null;
  while ((match = FROM_RE.exec(src)) !== null) {
    const table = match[1];
    if (!BUSINESS_SCOPED_TABLES.has(table)) continue;
    if (BUSINESS_SCOPED_TABLES_ALLOWED_ORG_ONLY.has(table)) continue;

    // Compute line number of the .from( occurrence.
    const upTo = src.slice(0, match.index);
    const lineNumber = upTo.split("\n").length;

    // Honor exemption markers placed within ~200 chars BEFORE the .from(...)
    // call. Mirrors `src/test/architecture/business-scoped-queries.test.ts`.
    const before = src.slice(Math.max(0, match.index - 200), match.index);
    if (before.includes(EXEMPT_MARKER) || before.includes(LEGACY_EXEMPT_MARKER)) continue;

    // Look at the next ~40 lines as the chain window (queries are sometimes
    // built imperatively across several statements). Stop at the next
    // `.from(` (after this one) so a sibling query's filters are not credited
    // to this one.
    const fullWindow = lines.slice(lineNumber - 1, Math.min(lines.length, lineNumber + 40)).join("\n");
    // Skip past the CURRENT `.from(` token before searching for the next one.
    const currentFromOffset = fullWindow.indexOf(".from(");
    const searchStart = currentFromOffset >= 0 ? currentFromOffset + 6 : 0;
    const nextFromRel = fullWindow.indexOf(".from(", searchStart);
    const window = nextFromRel > 0 ? fullWindow.slice(0, nextFromRel) : fullWindow;

    const hasOrgFilter = /\.eq\(\s*["']organization_id["']/.test(window);
    if (!hasOrgFilter) continue; // not the pattern we audit

    const hasSafePair = SAFE_INDICATORS.some((re) => re.test(window));
    if (hasSafePair) continue; // properly business-scoped

    violations.push({
      file: filePath,
      line: lineNumber,
      table,
      snippet: lines[lineNumber - 1].trim(),
    });
  }
  return violations;
}

function main() {
  const root = process.cwd();
  const targets = ["src/hooks", "src/lib", "src/services", "src/components"];
  const files: string[] = [];
  for (const t of targets) {
    try {
      files.push(...walk(join(root, t)));
    } catch {
      // dir may not exist; ignore
    }
  }

  const violationsByFile = new Map<string, Violation[]>();
  for (const f of files) {
    const v = inspectFile(f);
    if (v.length > 0) {
      violationsByFile.set(f, v);
    }
  }

  if (violationsByFile.size === 0) {
    console.log("✅ No business-scope violations detected.");
    process.exit(0);
  }

  let total = 0;
  console.log("⚠️  Business-scope violations (org filter without paired business filter):\n");
  for (const [file, vs] of [...violationsByFile.entries()].sort()) {
    console.log(`\x1b[1m${relative(root, file)}\x1b[0m`);
    for (const v of vs) {
      total++;
      console.log(`  L${v.line.toString().padStart(4)} \x1b[33m[${v.table}]\x1b[0m ${v.snippet}`);
    }
  }
  console.log(`\n\x1b[31m${total} violations across ${violationsByFile.size} files.\x1b[0m`);
  console.log(
    "\nThese sites query a business-scoped table by organization_id only.\n" +
      "Add `.eq(\"business_id\", currentBusiness.id)` (or pass `_business_id` to the RPC),\n" +
      "or — if the call truly needs cross-Company data — assert workspace has exactly\n" +
      "one active Company first (mirrors the GL guard from Wave A).",
  );
  process.exit(1);
}

main();
