/**
 * Wave 7.2 — kitchen ticket snapshot builder unit tests.
 */
import { describe, it, expect } from "vitest";
import {
  buildKitchenTicketSnapshot,
  type KitchenOrderRow,
} from "@/services/documents/snapshots/posKitchenTicket";

const base: KitchenOrderRow = {
  id: "ord-2",
  transaction_id: "txn-1",
  transaction_item_id: "ti-2",
  printer_category: "kitchen",
  priority: 0,
  notes: null,
  table_number: "T5",
  created_at: "2026-07-27T10:15:00Z",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  transaction: { transaction_number: "R-2026-0001" },
};

describe("buildKitchenTicketSnapshot", () => {
  it("emits the renderer-required keys and derives party/timing metadata", () => {
    const { snapshot, documentNumber, documentDate, sourceDocId } =
      buildKitchenTicketSnapshot({ orders: [base], station: "kitchen" });

    for (const k of [
      "document_type",
      "document_type_label",
      "document_number",
      "issue_date",
      "station",
      "table",
      "rush",
      "items",
    ]) {
      expect(snapshot, `missing renderer key: ${k}`).toHaveProperty(k);
    }
    expect(snapshot.document_type).toBe("kitchen_ticket");
    expect(documentNumber).toBe("R-2026-0001");
    expect(documentDate).toBe("2026-07-27");
    expect(sourceDocId).toBe("txn-1");
    expect((snapshot.items as unknown[]).length).toBe(1);
  });

  it("marks rush when any order has priority > 0 and preserves item order deterministically", () => {
    const orders: KitchenOrderRow[] = [
      { ...base, id: "ord-3", transaction_item_id: "ti-3" },
      { ...base, id: "ord-1", transaction_item_id: "ti-1", priority: 2 },
    ];
    const { snapshot } = buildKitchenTicketSnapshot({ orders, station: "kitchen" });
    expect(snapshot.rush).toBe(true);
    expect(snapshot.document_type_label).toBe("RUSH — KITCHEN");
    const items = snapshot.items as Array<{ transaction_item_id: string }>;
    // Sorted by id ascending → ti-1, ti-3.
    expect(items.map((i) => i.transaction_item_id)).toEqual(["ti-1", "ti-3"]);
  });

  it("collects notes into a single joined string, null when none", () => {
    const orders: KitchenOrderRow[] = [
      { ...base, id: "a", notes: "no onions" },
      { ...base, id: "b", notes: "extra spicy" },
    ];
    expect(buildKitchenTicketSnapshot({ orders, station: "kitchen" }).snapshot.notes)
      .toBe("no onions · extra spicy");
    expect(buildKitchenTicketSnapshot({ orders: [base], station: "kitchen" }).snapshot.notes)
      .toBeNull();
  });

  it("refuses an empty order list", () => {
    expect(() => buildKitchenTicketSnapshot({ orders: [], station: "kitchen" }))
      .toThrow(/must not be empty/);
  });

  it("uses the earliest created_at across grouped orders as issue_date", () => {
    const orders: KitchenOrderRow[] = [
      { ...base, id: "a", created_at: "2026-07-27T10:20:00Z" },
      { ...base, id: "b", created_at: "2026-07-27T10:05:00Z" },
    ];
    const { snapshot, documentDate } = buildKitchenTicketSnapshot({ orders, station: "kitchen" });
    expect(snapshot.issue_date).toBe("2026-07-27T10:05:00Z");
    expect(documentDate).toBe("2026-07-27");
  });
});
