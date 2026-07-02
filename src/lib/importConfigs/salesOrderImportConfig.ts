import { FieldDefinition } from "@/lib/importUtils";

/**
 * Canonical sales order field definitions for CSV/XLSX import.
 * Used by the SalesOrders page import.
 *
 * DO NOT duplicate this. If you need sales order import anywhere,
 * import from this file.
 */
export const SALES_ORDER_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "customer_name", label: "Customer", required: true, type: "text", aliases: ["Customer", "Client", "Customer Name", "Bill To", "Ship To"] },
  { key: "reference", label: "Reference/SO #", required: false, type: "text", aliases: ["Ref", "SO Number", "SO #", "Order Number", "Num"] },
  { key: "order_date", label: "Order Date", required: false, type: "date", aliases: ["Date", "Order Date"] },
  { key: "expected_date", label: "Expected Date", required: false, type: "date", aliases: ["Expected", "Delivery Date", "Ship Date"] },
  { key: "item_description", label: "Item/Description", required: true, type: "text", aliases: ["Description", "Item", "Product", "Service", "Line Item"] },
  { key: "quantity", label: "Quantity", required: false, type: "number", aliases: ["Qty", "Units"] },
  { key: "unit_price", label: "Unit Price", required: true, type: "number", aliases: ["Price", "Rate", "Amount"] },
  { key: "tax_rate", label: "Tax Rate (%)", required: false, type: "number", aliases: ["Tax", "VAT", "Tax %"] },
  { key: "discount_percent", label: "Discount (%)", required: false, type: "number", aliases: ["Discount", "Disc"] },
  { key: "notes", label: "Notes", required: false, type: "text", aliases: ["Memo", "Comments"] },
];
