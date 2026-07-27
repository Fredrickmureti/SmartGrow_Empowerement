/**
 * Wave 7.2 · Step 3 — sales delivery note snapshot builder unit test.
 *
 * Beyond the usual projection lock, this pins the three delivery-note
 * business rules: amounts are structurally suppressed, the recipient
 * chain refuses raw UUIDs, and retired automation tokens never reach
 * the printed page.
 */
import { describe, it, expect } from "vitest";
import {
  buildSalesDeliveryNoteSnapshot,
  stripAutomationTokens,
} from "@/services/documents/snapshots/salesDeliveryNote";
import type { SalesDeliveryNoteHeaderRow } from "@/services/documents/snapshots/salesDeliveryNote";

const ROW: SalesDeliveryNoteHeaderRow = {
  id: "dn-1",
  delivery_number: "DN-2026-0011",
  status: "dispatched",
  delivery_date: "2026-07-27",
  notes: "Leave at gate",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  shipping_address: "12 Industrial Way",
  driver_name: "Otieno",
  vehicle_number: "KDA 123X",
  shipping_method: "own_fleet",
  tracking_number: "TRK/9 9",
  dispatch_route: "North",
  dispatched_at: "2026-07-27T08:00:00Z",
  delivered_at: null,
  ready_at: "2026-07-26T16:00:00Z",
  freight_cost: 1500,
  freight_currency: "KES",
  is_backorder: false,
  contact: { name: "Acme Ltd", phone: "+254700000000" },
  business: { id: "biz-1", name: "Widget Co", base_currency: "KES" },
  carrier: { name: "SwiftFreight", tracking_url_template: "https://t.test/{tracking_number}" },
  backorder_of: null,
  items: [
    {
      description: "Widget",
      quantity_ordered: 10,
      quantity_delivered: 8,
      packaging: { name: "BOX", qty_in_base_uom: 10 },
      product: { base_uom: { code: "EA", name: "Each" } },
    },
  ],
};

describe("buildSalesDeliveryNoteSnapshot", () => {
  it("emits the delivery note document type + label the renderer keys off", () => {
    const { snapshot } = buildSalesDeliveryNoteSnapshot(ROW);
    expect(snapshot.document_type).toBe("delivery_note");
    expect(snapshot.document_type_label).toBe("DELIVERY NOTE");
    expect(snapshot.document_number).toBe("DN-2026-0011");
  });

  it("returns routing metadata for ensureDocumentRecord", () => {
    const built = buildSalesDeliveryNoteSnapshot(ROW);
    expect(built.documentDate).toBe("2026-07-27");
    expect(built.organizationId).toBe("org-1");
    expect(built.businessId).toBe("biz-1");
    expect(built.branchId).toBe("br-1");
    expect(built.currency).toBe("KES");
    expect(built.sourceDocId).toBe("dn-1");
  });

  it("suppresses amounts structurally — a DN is a goods document", () => {
    const { snapshot } = buildSalesDeliveryNoteSnapshot(ROW);
    expect(snapshot.hide_amounts).toBe(true);
    expect(snapshot.subtotal).toBe(0);
    expect(snapshot.total).toBe(0);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].unit_price).toBe(0);
    expect(items[0].line_total).toBe(0);
    expect(items[0].quantity).toBe(10);
    expect(items[0].quantity_delivered).toBe(8);
  });

  it("builds the carrier tracking URL with an encoded tracking number", () => {
    const { snapshot } = buildSalesDeliveryNoteSnapshot(ROW);
    expect(snapshot.carrier_tracking_url).toBe("https://t.test/TRK%2F9%209");
    expect(snapshot.carrier_name).toBe("SwiftFreight");
  });

  it("resolves the recipient chain: contact → POD → staff → legacy text", () => {
    expect(
      buildSalesDeliveryNoteSnapshot({
        ...ROW,
        received_by_contact: { name: "Jane Contact" },
        delivery_proofs: [{ received_by_name: "Pod Person", received_at: null }],
      }).snapshot.received_by_name,
    ).toBe("Jane Contact");

    expect(
      buildSalesDeliveryNoteSnapshot({
        ...ROW,
        delivery_proofs: [{ received_by_name: "Pod Person", received_at: null }],
      }).snapshot.received_by_name,
    ).toBe("Pod Person");

    expect(
      buildSalesDeliveryNoteSnapshot(ROW, { receivedByUserName: "Staff Sam" })
        .snapshot.received_by_name,
    ).toBe("Staff Sam");

    expect(
      buildSalesDeliveryNoteSnapshot({ ...ROW, received_by: "Legacy Larry" })
        .snapshot.received_by_name,
    ).toBe("Legacy Larry");
  });

  it("never prints a raw UUID as a recipient name", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const { snapshot } = buildSalesDeliveryNoteSnapshot({
      ...ROW,
      delivery_proofs: [{ received_by_name: uuid, received_at: null }],
      received_by: uuid,
    });
    expect(snapshot.received_by_name).toBeNull();
  });

  it("strips retired auto-from-invoice automation tokens from notes", () => {
    expect(
      stripAutomationTokens(
        "Auto-created from invoice INV-1 [auto-from-invoice:3f2504e0-4f89-11d3-9a0c-0305e82c3301] (backfill)",
      ),
    ).toBeNull();
    expect(
      stripAutomationTokens(
        "Handle with care [auto-from-invoice:3f2504e0-4f89-11d3-9a0c-0305e82c3301]",
      ),
    ).toBe("Handle with care");
  });

  it("resolves unit_of_measure through packaging then base UOM", () => {
    const items = buildSalesDeliveryNoteSnapshot(ROW).snapshot.items as Array<
      Record<string, unknown>
    >;
    expect(items[0].unit_of_measure).toBe("BOX");

    const noPack = buildSalesDeliveryNoteSnapshot({
      ...ROW,
      items: [{ ...ROW.items![0], packaging: null }],
    });
    expect(
      (noPack.snapshot.items as Array<Record<string, unknown>>)[0].unit_of_measure,
    ).toBe("EA");
  });

  it("falls back to KES when neither business nor caller supplies a currency", () => {
    const { currency } = buildSalesDeliveryNoteSnapshot({ ...ROW, business: null });
    expect(currency).toBe("KES");
    expect(
      buildSalesDeliveryNoteSnapshot(
        { ...ROW, business: null },
        { fallbackCurrency: "UGX" },
      ).currency,
    ).toBe("UGX");
  });

  it("is deterministic — repeat calls serialize identically", () => {
    const a = JSON.stringify(buildSalesDeliveryNoteSnapshot(ROW).snapshot);
    const b = JSON.stringify(buildSalesDeliveryNoteSnapshot(ROW).snapshot);
    expect(a).toBe(b);
  });

  it("refuses to build without the identity fields the record upsert needs", () => {
    expect(() => buildSalesDeliveryNoteSnapshot({ ...ROW, id: "" })).toThrow(/dn\.id/);
    expect(() =>
      buildSalesDeliveryNoteSnapshot({ ...ROW, delivery_number: "" }),
    ).toThrow(/delivery_number/);
    expect(() =>
      buildSalesDeliveryNoteSnapshot({ ...ROW, delivery_date: "" }),
    ).toThrow(/delivery_date/);
  });
});
