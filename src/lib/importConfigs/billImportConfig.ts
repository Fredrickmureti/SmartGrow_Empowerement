import { FieldDefinition } from "@/lib/importUtils";

/**
 * Canonical bill field definitions for CSV/XLSX import.
 * Used by the Bills page import.
 *
 * DO NOT duplicate this. If you need bill import anywhere,
 * import from this file.
 */
export const BILL_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "vendor_name", label: "Supplier", required: true, type: "text", aliases: ["Vendor", "Supplier", "Supplier Name", "Vendor Name", "From"] },
  { key: "vendor_invoice_number", label: "Vendor Invoice #", required: false, type: "text", aliases: ["Invoice #", "Vendor Ref", "Bill No"] },
  { key: "bill_date", label: "Bill Date", required: false, type: "date", aliases: ["Date", "Invoice Date"] },
  { key: "due_date", label: "Due Date", required: false, type: "date", aliases: ["Due", "Payment Due"] },
  { key: "item_description", label: "Item/Description", required: true, type: "text", aliases: ["Description", "Item", "Product", "Line Item"] },
  { key: "quantity", label: "Quantity", required: false, type: "number", aliases: ["Qty", "Units"] },
  { key: "unit_price", label: "Unit Price", required: true, type: "number", aliases: ["Price", "Rate", "Cost", "Amount"] },
  { key: "tax_rate", label: "Tax Rate (%)", required: false, type: "number", aliases: ["Tax", "VAT", "Tax %"] },
  { key: "notes", label: "Notes", required: false, type: "text", aliases: ["Memo", "Comments"] },
];
