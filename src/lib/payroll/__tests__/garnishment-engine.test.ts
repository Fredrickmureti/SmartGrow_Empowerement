import { describe, it, expect } from "vitest";
import { computeGarnishments, type GarnishmentOrder, type KindDefault } from "@/lib/payroll/garnishment-engine";

const KIND_DEFAULTS: Record<string, KindDefault> = {
  child_support: { counts_toward_aggregate_cap: false },
  tax_levy: { counts_toward_aggregate_cap: true },
  creditor: { counts_toward_aggregate_cap: true },
  court_order: { counts_toward_aggregate_cap: true },
};

function order(o: Partial<GarnishmentOrder> & { id: string; cap_rule: GarnishmentOrder["cap_rule"]; kind: string }): GarnishmentOrder {
  return { total_paid: 0, ...o };
}

describe("computeGarnishments", () => {
  it("applies a fixed-amount order capped to disposable", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 200,
      orders: [order({ id: "g1", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 100 })],
      policy: { aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: KIND_DEFAULTS,
    });
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0].amount).toBe(100);
    expect(r.disposable).toBe(800);
    expect(r.disposableRemaining).toBe(700);
  });

  it("enforces CCPA-style 25% aggregate cap and skips lower-priority creditors once exhausted", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 0,
      orders: [
        order({ id: "g1", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 300 }),
        order({ id: "g2", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 200 }),
      ],
      policy: { aggregate_cap_pct: 0.25, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: KIND_DEFAULTS,
    });
    // Pool = 250. g1 takes 250 (clamped from 300). g2 gets 0.
    expect(r.applied.map(a => a.amount)).toEqual([250]);
  });

  it("child support is exempt from the aggregate cap (consumes outside the pool)", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 0,
      orders: [
        order({ id: "cs", kind: "child_support", cap_rule: "fixed_amount", fixed_amount: 400 }),
        order({ id: "cr", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 300 }),
      ],
      policy: { aggregate_cap_pct: 0.25, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: KIND_DEFAULTS,
    });
    // child support consumes outside cap; creditor still has full 250 pool
    expect(r.applied[0]).toMatchObject({ id: "cs", amount: 400 });
    expect(r.applied[1]).toMatchObject({ id: "cr", amount: 250 });
  });

  it("respects total_owed remaining balance", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 0,
      orders: [order({ id: "g1", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 500, total_owed: 350, total_paid: 100 })],
      policy: { aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: KIND_DEFAULTS,
    });
    expect(r.applied[0].amount).toBe(250); // remaining owed
  });

  it("enforces a minimum take-home floor", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 0,
      orders: [order({ id: "g1", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 800 })],
      policy: { aggregate_cap_pct: null, min_take_home_amount: 400, min_take_home_pct: null },
      kindDefaults: KIND_DEFAULTS,
    });
    expect(r.applied[0].amount).toBe(600); // 1000 - 400 floor
  });

  it("percent_disposable clamps to disposable income, not gross", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 400,
      orders: [order({ id: "g1", kind: "creditor", cap_rule: "percent_disposable", percent_of_disposable: 0.5 })],
      policy: { aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: KIND_DEFAULTS,
    });
    // disposable=600, 50% = 300
    expect(r.applied[0].amount).toBe(300);
  });

  it("lesser_of_fixed_or_pct takes the smaller of the two", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 0,
      orders: [order({ id: "g1", kind: "creditor", cap_rule: "lesser_of_fixed_or_pct", fixed_amount: 200, percent_of_disposable: 0.3 })],
      policy: { aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: KIND_DEFAULTS,
    });
    expect(r.applied[0].amount).toBe(200); // min(200, 300)
  });

  it("stops processing lower-priority orders when disposable hits zero", () => {
    const r = computeGarnishments({
      gross: 500,
      preGarnishmentDeductions: 0,
      orders: [
        order({ id: "g1", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 500 }),
        order({ id: "g2", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 100 }),
      ],
      policy: { aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: KIND_DEFAULTS,
    });
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0].id).toBe("g1");
  });
});
