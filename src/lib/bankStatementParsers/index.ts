/**
 * Bank Statement Parser — Modular format detection and routing.
 * Supports CSV/Excel (via xlsx), OFX/QBO (XML-based), and QIF (text-based).
 */

import { parseCSVOrExcel } from "./csvParser";
import { parseOFX } from "./ofxParser";
import { parseQIF } from "./qifParser";

export interface ParsedBankTransaction {
  date: string;           // ISO date string YYYY-MM-DD
  description: string;
  amount: number;         // Signed: positive = credit, negative = debit
  reference: string;
  type: "credit" | "debit";
  balance?: number;       // Running balance if available
  rawData: Record<string, string>; // Original row data for audit
}

/**
 * A column of a CSV/Excel statement, addressed by a stable identifier.
 *
 * `key` is guaranteed non-empty and unique within a statement, so it is safe
 * to use as a Select option value. `label` is what the file called the column
 * (may be blank), `index` is its position in `rawRows`.
 */
export interface ParsedStatementColumn {
  key: string;
  label: string;
  index: number;
  sample: string;
}

export interface ParsedStatement {
  format: "csv" | "excel" | "ofx" | "qbo" | "qif";
  transactions: ParsedBankTransaction[];
  columns?: ParsedStatementColumn[]; // For CSV/Excel — mappable columns
  preamble?: string[][];    // For CSV/Excel — rows above the header row
  rawRows?: string[][];     // For CSV/Excel — raw data rows for mapping UI
  needsColumnMapping: boolean; // CSV/Excel need mapping; OFX/QIF are self-describing
  metadata?: {
    bankId?: string;
    accountId?: string;
    accountType?: string;
    currency?: string;
    startDate?: string;
    endDate?: string;
    openingBalance?: number;
    closingBalance?: number;
  };
}

/** Mapping values are `ParsedStatementColumn.key`, never raw header labels. */
export interface ColumnMapping {
  date: string;
  description: string;
  amount: string;
  reference: string;
  credit?: string;
  debit?: string;
  balance?: string;
}


/**
 * Detect file format from extension and content.
 */
export function detectFormat(file: File): "csv" | "excel" | "ofx" | "qbo" | "qif" | "unknown" {
  const name = file.name.toLowerCase();
  if (name.endsWith(".ofx")) return "ofx";
  if (name.endsWith(".qbo")) return "qbo";
  if (name.endsWith(".qif")) return "qif";
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "excel";
  if (name.endsWith(".csv") || name.endsWith(".txt")) return "csv";
  return "unknown";
}

/**
 * Parse a bank statement file. Returns structured data.
 * For CSV/Excel: returns headers + raw rows for column mapping UI.
 * For OFX/QIF: returns fully parsed transactions (self-describing formats).
 */
export async function parseStatementFile(file: File): Promise<ParsedStatement> {
  const format = detectFormat(file);

  switch (format) {
    case "csv":
    case "excel":
      return parseCSVOrExcel(file, format);

    case "ofx":
    case "qbo":
      return parseOFX(file, format);

    case "qif":
      return parseQIF(file);

    default:
      throw new Error(`Unsupported file format. Please use CSV, Excel (.xlsx), OFX, QBO, or QIF files.`);
  }
}

/**
 * Apply column mapping to raw CSV/Excel data and produce ParsedBankTransactions.
 */
export function applyColumnMapping(
  headers: string[],
  rawRows: string[][],
  mapping: ColumnMapping,
  bankAccountId: string
): ParsedBankTransaction[] {
  const dateIdx = headers.indexOf(mapping.date);
  const descIdx = headers.indexOf(mapping.description);
  const amountIdx = mapping.amount ? headers.indexOf(mapping.amount) : -1;
  const refIdx = mapping.reference ? headers.indexOf(mapping.reference) : -1;
  const creditIdx = mapping.credit ? headers.indexOf(mapping.credit) : -1;
  const debitIdx = mapping.debit ? headers.indexOf(mapping.debit) : -1;
  const balanceIdx = mapping.balance ? headers.indexOf(mapping.balance) : -1;

  return rawRows
    .filter(row => row.length >= Math.max(dateIdx, descIdx) + 1)
    .map(row => {
      let amount = 0;
      let type: "credit" | "debit" = "debit";

      if (amountIdx >= 0) {
        amount = parseAmount(row[amountIdx] || "0");
        type = amount >= 0 ? "credit" : "debit";
        amount = Math.abs(amount);
      } else {
        const credit = parseAmount(row[creditIdx] || "0");
        const debit = parseAmount(row[debitIdx] || "0");
        if (credit > 0) {
          amount = credit;
          type = "credit";
        } else {
          amount = Math.abs(debit);
          type = "debit";
        }
      }

      const dateStr = row[dateIdx] || "";
      const description = row[descIdx] || "";
      const reference = refIdx >= 0 ? row[refIdx] || "" : "";
      const balance = balanceIdx >= 0 ? parseAmount(row[balanceIdx] || "") : undefined;
      const parsedDate = parseDate(dateStr);

      // Build raw data map for audit trail
      const rawData: Record<string, string> = {};
      headers.forEach((h, i) => { rawData[h] = row[i] || ""; });

      return {
        date: parsedDate,
        description: description.trim(),
        amount,
        reference: reference.trim(),
        type,
        balance: balance && !isNaN(balance) ? balance : undefined,
        rawData,
      };
    })
    .filter(row => row.date && row.description && row.amount >= 0);
}

/**
 * Parse amount string, handling thousand separators and various formats.
 * Examples: "1,234.56" → 1234.56, "(500.00)" → -500, "1.234,56" → 1234.56
 */
export function parseAmount(str: string): number {
  if (!str || !str.trim()) return 0;
  let s = str.trim();

  // Handle parentheses as negative: (500.00) → -500.00
  const isNegative = s.startsWith("(") && s.endsWith(")");
  if (isNegative) s = s.slice(1, -1);

  // Detect European format: "1.234,56" (dot as thousand sep, comma as decimal)
  const commaPos = s.lastIndexOf(",");
  const dotPos = s.lastIndexOf(".");
  if (commaPos > dotPos && commaPos === s.length - 3) {
    // European: replace dots (thousands) and comma (decimal)
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Standard: remove commas (thousands)
    s = s.replace(/,/g, "");
  }

  // Remove currency symbols and whitespace
  s = s.replace(/[^0-9.\-]/g, "");

  const num = parseFloat(s);
  if (isNaN(num)) return 0;
  return isNegative ? -num : num;
}

/**
 * Parse date string across multiple formats.
 * Returns ISO date string YYYY-MM-DD or empty string on failure.
 */
export function parseDate(str: string): string {
  if (!str || !str.trim()) return "";
  const s = str.trim();

  // Try ISO format first: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  let match = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (match) {
    const [, a, b, year] = match;
    const day = parseInt(a);
    const month = parseInt(b);
    // If first number > 12, it must be day (DD/MM/YYYY)
    if (day > 12) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    // If second number > 12, it must be day (MM/DD/YYYY)
    if (month > 12) {
      return `${year}-${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}`;
    }
    // Ambiguous: assume DD/MM/YYYY (international standard)
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // MM/DD/YYYY short year: MM/DD/YY
  match = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (match) {
    const [, a, b, yr] = match;
    const year = parseInt(yr) + (parseInt(yr) > 50 ? 1900 : 2000);
    const day = parseInt(a) > 12 ? parseInt(a) : parseInt(b);
    const month = parseInt(a) > 12 ? parseInt(b) : parseInt(a);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // YYYYMMDD (OFX format)
  match = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  // Fallback: try native Date parsing
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];

  return "";
}

/**
 * Compute SHA-256 hash of file content for deduplication.
 */
export async function computeFileHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a deterministic transaction hash for row-level deduplication.
 */
/**
 * Generate a deterministic transaction hash for row-level deduplication.
 * Uses a stronger hash (FNV-1a 64-bit split into two 32-bit parts) for better collision resistance.
 */
export function generateTransactionHash(
  date: string,
  description: string,
  amount: number,
  reference: string,
  bankAccountId: string
): string {
  const raw = `${bankAccountId}|${date}|${description.trim()}|${amount.toFixed(2)}|${reference.trim()}`;
  // FNV-1a inspired double-pass for 64-bit equivalent entropy
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return `imp_${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}
