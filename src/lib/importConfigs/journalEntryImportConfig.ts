import { FieldDefinition } from "@/lib/importUtils";

/**
 * Canonical journal entry field definitions for CSV/XLSX import.
 * Used by the Journal Entries page import.
 *
 * DO NOT duplicate this. If you need journal entry import anywhere,
 * import from this file.
 */
export const JOURNAL_ENTRY_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "entry_date", label: "Date", required: true, type: "date", aliases: ["Date", "Entry Date", "Transaction Date", "journal date"] },
  { key: "reference", label: "Reference", required: false, type: "text", aliases: ["Ref", "Ref No", "Reference Number", "Entry Number", "Num"] },
  { key: "description", label: "Description", required: true, type: "text", aliases: ["Memo", "Narration", "Details", "Note"] },
  { key: "account_code", label: "Account Code", required: true, type: "text", aliases: ["Account", "Acct Code", "Account Number", "Account Name", "Acct"] },
  { key: "debit", label: "Debit", required: false, type: "number", aliases: ["Debit Amount", "Dr", "Debit (KES)"] },
  { key: "credit", label: "Credit", required: false, type: "number", aliases: ["Credit Amount", "Cr", "Credit (KES)"] },
];
