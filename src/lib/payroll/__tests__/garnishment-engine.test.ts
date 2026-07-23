import { describe, it, expect } from "vitest";
import { computeGarnishments, type GarnishmentOrder, type KindDefault } from "../../../../supabase/functions/_shared/garnishment-engine";

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

  // ────────── Phase 4 branches ──────────

  it("reserves always_first orders before the aggregate pool is consumed", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 0,
      orders: [
        order({ id: "cr", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 300 }),
        order({ id: "cs", kind: "child_support", cap_rule: "fixed_amount", fixed_amount: 400 }),
      ],
      policy: { aggregate_cap_pct: 0.25, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: {
        ...KIND_DEFAULTS,
        child_support: { counts_toward_aggregate_cap: false, aggregate_cap_membership: "always_first" },
      },
    });
    // always_first order runs first regardless of input order; pool = 25% of disposable = 250.
    expect(r.applied[0]).toMatchObject({ id: "cs", amount: 400 });
    expect(r.applied[1]).toMatchObject({ id: "cr", amount: 250 });
  });

  it("priority_class orders statutory kinds ahead of creditors", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 0,
      orders: [
        order({ id: "cr", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 200 }),
        order({ id: "tx", kind: "tax_levy", cap_rule: "fixed_amount", fixed_amount: 200 }),
      ],
      policy: { aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: {
        creditor: { counts_toward_aggregate_cap: true, priority_class: 5 },
        tax_levy: { counts_toward_aggregate_cap: true, priority_class: 2 },
      },
    });
    // tax_levy (class 2) executed before creditor (class 5), independent of array order.
    expect(r.applied.map(a => a.id)).toEqual(["tx", "cr"]);
  });

  it("protected_earnings_rule.min_pct_of_gross merges into the take-home floor", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 0,
      orders: [order({ id: "g1", kind: "child_support", cap_rule: "fixed_amount", fixed_amount: 800 })],
      policy: { aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: {
        child_support: {
          counts_toward_aggregate_cap: false,
          protected_earnings_rule: { min_pct_of_gross: 0.5 },
        },
      },
    });
    // gross 1000, min 50% = 500 floor → allowed garnishment = 500.
    expect(r.applied[0].amount).toBe(500);
  });

  it("falls back to pack calc_model when order.cap_rule is null", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 200,
      orders: [order({ id: "g1", kind: "creditor", cap_rule: null, percent_of_disposable: 0.25 })],
      policy: { aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: {
        creditor: { counts_toward_aggregate_cap: true, calc_model: "percent_disposable" },
      },
    });
    // disposable = 800, 25% = 200
    expect(r.applied[0].amount).toBe(200);
  });

  // ────────── Phase 4c: effective-window filter ──────────

  it("skips orders whose effective window does not overlap the payroll period", () => {
    const r = computeGarnishments({
      gross: 1000,
      preGarnishmentDeductions: 0,
      period_start: "2026-06-01",
      period_end: "2026-06-30",
      orders: [
        // Future-dated order (starts after period) — skipped
        order({ id: "future", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 100, start_date: "2026-07-15" }),
        // Expired order (ended before period) — skipped
        order({ id: "expired", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 100, end_date: "2026-05-01" }),
        // In-window
        order({ id: "live", kind: "creditor", cap_rule: "fixed_amount", fixed_amount: 100, start_date: "2026-01-01", end_date: "2026-12-31" }),
      ],
      policy: { aggregate_cap_pct: null, min_take_home_amount: null, min_take_home_pct: null },
      kindDefaults: KIND_DEFAULTS,
    });
    expect(r.applied.map(a => a.id)).toEqual(["live"]);
  });
});
