/**
 * useUpcomingDeadlines contract guard.
 *
 * Statically pins the hook's query shape so a regression (wrong table,
 * dropped business_id scope, expanded status window, missing route on
 * an item) is caught at typecheck/test time rather than on the
 * dashboard at runtime. Mirrors the static-scan style used by sibling
 * architecture tests (e.g. dashboard-cta-routes, scanner-no-length-
 * heuristic). No live Supabase or React rendering.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "src/hooks/useUpcomingDeadlines.ts"),
  "utf8",
);

describe("useUpcomingDeadlines contract", () => {
  it("is gated by hasSales || hasPurchases || hasHR", () => {
    expect(SRC).toMatch(
      /enabled\s*=\s*!!orgId\s*&&\s*!!businessId\s*&&\s*\(opts\.hasSales\s*\|\|\s*opts\.hasPurchases\s*\|\|\s*opts\.hasHR\)/,
    );
  });

  it("scopes every query to organization_id AND business_id", () => {
    // One .eq("organization_id", orgId) and one .eq("business_id", businessId)
    // per source table (invoices, bills, payroll_runs) = 3 each.
    const orgScoped = SRC.match(/\.eq\("organization_id",\s*orgId\)/g) ?? [];
    const bizScoped = SRC.match(/\.eq\("business_id",\s*businessId\)/g) ?? [];
    expect(orgScoped.length).toBeGreaterThanOrEqual(3);
    expect(bizScoped.length).toBeGreaterThanOrEqual(3);
  });

  it("restricts invoice statuses to open-receivable set", () => {
    expect(SRC).toMatch(
      /\.from\("invoices"\)[\s\S]*?\.in\("status",\s*\["sent",\s*"partial",\s*"viewed"\]\)/,
    );
  });

  it("restricts bill statuses to open-payable set", () => {
    expect(SRC).toMatch(
      /\.from\("bills"\)[\s\S]*?\.in\("status",\s*\["received",\s*"approved",\s*"partial"\]\)/,
    );
  });

  it("restricts payroll_runs statuses to pre-paid set", () => {
    expect(SRC).toMatch(
      /\.from\("payroll_runs"\)[\s\S]*?\.in\("status",\s*\["draft",\s*"computed",\s*"approved"\]\)/,
    );
  });

  it("bounds the lookahead window and caps output", () => {
    expect(SRC).toMatch(/WINDOW_DAYS\s*=\s*14/);
    expect(SRC).toMatch(/\.slice\(0,\s*8\)/);
    expect(SRC).toMatch(
      /sort\(\(a,\s*b\)\s*=>\s*a\.dueDate\.localeCompare\(b\.dueDate\)\)/,
    );
  });

  it("emits hrefs that match registered dashboard routes", () => {
    // dashboard-cta-routes.test.ts validates these against App.tsx /
    // app routes. Pinning the literals here keeps the two guards in
    // lockstep: changing the href string here forces the route test
    // to re-validate.
    expect(SRC).toMatch(/href:\s*`\/sales\/invoices`/);
    expect(SRC).toMatch(/href:\s*`\/purchases\/bills`/);
    expect(SRC).toMatch(/href:\s*`\/hr\/payroll`/);
  });

  it("never issues client-side writes against these tables", () => {
    // The hook is a read-only aggregator. Any insert/update/delete/
    // upsert against invoices/bills/payroll_runs from here would be a
    // boundary violation — those writes belong in dedicated RPCs.
    expect(SRC).not.toMatch(/\.insert\(/);
    expect(SRC).not.toMatch(/\.update\(/);
    expect(SRC).not.toMatch(/\.upsert\(/);
    expect(SRC).not.toMatch(/\.delete\(/);
  });
});
