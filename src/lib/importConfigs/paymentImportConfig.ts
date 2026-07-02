import { FieldDefinition } from "@/lib/importUtils";

/**
 * Canonical payment field definitions for CSV/XLSX import.
 * Used by the CustomerPayments page import.
 *
 * DO NOT duplicate this. If you need payment import anywhere,
 * import from this file.
 */
export const PAYMENT_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "customer_name", label: "Customer", required: true, type: "text", aliases: ["Customer", "Client", "Customer Name", "Received From", "Name"] },
  { key: "payment_date", label: "Payment Date", required: true, type: "date", aliases: ["Date", "Received Date"] },
  { key: "amount", label: "Amount", required: true, type: "number", aliases: ["Amount", "Payment Amount", "Total"] },
  { key: "payment_method", label: "Payment Method", required: false, type: "select", options: ["cash", "bank_transfer", "credit_card", "check", "mpesa", "mobile_money", "other"], allowFallback: true, fallbackValue: "other", aliases: ["Method", "Payment Type", "Type"] },
  { key: "reference", label: "Reference", required: false, type: "text", aliases: ["Ref", "Reference Number", "Check No", "Cheque No"] },
  { key: "invoice_number", label: "Invoice Number", required: false, type: "text", aliases: ["Invoice #", "Inv #", "Invoice", "Applied To"] },
  { key: "notes", label: "Notes", required: false, type: "text", aliases: ["Memo", "Comments", "Description"] },
];
