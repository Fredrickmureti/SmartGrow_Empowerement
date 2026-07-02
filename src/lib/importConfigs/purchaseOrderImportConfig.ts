import { FieldDefinition } from "@/lib/importUtils";

/**
 * Canonical purchase order field definitions for CSV/XLSX import.
 * Used by the PurchaseOrders page import.
 *
 * DO NOT duplicate this. If you need purchase order import anywhere,
 * import from this file.
 */
export const PURCHASE_ORDER_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "vendor_name", label: "Supplier", required: true, type: "text", aliases: ["Vendor", "Supplier", "Supplier Name", "Vendor Name", "From"] },
  { key: "reference", label: "Reference/PO #", required: false, type: "text", aliases: ["Ref", "PO Number", "PO #", "Order Number", "Num"] },
  { key: "order_date", label: "Order Date", required: false, type: "date", aliases: ["Date", "Order Date"] },
  { key: "expected_date", label: "Expected Date", required: false, type: "date", aliases: ["Expected", "Delivery Date"] },
  { key: "item_description", label: "Item/Description", required: true, type: "text", aliases: ["Description", "Item", "Product", "Line Item"] },
  { key: "quantity", label: "Quantity", required: false, type: "number", aliases: ["Qty", "Units"] },
  { key: "unit_price", label: "Unit Price", required: true, type: "number", aliases: ["Price", "Rate", "Cost", "Amount"] },
  { key: "tax_rate", label: "Tax Rate (%)", required: false, type: "number", aliases: ["Tax", "VAT", "Tax %"] },
  { key: "notes", label: "Notes", required: false, type: "text", aliases: ["Memo", "Comments"] },
];
