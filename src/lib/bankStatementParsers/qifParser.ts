/**
 * QIF (Quicken Interchange Format) parser.
 * Text-based format with single-character line prefixes.
 * Self-describing — no column mapping needed.
 */
import type { ParsedStatement, ParsedBankTransaction } from "./index";
import { parseDate, parseAmount } from "./index";

export async function parseQIF(file: File): Promise<ParsedStatement> {
  const text = await file.text();
  const lines = text.split("\n").map(l => l.trim());

  const transactions: ParsedBankTransaction[] = [];
  let accountType = "";

  // Check header for account type
  if (lines[0]?.startsWith("!Type:")) {
    accountType = lines[0].substring(6).trim();
  }

  let current: {
    date?: string;
    amount?: number;
    payee?: string;
    memo?: string;
    category?: string;
    number?: string;
    cleared?: string;
  } = {};

  for (const line of lines) {
    if (!line || line.startsWith("!")) continue;

    const prefix = line[0];
    const value = line.substring(1).trim();

    switch (prefix) {
      case "D": // Date
        current.date = value;
        break;
      case "T": // Amount
      case "U": // Amount (alternative)
        current.amount = parseAmount(value);
        break;
      case "P": // Payee
        current.payee = value;
        break;
      case "M": // Memo
        current.memo = value;
        break;
      case "L": // Category
        current.category = value;
        break;
      case "N": // Check number / reference
        current.number = value;
        break;
      case "C": // Cleared status
        current.cleared = value;
        break;
      case "^": // End of record
        if (current.date && current.amount !== undefined) {
          const description = [current.payee, current.memo].filter(Boolean).join(" - ");
          const date = parseDate(current.date);

          if (date && description) {
            transactions.push({
              date,
              description,
              amount: Math.abs(current.amount),
              reference: current.number || "",
              type: current.amount >= 0 ? "credit" : "debit",
              rawData: {
                date: current.date || "",
                amount: String(current.amount),
                payee: current.payee || "",
                memo: current.memo || "",
                category: current.category || "",
                number: current.number || "",
                cleared: current.cleared || "",
              },
            });
          }
        }
        current = {};
        break;
    }
  }

  return {
    format: "qif",
    transactions,
    needsColumnMapping: false,
    metadata: {
      accountType: accountType || undefined,
    },
  };
}
