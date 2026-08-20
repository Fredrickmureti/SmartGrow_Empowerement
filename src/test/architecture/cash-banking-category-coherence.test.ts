/**
 * Cash & Banking is a category, not a scattering.
 *
 * A user looking for the cash position of the business expects the cash flow
 * statement and the bank reconciliation to sit together. The bank
 * reconciliation once lived under "Audit", where nobody looking for a bank
 * balance would find it. Taxonomy drift is silent, so it is guarded here.
 */
import { describe, expect, it } from "vitest";
import { REPORT_REGISTRY } from "@/services/reports/ReportRegistry";

const byId = (id: string) => REPORT_REGISTRY.find((r) => r.id === id);

describe("cash & banking category", () => {
  it.each(["cash-flow", "bank-reconciliation-report"])(
    "%s is filed under Cash & Banking",
    (id) => {
      const entry = byId(id);
      expect(entry, `${id} is missing from the report registry`).toBeDefined();
      expect(entry!.category).toBe("cash_bank");
    },
  );

  it("every cash & banking report is reachable and permissioned", () => {
    const cash = REPORT_REGISTRY.filter((r) => r.category === "cash_bank");
    expect(cash.length).toBeGreaterThanOrEqual(2);
    for (const entry of cash) {
      expect(entry.path, `${entry.id} has no route`).toMatch(/^\//);
      expect(entry.permission, `${entry.id} is unguarded`).toBeTruthy();
    }
  });
});
