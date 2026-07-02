import { FieldDefinition } from "@/lib/importUtils";

/**
 * Canonical expense field definitions for CSV/XLSX import.
 * Used by the Expenses page import.
 *
 * DO NOT duplicate this. If you need expense import anywhere,
 * import from this file.
 */
export const EXPENSE_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "expense_date", label: "Date", required: true, type: "date", aliases: ["Date", "Expense Date", "Transaction Date"] },
  { key: "description", label: "Description", required: true, type: "text", aliases: ["Memo", "Details", "Narration"] },
  { key: "amount", label: "Amount", required: true, type: "number", aliases: ["Total", "Expense Amount"] },
  { key: "category_name", label: "Category", required: false, type: "text", aliases: ["Expense Category", "Type"] },
  { key: "vendor_name", label: "Supplier", required: false, type: "text", aliases: ["Vendor", "Supplier", "Payee", "Paid To"] },
  { key: "reference", label: "Reference", required: false, type: "text", aliases: ["Ref", "Receipt No", "Invoice No"] },
  { key: "tax_amount", label: "Tax Amount", required: false, type: "number", aliases: ["Tax", "VAT"] },
  { key: "payment_method", label: "Payment Method", required: false, type: "text", aliases: ["Payment", "Paid Via", "Settlement Method"] },
];
