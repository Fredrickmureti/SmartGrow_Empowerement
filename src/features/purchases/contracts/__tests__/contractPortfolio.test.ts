/**
 * Contract portfolio lenses — expiry, exhaustion and KPI arithmetic.
 * These decide what a buyer sees as "at risk", so they are pinned.
 */
import { describe, expect, it } from "vitest";
import {
  daysToExpiry,
  exhaustionPercent,
  matchesLens,
  portfolioKpis,
  remainingValue,
  type ContractRow,
} from "../useContracts";

function iso(daysFromToday: number) {
  const t = new Date();
  const base = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return new Date(base + daysFromToday * 86_400_000).toISOString().slice(0, 10);
}

function row(partial: Partial<ContractRow>): ContractRow {
  return {
    id: crypto.randomUUID(),
    organization_id: "org",
    business_id: "biz",
    supplier_id: "sup-1",
    contract_number: "PC-0001",
    title: "Master supply",
    kind: "framework",
    status: "active",
    currency: "KES",
    base_currency: "KES",
    exchange_rate: 1,
    exchange_rate_date: null,
    start_date: iso(-30),
    end_date: iso(365),
    ceiling_value: 1000,
    committed_value: 0,
    received_value: 0,
    billed_value: 0,
    paid_value: 0,
    current_version: 1,
    price_tolerance_percent: null,
    price_tolerance_amount: null,
    enforce_item_coverage: true,
    auto_renew: false,
    notes: null,
    approval_request_id: null,
    submitted_at: null,
    approved_at: null,
    suspended_at: null,
    suspension_reason: null,
    terminated_at: null,
    terminated_reason: null,
    closed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  } as ContractRow;
}

describe("expiry", () => {
  it("is null for an open-ended contract", () => {
    expect(daysToExpiry({ end_date: null })).toBeNull();
  });

  it("counts whole days forward and backward", () => {
    expect(daysToExpiry({ end_date: iso(45) })).toBe(45);
    expect(daysToExpiry({ end_date: iso(-3) })).toBe(-3);
  });
});

describe("exhaustion", () => {
  it("measures committed against the ceiling, never received", () => {
    expect(
      exhaustionPercent({ ceiling_value: 200, committed_value: 150 }),
    ).toBeCloseTo(75);
  });

  it("is null without a value ceiling", () => {
    expect(exhaustionPercent({ ceiling_value: null, committed_value: 10 })).toBeNull();
  });

  it("remaining capacity nets off commitments", () => {
    expect(remainingValue({ ceiling_value: 500, committed_value: 120 })).toBe(380);
  });
});

describe("lifecycle lenses", () => {
  it("expiry windows are nested and exclude lapsed contracts", () => {
    const soon = row({ end_date: iso(20) });
    expect(matchesLens(soon, "expiring_30")).toBe(true);
    expect(matchesLens(soon, "expiring_90")).toBe(true);

    const later = row({ end_date: iso(75) });
    expect(matchesLens(later, "expiring_30")).toBe(false);
    expect(matchesLens(later, "expiring_90")).toBe(true);

    const lapsed = row({ end_date: iso(-1) });
    expect(matchesLens(lapsed, "expiring_30")).toBe(false);
  });

  it("only live contracts can be near-exhausted", () => {
    expect(matchesLens(row({ committed_value: 950 }), "exhausted")).toBe(true);
    expect(matchesLens(row({ committed_value: 400 }), "exhausted")).toBe(false);
    expect(
      matchesLens(row({ committed_value: 950, status: "terminated" }), "exhausted"),
    ).toBe(false);
  });

  it("draft contracts never appear in a risk lens", () => {
    const draft = row({ status: "draft", end_date: iso(5), committed_value: 990 });
    expect(matchesLens(draft, "expiring_30")).toBe(false);
    expect(matchesLens(draft, "exhausted")).toBe(false);
    expect(matchesLens(draft, "all")).toBe(true);
  });
});

describe("portfolio KPIs", () => {
  it("counts states and sums only live commitment capacity", () => {
    const kpis = portfolioKpis([
      row({ committed_value: 950, end_date: iso(10) }),
      row({ status: "pending_approval", ceiling_value: 400 }),
      row({ status: "expired", ceiling_value: 999 }),
      row({ end_date: iso(200), committed_value: 100 }),
    ]);
    expect(kpis.active).toBe(2);
    expect(kpis.pendingApproval).toBe(1);
    expect(kpis.expired).toBe(1);
    expect(kpis.expiring30).toBe(1);
    expect(kpis.exhausted).toBe(1);
    expect(kpis.committedValue).toBe(1050);
    expect(kpis.ceilingValue).toBe(2000);
  });
});
