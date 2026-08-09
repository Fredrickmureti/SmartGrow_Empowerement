/**
 * Phase 7 — Business-party & address lifecycle: business-event tests.
 *
 * These are not unit tests of string helpers. Each case is an event a user
 * can actually cause, pinned against the contract in ADR-0080:
 *
 *   1. A party with several ship-to addresses resolves the right one.
 *   2. Changing the default address AFTER a document exists must not move
 *      the document — the printed snapshot is historical truth.
 *   3. An address belonging to another business is never reachable.
 *   4. A GRN inherits its destination from the originating PO.
 *   5. An issued invoice's address is immutable under master-data edits.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, any>;

const state = {
  /** Every contact row the mocked "database" holds, across businesses. */
  contacts: [] as Row[],
  /** RLS stand-in: reads only see rows of this business. */
  visibleBusinessId: "biz-1",
};

function makeContactsQuery() {
  let rows: Row[] = state.contacts.filter(
    (r) => r.business_id === state.visibleBusinessId,
  );
  const api: any = {
    select: vi.fn(() => api),
    eq: vi.fn((col: string, val: any) => {
      rows = rows.filter((r) => r[col] === val);
      return api;
    }),
    order: vi.fn(() => api),
    maybeSingle: vi.fn(async () => ({ data: rows[0] ?? null, error: null })),
    single: vi.fn(async () => ({ data: rows[0] ?? null, error: null })),
    then: (resolve: any) => resolve({ data: rows, error: null }),
  };
  return api;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(() => makeContactsQuery()) },
}));

import {
  listPartyAddresses,
  pickAddressForRole,
  captureBillToSnapshot,
  captureRemitToSnapshot,
  formatAddress,
  type PartyAddress,
} from "@/lib/contactAddresses";
import { resolveSnapshotAddress } from "@/services/documents/snapshots/partyAddress";
import { buildSalesInvoiceSnapshot } from "@/services/documents/snapshots/salesInvoice";
import { buildPurchasesGrnSnapshot } from "@/services/documents/snapshots/purchasesGrn";

function address(overrides: Partial<PartyAddress> = {}): PartyAddress {
  return {
    id: "addr-1",
    name: "Acme Ltd",
    child_address_type: null,
    address_line1: "1 Main St",
    address_line2: null,
    city: "Nairobi",
    state: null,
    postal_code: "00100",
    country: "Kenya",
    email: null,
    phone: null,
    is_default_shipping: false,
    is_default_billing: false,
    is_party_itself: false,
    ...overrides,
  };
}

beforeEach(() => {
  state.contacts = [];
  state.visibleBusinessId = "biz-1";
  vi.clearAllMocks();
});

describe("event: a party keeps several ship-to addresses", () => {
  const party = address({
    id: "party-1",
    is_party_itself: true,
    address_line1: "HQ Tower",
  });
  const warehouseDrop = address({
    id: "addr-wh",
    name: "Acme — Industrial Area",
    child_address_type: "delivery",
    address_line1: "Plot 42, Industrial Area",
  });
  const site = address({
    id: "addr-site",
    name: "Acme — Site B",
    child_address_type: "delivery",
    address_line1: "Site B",
  });
  const billing = address({
    id: "addr-bill",
    name: "Acme — Accounts",
    child_address_type: "invoice",
    address_line1: "Finance House",
  });

  it("uses the flagged default over any other delivery address", () => {
    const flagged = { ...site, is_default_shipping: true };
    const picked = pickAddressForRole(
      [party, warehouseDrop, flagged, billing],
      "shipping",
    );
    expect(picked?.id).toBe("addr-site");
  });

  it("falls back to the first delivery-role address when no default is flagged", () => {
    const picked = pickAddressForRole([party, warehouseDrop, site], "shipping");
    expect(picked?.id).toBe("addr-wh");
  });

  it("falls back to the party's own address when it keeps none", () => {
    const picked = pickAddressForRole([party], "shipping");
    expect(picked?.id).toBe("party-1");
  });

  it("never returns a delivery address for the billing role when an invoice address exists", () => {
    const picked = pickAddressForRole(
      [party, warehouseDrop, billing],
      "billing",
    );
    expect(picked?.id).toBe("addr-bill");
  });
});

describe("event: the default address changes after a document exists", () => {
  it("leaves the already-printed snapshot untouched", () => {
    const printed = formatAddress(address({ address_line1: "Plot 42" }));

    // The customer moves; master data now says something else entirely.
    const movedParty = {
      address_line1: "New Riverside Drive",
      city: "Mombasa",
      postal_code: "80100",
      country: "Kenya",
    };

    expect(resolveSnapshotAddress(printed, movedParty)).toBe(printed);
    expect(resolveSnapshotAddress(printed, movedParty)).toContain("Plot 42");
    expect(resolveSnapshotAddress(printed, movedParty)).not.toContain("Mombasa");
  });

  it("uses live master data only for legacy rows that never captured one", () => {
    const resolved = resolveSnapshotAddress(null, {
      address_line1: "New Riverside Drive",
      city: "Mombasa",
      postal_code: "80100",
      country: "Kenya",
    });
    expect(resolved).toContain("New Riverside Drive");
    expect(resolved).toContain("Mombasa, 80100");
  });

  it("treats a whitespace-only snapshot as absent rather than as an empty address", () => {
    expect(resolveSnapshotAddress("   \n ", { address_line1: "HQ Tower" })).toBe(
      "HQ Tower",
    );
  });
});

describe("event: a document references a party from another business", () => {
  beforeEach(() => {
    state.contacts = [
      {
        id: "foreign-party",
        business_id: "biz-2",
        name: "Other Co",
        parent_contact_id: null,
        address_line1: "Elsewhere",
        city: "Kisumu",
      },
    ];
    state.visibleBusinessId = "biz-1";
  });

  it("resolves no addresses at all", async () => {
    await expect(listPartyAddresses("foreign-party")).resolves.toEqual([]);
  });

  it("captures an empty bill-to snapshot instead of leaking the foreign address", async () => {
    const snapshot = await captureBillToSnapshot("foreign-party");
    expect(snapshot.billing_address).toBeNull();
  });

  it("captures an empty remit-to snapshot on the purchase side too", async () => {
    const snapshot = await captureRemitToSnapshot("foreign-party");
    expect(snapshot.remit_to_address).toBeNull();
    expect(snapshot.remit_to_contact_id).toBeNull();
  });
});

describe("event: capturing the bill-to snapshot at creation time", () => {
  beforeEach(() => {
    state.contacts = [
      {
        id: "party-1",
        business_id: "biz-1",
        name: "Acme Ltd",
        parent_contact_id: null,
        address_line1: "HQ Tower",
        city: "Nairobi",
        postal_code: "00100",
        country: "Kenya",
      },
    ];
  });

  it("freezes both the link and the rendered text", async () => {
    const snapshot = await captureBillToSnapshot("party-1");
    expect(snapshot.bill_to_contact_id).toBe("party-1");
    expect(snapshot.billing_address).toContain("HQ Tower");
    expect(snapshot.billing_address).toContain("Nairobi, 00100");
  });

  it("returns empty fields — never throws — when no party is given", async () => {
    await expect(captureBillToSnapshot(null)).resolves.toEqual({
      bill_to_contact_id: null,
      billing_address: null,
    });
  });
});

describe("event: goods are received against a purchase order", () => {
  const grnBase = {
    id: "grn-1",
    receipt_number: "GRN-0001",
    status: "received",
    receipt_date: "2026-08-09T08:00:00Z",
    notes: null,
    organization_id: "org-1",
    business_id: "biz-1",
    branch_id: "br-1",
    purchase_order_id: "po-1",
    purchase_order: {
      po_number: "PO-0007",
      currency: "KES",
      vendor_id: "vendor-1",
      vendor: { name: "Acme Supplies", email: "ap@acme.test" },
      shipping_address: "Old text destination",
      deliver_to_warehouse: { name: "Central Warehouse" },
      deliver_to_branch: null,
    },
    items: [],
  } as any;

  it("prints OUR warehouse as the destination, inherited from the PO", () => {
    const { snapshot } = buildPurchasesGrnSnapshot(grnBase);
    // Name of the location first, then the address text the PO froze —
    // a dock worker needs both lines.
    expect(snapshot.shipping_address).toBe(
      "Central Warehouse\nOld text destination",
    );
  });

  it("falls back to the branch, then to the PO text snapshot", () => {
    const viaBranch = buildPurchasesGrnSnapshot({
      ...grnBase,
      purchase_order: {
        ...grnBase.purchase_order,
        deliver_to_warehouse: null,
        deliver_to_branch: { name: "Westlands Branch" },
      },
    });
    expect(viaBranch.snapshot.shipping_address).toBe(
      "Westlands Branch\nOld text destination",
    );

    const viaText = buildPurchasesGrnSnapshot({
      ...grnBase,
      purchase_order: {
        ...grnBase.purchase_order,
        deliver_to_warehouse: null,
        deliver_to_branch: null,
      },
    });
    expect(viaText.snapshot.shipping_address).toBe("Old text destination");
  });

  it("prints nothing rather than inventing a destination when the PO has none", () => {
    const { snapshot } = buildPurchasesGrnSnapshot({
      ...grnBase,
      purchase_order: {
        ...grnBase.purchase_order,
        shipping_address: null,
        deliver_to_warehouse: null,
        deliver_to_branch: null,
      },
    });
    expect(snapshot.shipping_address).toBeNull();
  });

  it("never prints the supplier's own address as the destination", () => {
    const { snapshot } = buildPurchasesGrnSnapshot(grnBase);
    expect(snapshot.shipping_address).not.toContain("Acme Supplies");
  });
});

describe("event: an issued invoice is reprinted after the customer moves", () => {
  const invoiceBase = {
    id: "inv-1",
    invoice_number: "INV-2026-0001",
    status: "sent",
    issue_date: "2026-07-27",
    due_date: "2026-08-27",
    subtotal: 100,
    tax_amount: 16,
    discount_amount: 0,
    total: 116,
    amount_paid: 0,
    currency: "KES",
    notes: null,
    terms: null,
    organization_id: "org-1",
    business_id: "biz-1",
    branch_id: "br-1",
    business: { id: "biz-1", name: "Widget Co" },
    invoice_items: [],
  } as any;

  it("prints the frozen address, not the customer's current one", () => {
    const { snapshot } = buildSalesInvoiceSnapshot({
      ...invoiceBase,
      billing_address: "Plot 42, Industrial Area\nNairobi, 00100\nKenya",
      contact: {
        name: "Acme Ltd",
        address_line1: "New Riverside Drive",
        city: "Mombasa",
        postal_code: "80100",
        country: "Kenya",
      },
    });
    expect(snapshot.billing_address).toContain("Plot 42");
    expect(snapshot.billing_address).not.toContain("Mombasa");
  });

  it("still prints something for pre-snapshot invoices", () => {
    const { snapshot } = buildSalesInvoiceSnapshot({
      ...invoiceBase,
      billing_address: null,
      contact: {
        name: "Acme Ltd",
        address_line1: "New Riverside Drive",
        city: "Mombasa",
        postal_code: "80100",
        country: "Kenya",
      },
    });
    expect(snapshot.billing_address).toContain("New Riverside Drive");
  });
});
