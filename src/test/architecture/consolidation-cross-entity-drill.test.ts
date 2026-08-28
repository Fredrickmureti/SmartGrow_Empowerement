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
    expect(src).toContain("journalEntryDrillHref");
    expect(src).toContain("declaring_business_id");
    // No hand-rolled ledger URL that would drop the company.
    expect(src).not.toContain("general-ledger?account_id=");
  });

  it("the deep link out of a drill-down is centralized in the drill primitive", () => {
    const src = read("components/reports/DrillDownDialog.tsx");
    // The dialog itself owns the "leave the workspace" affordance, so no page
    // has to hand-roll one, and it always carries the entity it drilled.
    expect(src).toContain("ledgerDrillHref");
    expect(src).toContain("Open in General Ledger");
    expect(src).toContain("businessId: scopedBusinessId");
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

/**
 * Which level of a consolidated report may be drilled at all.
 *
 * A group figure is an aggregation of several companies' accounts: it has no
 * single ledger, and inventing one would be a lie dressed as a feature. The
 * member contribution is the first level that maps to real books, so that —
 * and only that — is the drill target.
 */
describe("consolidated reports drill at the level that owns records", () => {
  it("the trial balance opens member contributions in place, not group totals or the CTA residual", () => {
    const src = read("pages/reports/ConsolidatedTrialBalance.tsx");
    // Drill-down is the in-place entity-scoped dialog, not a navigation.
    expect(src).toContain("DrillDownDialog");
    expect(src).toContain("setDrillConfig({");
    expect(src).toContain("businessId: c.business_id");
    // The residual belongs to the group, not to a member chart.
    expect(src).toContain("!line.is_residual");
    // The group row carries no drill target.
    expect(src).not.toContain("businessId: line.business_id");
  });

  it("intercompany activity opens the posting company's own account in place", () => {
    const src = read("pages/reports/ConsolidationIntercompany.tsx");
    expect(src).toContain("DrillDownDialog");
    expect(src).toContain("setDrillConfig({");
    expect(src).toContain("businessId: r.declaring_business_id");
    expect(src).toContain("activityBlocked");
  });

  it("consolidated statements reach member evidence without leaving the report", () => {
    const src = read("pages/reports/ConsolidatedStatements.tsx");
    expect(src).toContain("MemberContributionDialog");
    const dialog = read("components/reports/MemberContributionDialog.tsx");
    // Statement line -> member contribution -> that member's GL lines,
    // stacked in place on the shared primitive.
    expect(dialog).toContain("DrillDownDialog");
    expect(dialog).toContain("businessId");
  });

  it("elimination evidence is inspected in place: entry drawer and entity-scoped account drill", () => {
    const src = read("components/finance/EliminationEvidencePanel.tsx");
    expect(src).toContain("TransactionPreviewDrawer");
    expect(src).toContain("DrillDownDialog");
    expect(src).toContain("businessId: r.declaring_business_id");
    // Every affordance stays behind the server's own decision.
    expect(src).toContain("r.viewer_can_open_ledger");
  });

  it("links are offered only where the viewer may open that company's books", () => {
    const access = read("hooks/finance/useMemberLedgerAccess.ts");
    expect(access).toContain("user_business_access");
    for (const page of [
      "pages/reports/ConsolidatedTrialBalance.tsx",
      "pages/reports/ConsolidationIntercompany.tsx",
    ]) {
      const src = read(page);
      expect(src).toContain("useMemberLedgerAccess");
      expect(src).toContain("canOpenMemberLedger(");
    }
  });

  it("a consolidated row records the company its figures came from", () => {
    expect(read("design-system/reports/model.ts")).toContain("businessId?: string");
    expect(read("pages/reports/ConsolidatedTrialBalance.tsx")).toContain(
      "meta: { accountId: c.account_id, businessId: c.business_id }",
    );
  });
});

