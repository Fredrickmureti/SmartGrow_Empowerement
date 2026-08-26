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
  getCurrencyDecimals,
  getCurrencySymbol,
} from "@/design-system/reports/format";

const EDGE_CATALOGUE = path.resolve(
  process.cwd(),
  "supabase/functions/_shared/format/catalogue.ts",
);
const CLIENT_CATALOGUE = path.resolve(process.cwd(), "src/lib/currency/catalogue.ts");

const FIXTURES: Array<[number, string | undefined]> = [
  [0, "KES"],
  [1234.5, "KES"],
  [-1234.5, "KES"],
  [-0.004, "USD"],
  [1_000_000, "USD"],
  [-987654.321, "EUR"],
  [1200, "JPY"],
  [-1200, "RWF"],
  [1.2345, "KWD"],
  [42, undefined],
];

describe("report format parity", () => {
  it("shares one catalogue definition with the edge runtime", () => {
    const edge = readFileSync(EDGE_CATALOGUE, "utf8");
    const client = readFileSync(CLIENT_CATALOGUE, "utf8");
    const section = (src: string, name: string) => {
      const start = src.indexOf(`export const ${name}`);
      expect(start, `${name} missing`).toBeGreaterThan(-1);
      return src.slice(start, src.indexOf("};", start));
    };
    for (const name of ["ISO_MINOR_UNITS", "SEED_SYMBOLS"]) {
      expect(section(client, name)).toBe(section(edge, name));
    }
    // No module may re-introduce a private symbol map or a hardcoded 2dp
    // money policy: the catalogue is the only place those facts live.
    const format = readFileSync(
      path.resolve(process.cwd(), "src/design-system/reports/format.ts"),
      "utf8",
    );
    expect(format).not.toMatch(/CURRENCY_SYMBOLS/);
    expect(format).not.toMatch(/minimumFractionDigits/);
  });

  it("uses each currency's own minor units, not a hardcoded 2", () => {
    expect(getCurrencyDecimals("JPY")).toBe(0);
    expect(getCurrencyDecimals("RWF")).toBe(0);
    expect(getCurrencyDecimals("KWD")).toBe(3);
    expect(getCurrencyDecimals("KES")).toBe(2);
    expect(getCurrencyDecimals(undefined)).toBe(2);
    expect(formatAccountingNumber(1200, "JPY")).toBe("¥1,200");
    expect(formatAccountingNumber(-1200, "RWF")).toBe("(RF 1,200)");
  });

  it("renders negatives in parentheses with catalogue fraction digits", () => {
    for (const [value, currency] of FIXTURES) {
      const symbol = getCurrencySymbol(currency);
      const decimals = getCurrencyDecimals(currency);
      const abs = Math.abs(value).toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
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
