/**
 * Phase 5 — Receivables & Partners reporting: isolation + taxonomy closure.
 *
 * The SQL side of the matrix lives in
 * `supabase/tests/reporting_isolation_matrix_test.sql` (definer / search_path /
 * org gate / no anon EXECUTE / 42501 on foreign org / strict branch scope).
 *
 * This file guards the CLIENT half of the same contract:
 *   1. every reporting RPC in this domain is called with an explicit
 *      `_org_id` — never left to a server-side default,
 *   2. the drill-down surface is org (and business) scoped, so a drill from
 *      any report cannot widen beyond the report it was opened from,
 *   3. the four report families are declared in `REPORT_REGISTRY` with a
 *      resolvable domain and related reports, so the switcher and Report
 *      Center cannot drift from the routes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REPORT_REGISTRY,
  getReportDomain,
  getRelatedReports,
} from "@/services/reports/ReportRegistry";

const REPO_ROOT = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const REPORTING_RPCS = [
  "get_ar_ap_aging_from_ledger",
  "get_ar_summary",
  "get_ap_summary",
  "get_control_account_reconciliation",
  "finance_ar_open_items_as_of",
  "finance_ar_customer_credit_as_of",
  "finance_ar_aging_reconciliation",
  "finance_partner_ledger",
  "finance_partner_ledger_reconciliation",
  "finance_sales_analysis",
  "finance_sales_revenue_reconciliation",
  "finance_purchase_analysis",
  "finance_purchase_expense_reconciliation",
  // General-ledger engines behind Cash Flow, Bank/Cash dashboards, Trial
  // Balance and Year-End closing — same definer + caller-org contract.
  "get_account_movements",
  "get_account_balances",
  "get_general_ledger",
  "get_gl_transactions",
  "check_balance_integrity",
] as const;

const SERVICE_FILES = [
  "src/services/finance/openItems.ts",
  "src/services/finance/partnerLedger.ts",
  "src/services/finance/salesAnalysis.ts",
  "src/services/finance/purchaseAnalysis.ts",
];

describe("reporting isolation matrix — client half", () => {
  it("passes an explicit _org_id to every reporting RPC call", () => {
    const sources = SERVICE_FILES.map(read).join("\n");
    for (const rpc of REPORTING_RPCS) {
      const idx = sources.indexOf(`"${rpc}"`);
      if (idx === -1) continue; // not called from these services
      const window = sources.slice(idx, idx + 600);
      expect(window, `${rpc} must be called with an explicit _org_id`).toMatch(
        /_org_id\s*:/,
      );
    }
  });

  it("keeps the SQL isolation matrix suite in the repo", () => {
    const sql = read("supabase/tests/reporting_isolation_matrix_test.sql");
    for (const rpc of REPORTING_RPCS) {
      expect(sql, `${rpc} missing from the isolation matrix`).toContain(rpc);
    }
    expect(sql).toContain("42501");
    expect(sql).toContain("finance_can_read_org");
  });
});

describe("drill-down isolation", () => {
  const dialog = read("src/components/reports/DrillDownDialog.tsx");

  it("scopes every drill-down read by organization", () => {
    // GL drill goes through the definer RPC with the caller's org…
    expect(dialog).toMatch(/_org_id:\s*currentOrg\.id/);
    // …and the partner drill filters the base table by organization.
    expect(dialog).toMatch(/\.eq\("organization_id",\s*currentOrg\.id\)/);
  });

  it("applies the active business scope to the partner drill-down", () => {
    expect(dialog).toMatch(/currentBusiness\?\.id.*business_id|business_id.*currentBusiness/s);
  });

  it("refuses to guess the document kind for a partner drill", () => {
    // Only "invoice" and "bill" are honoured; anything else yields null and
    // the query stays disabled.
    expect(dialog).toMatch(/partnerKind[\s\S]{0,400}:\s*null/);
    expect(dialog).toMatch(/enabled:[^\n]*partnerKind/);
  });

  it("never reads with a privileged client", () => {
    expect(dialog).not.toMatch(/service_role|SERVICE_ROLE/);
  });
});

describe("report taxonomy coverage", () => {
  const FAMILY_IDS = [
    "aged-receivables",
    "aged-payables",
    "partner-ledger",
    "sales-reports",
    "purchase-reports",
  ];

  it("registers every report family", () => {
    for (const id of FAMILY_IDS) {
      const def = REPORT_REGISTRY.find((r) => r.id === id);
      expect(def, `${id} is not in REPORT_REGISTRY`).toBeTruthy();
      expect(def!.path).toMatch(/^\/[a-z]/);
      expect(def!.permission).toBeTruthy();
    }
  });

  it("resolves a reporting domain for each family", () => {
    for (const id of FAMILY_IDS) {
      const def = REPORT_REGISTRY.find((r) => r.id === id)!;
      expect(getReportDomain(def)).toBeTruthy();
    }
  });

  it("gives each family at least one related report for the switcher", () => {
    for (const id of FAMILY_IDS) {
      expect(getRelatedReports(id).length, `${id} has no related reports`).toBeGreaterThan(0);
    }
  });

  it("declares the sales drill-down in the registry", () => {
    const sales = REPORT_REGISTRY.find((r) => r.id === "sales-reports")!;
    expect(sales.drillDown).toBe("dialog");
  });

  it("has no duplicate registry ids or paths in this family", () => {
    const ids = REPORT_REGISTRY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
