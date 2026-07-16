/**
 * Phase A.3 architecture guard — outbound lot / serial pickers on
 * user-facing line editors.
 *
 * The DB rejects outbound `stock_movements` for lot-tracked or
 * serial-tracked products without a `lot_number` / serial linkage
 * (ADR 0025, 0066, 0067). Users would otherwise author invoices,
 * credit notes, sales returns and delivery notes with no lot / serial
 * on the line and only discover the failure at post time.
 *
 * `OutboundLineTracking` is the single shared cell that reads the
 * product tracking flags and renders the appropriate picker(s). This
 * guard pins:
 *
 * 1. The picker primitives exist and have the expected contract.
 * 2. The shared cell reads tracking flags and delegates to the
 *    right picker per flag.
 * 3. Every outbound line editor mounts the shared cell so the guard
 *     surfaces before post.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8");

describe("Phase A.3 — SerialPickerPopover primitive", () => {
  const src = read("src/components/inventory/SerialPickerPopover.tsx");
  it("filters serials by status='in_stock'", () => {
    expect(src).toMatch(/\.eq\("status",\s*"in_stock"\)/);
  });
  it("reads from stock_serials scoped by business_id + product_id", () => {
    expect(src).toMatch(/from\("stock_serials"\)/);
    expect(src).toMatch(/\.eq\("business_id"/);
    expect(src).toMatch(/\.eq\("product_id"/);
  });
  it("scopes the query by warehouse_id when supplied", () => {
    expect(src).toMatch(/\.eq\("warehouse_id",\s*warehouseId\)/);
  });
});

describe("Phase A.3 — useProductTrackingFlags hook", () => {
  const src = read("src/hooks/useProductTrackingFlags.ts");
  it("batches by product id list", () => {
    expect(src).toMatch(/\.in\("id",\s*cleaned\)/);
  });
  it("reads all three tracking flags in one round-trip", () => {
    expect(src).toMatch(/is_lot_tracked/);
    expect(src).toMatch(/is_expiry_tracked/);
    expect(src).toMatch(/is_serial_tracked/);
  });
});

describe("Phase A.3 — OutboundLineTracking shared cell", () => {
  const src = read("src/components/inventory/OutboundLineTracking.tsx");
  it("reads product tracking flags via useProductTrackingFlags", () => {
    expect(src).toMatch(/useProductTrackingFlags/);
  });
  it("renders LotPickerPopover only when is_lot_tracked", () => {
    expect(src).toMatch(
      /flags\.is_lot_tracked\s*&&\s*\(\s*<LotPickerPopover/,
    );
  });
  it("renders SerialPickerPopover only when is_serial_tracked", () => {
    expect(src).toMatch(
      /flags\.is_serial_tracked\s*&&\s*\(\s*<SerialPickerPopover/,
    );
  });
  it("resolves business + warehouse from context (no hard-coded scope)", () => {
    expect(src).toMatch(/useBusinesses\(\)/);
    expect(src).toMatch(/useBranch\(\)/);
    expect(src).toMatch(/default_warehouse_id/);
  });
});

describe("Phase A.3 — outbound line editors mount OutboundLineTracking", () => {
  const surfaces = [
    "src/components/invoices/InvoiceLineRow.tsx",
    "src/features/sales/credit-notes/CreditNoteCreatePage.tsx",
    "src/features/sales/returns/SalesReturnCreatePage.tsx",
    "src/features/sales/delivery-notes/DeliveryNoteCreatePage.tsx",
  ];

  for (const file of surfaces) {
    describe(file, () => {
      const src = read(file);
      it("imports OutboundLineTracking from @/components/inventory", () => {
        expect(src).toMatch(
          /from\s+["']@\/components\/inventory\/OutboundLineTracking["']/,
        );
      });
      it("renders <OutboundLineTracking /> with a productId prop", () => {
        expect(src).toMatch(/<OutboundLineTracking[\s\S]*?productId=/);
      });
      it("wires onLotChange to persist lot_number (Phase A.4)", () => {
        expect(src).toMatch(/onLotChange=/);
        expect(src).toMatch(/lotNumberFromAllocations/);
      });
      it("wires onSerialChange to persist serial_number (Phase A.4)", () => {
        expect(src).toMatch(/onSerialChange=/);
        expect(src).toMatch(/serialNumberFromRows/);
      });
    });
  }
});

describe("Phase A.4 — outbound hooks pass picker output to DB", () => {
  const cases = [
    { file: "src/hooks/useInvoices.ts", table: "invoice_items" },
    { file: "src/hooks/useSalesReturns.ts", table: "sales_return_items" },
    { file: "src/hooks/useDeliveryNotes.ts", table: "delivery_note_items" },
  ];
  for (const { file, table } of cases) {
    it(`${file} inserts lot_number/serial_number into ${table}`, () => {
      const src = read(file);
      expect(src).toMatch(new RegExp(`from\\("${table}"\\)`));
      expect(src).toMatch(/lot_number:/);
      expect(src).toMatch(/serial_number:/);
    });
  }

  it("useDeliveryNotes additionally persists lot_allocations JSON", () => {
    const src = read("src/hooks/useDeliveryNotes.ts");
    expect(src).toMatch(/lot_allocations:/);
  });

  it("CreditNoteCreatePage spreads full LineItem so credit_note_items receives lot_number/serial_number", () => {
    const page = read("src/features/sales/credit-notes/CreditNoteCreatePage.tsx");
    // Page wires updateLineItem for lot_number/serial_number; hook uses `...item` spread.
    expect(page).toMatch(/"lot_number"/);
    expect(page).toMatch(/"serial_number"/);
    const hook = read("src/hooks/useCreditNotes.ts");
    expect(hook).toMatch(/\.\.\.item/);
    expect(hook).toMatch(/from\("credit_note_items"\)/);
  });
});

describe("Phase A.4 — outboundLineTrackingUtils normalizer", () => {
  const src = read("src/components/inventory/outboundLineTrackingUtils.ts");
  it("exports lotNumberFromAllocations, lotAllocationsJson, serialNumberFromRows", () => {
    expect(src).toMatch(/export function lotNumberFromAllocations/);
    expect(src).toMatch(/export function lotAllocationsJson/);
    expect(src).toMatch(/export function serialNumberFromRows/);
  });
});

