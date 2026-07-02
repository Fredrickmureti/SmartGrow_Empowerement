import { FieldDefinition } from "@/lib/importUtils";

/**
 * Canonical invoice field definitions for CSV/XLSX import.
 * Used by the Invoices page import.
 *
 * DO NOT duplicate this. If you need invoice import anywhere,
 * import from this file.
 */
export const INVOICE_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "customer_name", label: "Customer", required: true, type: "text", aliases: ["Customer", "Client", "Customer Name", "Bill To"] },
  { key: "invoice_date", label: "Invoice Date", required: false, type: "date", aliases: ["Date", "Inv Date"] },
  { key: "due_date", label: "Due Date", required: false, type: "date", aliases: ["Due", "Payment Due"] },
  { key: "item_description", label: "Item/Description", required: true, type: "text", aliases: ["Description", "Item", "Product", "Service", "Line Item"] },
  { key: "quantity", label: "Quantity", required: false, type: "number", aliases: ["Qty", "Units"] },
  { key: "unit_price", label: "Unit Price", required: true, type: "number", aliases: ["Price", "Rate", "Amount"] },
  { key: "tax_rate", label: "Tax Rate (%)", required: false, type: "number", aliases: ["Tax", "VAT", "Tax %"] },
  { key: "discount_percent", label: "Discount (%)", required: false, type: "number", aliases: ["Discount", "Disc"] },
  { key: "notes", label: "Notes", required: false, type: "text", aliases: ["Memo", "Comments"] },
  { key: "reference", label: "Reference/Invoice #", required: false, type: "text", aliases: ["Ref", "Invoice Number", "Inv #", "Invoice No"] },
];
