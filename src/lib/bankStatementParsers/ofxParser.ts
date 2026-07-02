/**
 * OFX/QBO parser — parses Open Financial Exchange XML format.
 * OFX and QBO are structurally identical (QBO is Quicken's OFX variant).
 * Self-describing format — no column mapping needed.
 */
import type { ParsedStatement, ParsedBankTransaction } from "./index";
import { parseDate, parseAmount } from "./index";

/**
 * Extract value between OFX tags: <TAG>value
 * OFX uses SGML-like syntax without closing tags in most cases.
 */
function extractTag(text: string, tag: string): string {
  // Try self-closing pattern: <TAG>value\n or <TAG>value<
  const regex = new RegExp(`<${tag}>([^<\\n]+)`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * Split OFX content into individual transaction blocks.
 */
function extractTransactionBlocks(text: string): string[] {
  const blocks: string[] = [];
  const startTag = "<STMTTRN>";
  const endTag = "</STMTTRN>";

  let pos = 0;
  while (true) {
    const start = text.indexOf(startTag, pos);
    if (start === -1) break;
    const end = text.indexOf(endTag, start);
    if (end === -1) break;
    blocks.push(text.substring(start, end + endTag.length));
    pos = end + endTag.length;
  }

  return blocks;
}

export async function parseOFX(
  file: File,
  format: "ofx" | "qbo"
): Promise<ParsedStatement> {
  const text = await file.text();

  // Extract metadata
  const bankId = extractTag(text, "BANKID");
  const acctId = extractTag(text, "ACCTID");
  const acctType = extractTag(text, "ACCTTYPE");
  const currency = extractTag(text, "CURDEF");
  const balAmt = extractTag(text, "BALAMT");
  const dtStart = extractTag(text, "DTSTART");
  const dtEnd = extractTag(text, "DTEND");

  // Parse transactions
  const blocks = extractTransactionBlocks(text);
  const transactions: ParsedBankTransaction[] = [];

  for (const block of blocks) {
    const trnType = extractTag(block, "TRNTYPE"); // DEBIT, CREDIT, etc.
    const dtPosted = extractTag(block, "DTPOSTED"); // YYYYMMDD or YYYYMMDDHHMMSS
    const trnAmt = extractTag(block, "TRNAMT");
    const fitId = extractTag(block, "FITID");
    const name = extractTag(block, "NAME");
    const memo = extractTag(block, "MEMO");
    const checkNum = extractTag(block, "CHECKNUM");
    const refNum = extractTag(block, "REFNUM");

    const amount = parseAmount(trnAmt);
    const description = [name, memo].filter(Boolean).join(" - ");
    const reference = fitId || checkNum || refNum || "";
    const date = parseDate(dtPosted);

    if (date && description) {
      transactions.push({
        date,
        description,
        amount: Math.abs(amount),
        reference,
        type: amount >= 0 ? "credit" : "debit",
        rawData: {
          TRNTYPE: trnType,
          DTPOSTED: dtPosted,
          TRNAMT: trnAmt,
          FITID: fitId,
          NAME: name,
          MEMO: memo,
          CHECKNUM: checkNum,
          REFNUM: refNum,
        },
      });
    }
  }

  return {
    format,
    transactions,
    needsColumnMapping: false,
    metadata: {
      bankId: bankId || undefined,
      accountId: acctId || undefined,
      accountType: acctType || undefined,
      currency: currency || undefined,
      startDate: dtStart ? parseDate(dtStart) : undefined,
      endDate: dtEnd ? parseDate(dtEnd) : undefined,
      closingBalance: balAmt ? parseAmount(balAmt) : undefined,
    },
  };
}
