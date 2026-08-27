/**
 * Consolidation traceability contract — cross-entity drill-downs.
 *
 * The failure guarded here is subtle and dangerous: a drill-down from a group
 * figure that names the account but not the company. It lands in whichever
 * company the viewer had active, so the detail either comes up empty or —
 * worse, where charts of accounts are shared — shows a *different* company's
 * numbers under the right heading.
 *
 * The rules: cross-entity links are built by one helper, they carry the
 * company in the canonical `business` scope key, the destination honours it,
 * and permission remains the server's decision.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

describe("consolidation drill-downs name the company they open", () => {
  it("`business` is a canonical reporting scope key, not a bespoke param", () => {
    const src = read("hooks/reports/useReportWorkspaceState.ts");
    expect(src).toContain('"business"');
  });

  it("cross-entity links are built in one place and carry company, account and period", () => {
    const src = read("lib/reports/crossEntityDrill.ts");
    expect(src).toContain("ledgerDrillHref");
    expect(src).toContain("journalEntryDrillHref");
    expect(src).toContain("scopeToSearch");
    expect(src).toContain("business: businessId");
  });

  it("the elimination evidence panel uses the shared builders, not string URLs", () => {
    const src = read("components/finance/EliminationEvidencePanel.tsx");
    expect(src).toContain("ledgerDrillHref");
    expect(src).toContain("journalEntryDrillHref");
    expect(src).toContain("declaring_business_id");
    // No hand-rolled ledger URL that would drop the company.
    expect(src).not.toContain("general-ledger?account_id=");
  });

  it("the destination honours the company in the link and announces the switch", () => {
    const hook = read("hooks/reports/useEntityScopeFromUrl.ts");
    expect(hook).toContain("switchBusiness");
    // A company outside the viewer's access set is refused, not opened.
    expect(hook).toContain("denied");
    const gl = read("pages/reports/GeneralLedger.tsx");
    expect(gl).toContain("EntityScopeNotice");
    const notice = read("components/reports/EntityScopeNotice.tsx");
    expect(notice).toContain("useEntityScopeFromUrl");
    expect(notice).toContain("denied");
  });
});
