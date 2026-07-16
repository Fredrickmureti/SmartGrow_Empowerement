import type { FieldDefinition } from "@/lib/importUtils";

/**
 * Canonical ASN (Advance Shipping Notice / EDI-856) field definitions
 * for CSV / XLSX import into `inbound_shipments` + `inbound_shipment_items`.
 *
 * Each CSV row represents one shipment LINE. Rows sharing the same
 * `shipment_number` are grouped into one shipment header at import time.
 * Header-level fields (`vendor_name`, `po_number`, `carrier`,
 * `tracking_number`, `expected_arrival`, `dispatched_at`) are read from
 * the FIRST row of each group.
 *
 * Phase D.3 · Inventory foundation. Sibling of
 * `purchaseOrderImportConfig.ts`. Downstream discrepancy tracking and
 * GRN prefill (Phase D.2) rely on this shape.
 */
export const ASN_IMPORT_FIELDS: FieldDefinition[] = [
  {
    key: "shipment_number",
    label: "Shipment #",
    required: true,
    type: "text",
    aliases: ["Shipment Number", "ASN #", "ASN Number", "Delivery #"],
  },
  {
    key: "po_number",
    label: "Purchase Order #",
    required: false,
    type: "text",
    aliases: ["PO #", "PO Number", "Order #", "Purchase Order"],
  },
  {
    key: "vendor_name",
    label: "Vendor",
    required: false,
    type: "text",
    aliases: ["Supplier", "From", "Vendor Name", "Supplier Name"],
  },
  {
    key: "carrier",
    label: "Carrier",
    required: false,
    type: "text",
    aliases: ["Freight Carrier", "Shipping Company"],
  },
  {
    key: "tracking_number",
    label: "Tracking #",
    required: false,
    type: "text",
    aliases: ["Tracking", "Waybill", "AWB"],
  },
  {
    key: "dispatched_at",
    label: "Dispatched",
    required: false,
    type: "date",
    aliases: ["Ship Date", "Dispatch Date", "Departed"],
  },
  {
    key: "expected_arrival",
    label: "Expected Arrival",
    required: false,
    type: "date",
    aliases: ["ETA", "Expected Delivery", "Arrival"],
  },
  {
    key: "product_sku",
    label: "Product SKU",
    required: true,
    type: "text",
    aliases: ["SKU", "Item Code", "Product Code", "Item"],
  },
  {
    key: "expected_quantity",
    label: "Expected Qty",
    required: true,
    type: "number",
    aliases: ["Qty", "Quantity", "Expected Quantity", "Units"],
  },
  {
    key: "expected_lot_number",
    label: "Lot / Batch #",
    required: false,
    type: "text",
    aliases: ["Lot", "Batch", "Lot Number", "Batch Number"],
  },
  {
    key: "expected_expiry_date",
    label: "Expiry Date",
    required: false,
    type: "date",
    aliases: ["Expires", "Expiration", "Best Before"],
  },
  {
    key: "expected_manufacture_date",
    label: "Manufacture Date",
    required: false,
    type: "date",
    aliases: ["Mfg Date", "Manufactured", "Production Date"],
  },
  {
    key: "notes",
    label: "Notes",
    required: false,
    type: "text",
    aliases: ["Memo", "Comments", "Remarks"],
  },
];
