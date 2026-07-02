/**
 * Phase 7 — Commercial-partner rollup helper.
 *
 * Pins the contract documented in ADR-0038: any read that wants to
 * aggregate a contact's transactions across its parent + children must
 * call `expandToCommercialPartnerSet`. Reimplementing the lookup inline
 * (as the statement hooks used to) is a regression.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, any>;
const state = {
  contacts: [] as Row[],
  filters: [] as Array<[string, any]>,
};

function makeQuery(_table: string) {
  let rows: Row[] = [...state.contacts];
  const api: any = {
    select: vi.fn(() => api),
    eq: vi.fn((col: string, val: any) => {
      state.filters.push([col, val]);
      rows = rows.filter((r) => r[col] === val);
      return api;
    }),
    single: vi.fn(async () => ({ data: rows[0] ?? null, error: null })),
    then: (resolve: any) => resolve({ data: rows, error: null }),
  };
  return api;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(() => makeQuery("contacts")) },
}));

import {
  resolveCommercialPartnerId,
  expandToCommercialPartnerSet,
} from "@/lib/contactHierarchy";

beforeEach(() => {
  state.contacts = [
    { id: "parent", commercial_partner_id: "parent", organization_id: "org-1", business_id: "biz-1" },
    { id: "child-a", commercial_partner_id: "parent", organization_id: "org-1", business_id: "biz-1" },
    { id: "child-b", commercial_partner_id: "parent", organization_id: "org-1", business_id: "biz-1" },
    { id: "unrelated", commercial_partner_id: "unrelated", organization_id: "org-1", business_id: "biz-1" },
    // Sibling business — must NOT leak into the rollup
    { id: "other-biz-child", commercial_partner_id: "parent", organization_id: "org-1", business_id: "biz-2" },
  ];
  state.filters = [];
});

describe("resolveCommercialPartnerId", () => {
  it("returns the contact's commercial partner id", async () => {
    expect(await resolveCommercialPartnerId("child-a")).toBe("parent");
  });

  it("returns self when the contact is the root", async () => {
    expect(await resolveCommercialPartnerId("parent")).toBe("parent");
  });
});

describe("expandToCommercialPartnerSet", () => {
  it("expands a child id into parent + every sibling in the same business", async () => {
    const ids = await expandToCommercialPartnerSet("child-a", {
      organizationId: "org-1",
      businessId: "biz-1",
    });
    expect(ids.sort()).toEqual(["child-a", "child-b", "parent"]);
  });

  it("never leaks contacts from a sibling business", async () => {
    const ids = await expandToCommercialPartnerSet("child-a", {
      organizationId: "org-1",
      businessId: "biz-1",
    });
    expect(ids).not.toContain("other-biz-child");
    // sanity: the mock saw the business_id filter
    expect(state.filters).toContainEqual(["business_id", "biz-1"]);
  });

  it("falls back to [contactId] when the family lookup is empty", async () => {
    state.contacts = [
      { id: "solo", commercial_partner_id: "solo", organization_id: "org-1", business_id: "biz-1" },
    ];
    // Hide everything by scoping to a business with no rows
    const ids = await expandToCommercialPartnerSet("solo", {
      organizationId: "org-1",
      businessId: "ghost-biz",
    });
    expect(ids).toEqual(["solo"]);
  });
});