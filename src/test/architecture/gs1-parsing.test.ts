/**
 * Phase H architecture guard — GS1 barcode parsing.
 *
 * Enforces ADR 0071:
 *   - The parser is pure and imports only from `./aiTable`.
 *   - Capture surfaces (GRN wizard + lot/serial pickers) route scans
 *     through the GS1 interpreter rather than hand-parsing AIs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("Phase H — parser isolation", () => {
  const src = read("src/lib/gs1/parseGs1.ts");

  it("imports only from ./aiTable", () => {
    const importLines = src.match(/^import .*$/gm) ?? [];
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).toMatch(/from ["']\.\/aiTable["']/);
    }
  });

  it("exports parseGs1 and isGs1Payload", () => {
    expect(src).toMatch(/export function parseGs1\b/);
    expect(src).toMatch(/export function isGs1Payload\b/);
  });
});

describe("Phase H — AI table shape", () => {
  const src = read("src/lib/gs1/aiTable.ts");

  it("covers the core enterprise AIs", () => {
    for (const key of ["gtin", "lot", "serial", "expiry", "productionDate", "count", "netWeightKg"]) {
      expect(src).toMatch(new RegExp(`name:\\s*["']${key}["']`));
    }
  });

  it("exports FNC1 as ASCII 0x1D", () => {
    expect(src).toMatch(/FNC1\s*=\s*["']\\x1d["']/);
  });
});

describe("Phase H — scanner hook wraps the parser", () => {
  const src = read("src/lib/gs1/useGs1Scanner.ts");

  it("re-exports an interpretScan primitive", () => {
    expect(src).toMatch(/export function interpretScan\b/);
    expect(src).toMatch(/export function useGs1Scanner\b/);
  });

  it("delegates to parseGs1 rather than hand-parsing AIs", () => {
    expect(src).toMatch(/from ["']\.\/parseGs1["']/);
    // No inline AI grammar.
    expect(src).not.toMatch(/\\x1d/);
  });
});

describe("Phase H — capture surfaces route scans through the interpreter", () => {
  it("GRN wizard uses interpretScan on the scan input", () => {
    const src = read("src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx");
    expect(src).toMatch(/interpretScan|useGs1Scanner/);
    expect(src).toMatch(/from ["']@\/lib\/gs1\/useGs1Scanner["']/);
  });

  it("LotPickerPopover accepts a scanned lot / expiry seed", () => {
    const src = read("src/components/inventory/LotPickerPopover.tsx");
    expect(src).toMatch(/scannedLot\??:/);
    expect(src).toMatch(/scannedExpiry\??:/);
  });

  it("SerialPickerPopover accepts a scanned serial seed", () => {
    const src = read("src/components/inventory/SerialPickerPopover.tsx");
    expect(src).toMatch(/scannedSerial\??:/);
  });
});

describe("Phase H — ADR 0071 present", () => {
  it("ADR file exists", () => {
    const src = read("docs/adr/0071-gs1-scanner-parsing.md");
    expect(src).toMatch(/GS1/);
  });
});
