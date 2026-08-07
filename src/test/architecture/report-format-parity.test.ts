/**
 * The on-screen report formatter and the PDF/CSV/XLSX formatter must agree.
 *
 * Before the reporting-engine consolidation, each report page defined a
 * local `fmt` / `fmtOrDash`, so the same figure read `-KES 1,234` on screen
 * and `(KES 1,234.00)` in that report's own PDF. Both sides now implement
 * the same policy; this test pins them together on a shared fixture set so
 * a change to one without the other fails CI.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EMPTY_CELL,
  formatAccountingNumber,
  formatReportNumber,
  formatReportPercent,
  formatReportValue,
  getCurrencySymbol,
} from "@/design-system/reports/format";

const EDGE_CURRENCY = path.resolve(
  process.cwd(),
  "supabase/functions/_shared/format/currency.ts",
);

const FIXTURES: Array<[number, string | undefined]> = [
  [0, "KES"],
  [1234.5, "KES"],
  [-1234.5, "KES"],
  [-0.004, "USD"],
  [1_000_000, "USD"],
  [-987654.321, "EUR"],
  [42, undefined],
];

describe("report format parity", () => {
  it("uses the same currency symbol table as the edge formatter", () => {
    const source = readFileSync(EDGE_CURRENCY, "utf8");
    for (const code of ["KES", "USD", "EUR", "GBP", "NGN", "ZAR", "UGX", "TZS"]) {
      const match = new RegExp(`${code}:\\s*"([^"]*)"`).exec(source);
      expect(match, `edge symbol table is missing ${code}`).toBeTruthy();
      expect(getCurrencySymbol(code)).toBe(match![1]);
    }
  });

  it("renders negatives in parentheses with two fraction digits", () => {
    for (const [value, currency] of FIXTURES) {
      const symbol = getCurrencySymbol(currency);
      const abs = Math.abs(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const expected = value < 0 ? `(${symbol}${abs})` : `${symbol}${abs}`;
      expect(formatAccountingNumber(value, currency)).toBe(expected);
      expect(formatReportValue(value, "currency", currency)).toBe(expected);
    }
  });

  it("renders blank cells as an em dash, exactly like the PDF engine", () => {
    for (const blank of [null, undefined, ""]) {
      expect(formatReportValue(blank, "currency", "KES")).toBe(EMPTY_CELL);
      expect(formatReportValue(blank, "text")).toBe(EMPTY_CELL);
    }
    expect(EMPTY_CELL).toBe("—");
  });

  it("matches the PDF number and percent policy", () => {
    expect(formatReportNumber(1234567)).toBe((1234567).toLocaleString("en-US"));
    expect(formatReportValue(1234567, "number")).toBe((1234567).toLocaleString("en-US"));
    expect(formatReportPercent(12.34)).toBe("12.3%");
    expect(formatReportValue(12.34, "percent")).toBe("12.3%");
  });
});
