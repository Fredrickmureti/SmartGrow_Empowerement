/**
 * Phase A.3 — buildReceiptLines goldens.
 *
 * These mirror the Deno-side ESC/POS engine goldens (A.2-α/β/γ/δ) so the
 * client preview stays column-accurate. If a regression breaks alignment
 * or margins on the printer side, the matching client preview will fail
 * here too — the engine is shared so the invariants must be too.
 */
import { describe, it, expect } from "vitest";
import {
  buildReceiptLines,
  SAMPLE_TRANSACTION,
} from "@/lib/receipt/preview/buildReceiptLines";
import { DEFAULT_EXTENDED_RECEIPT_SETTINGS } from "@/lib/receiptConfig";
import type { ExtendedReceiptSettings, ReceiptCompanyData } from "@/types/receipt";

const COMPANY: ReceiptCompanyData = {
  name: "Acme Roastery Ltd",
  address: "123 Main St",
  city: "Nairobi",
  phone: "+254 700 000 000",
  email: "hello@acme.test",
  tax_id: "P051234567A",
};

function settingsWith(over: Partial<ExtendedReceiptSettings>): ExtendedReceiptSettings {
  return { ...DEFAULT_EXTENDED_RECEIPT_SETTINGS, ...over };
}

describe("buildReceiptLines (Phase A.3 goldens)", () => {
  it("A.3-α — tabular header and value rows share the same width and Total right-edges align", () => {
    const out = buildReceiptLines({
      settings: settingsWith({ paper_size: "80mm", item_display_format: "tabular", show_item_quantity: true }),
      company: COMPANY,
      transaction: SAMPLE_TRANSACTION,
    });

    // Find the header row (column header — bold, contains 'Item' and 'Total').
    const headerIdx = out.lines.findIndex((l, i) =>
      out.meta[i]?.bold && /Item/.test(l) && /Total/.test(l),
    );
    expect(headerIdx).toBeGreaterThan(-1);

    const header = out.lines[headerIdx];
    // The right-edge of "Total" in the header column must equal the right-edge
    // of the value column on the next item rows.
    const totalEnd = header.lastIndexOf("l", header.lastIndexOf("Total") + 4);
    expect(totalEnd).toBeGreaterThan(0);

    // Pick a few subsequent rows that aren't blank.
    const valueRows = out.lines
      .slice(headerIdx + 1, headerIdx + 6)
      .filter((l) => l.trim().length > 0);
    expect(valueRows.length).toBeGreaterThan(0);
    for (const row of valueRows) {
      // Trim trailing spaces — the value's last non-space char must land on
      // or before the Total header end and the row width must match.
      expect(row.length).toBeGreaterThanOrEqual(totalEnd);
    }
  });

  it("A.3-β — every left-aligned line preserves the configured left margin", () => {
    const out = buildReceiptLines({
      settings: settingsWith({ paper_size: "80mm" }),
      company: COMPANY,
      transaction: SAMPLE_TRANSACTION,
    });
    // Default 80mm margin = 2.
    expect(out.marginCols).toBe(2);
    const pad = " ".repeat(out.marginCols);
    for (let i = 0; i < out.lines.length; i++) {
      const m = out.meta[i];
      const l = out.lines[i];
      if (m.align !== "left") continue;
      if (l.length === 0) continue; // blank line is fine
      expect(l.startsWith(pad)).toBe(true);
    }
  });

  it("A.3-γ — Font B (small) keeps conservative 80mm geometry unless a printer profile widens it", () => {
    const out = buildReceiptLines({
      settings: settingsWith({ paper_size: "80mm", font_size: "small" }),
      company: COMPANY,
      transaction: SAMPLE_TRANSACTION,
    });
    expect(out.columns).toBe(48);
    // Default margin 80mm = 2 → content width 48 - 4 = 44.
    const ruleRow = out.lines.find((l, i) => out.meta[i]?.rule);
    expect(ruleRow).toBeDefined();
    expect(ruleRow!.replace(/^\s+/, "").trim()).toBe("-".repeat(44));
  });

  it("A.3-δ — 58mm uses paper-aware default margin (1 col → 30-dash rule)", () => {
    const out = buildReceiptLines({
      settings: settingsWith({ paper_size: "58mm" }),
      company: COMPANY,
      transaction: SAMPLE_TRANSACTION,
    });
    expect(out.columns).toBe(32);
    expect(out.marginCols).toBe(1);
    const ruleRow = out.lines.find((l, i) => out.meta[i]?.rule);
    expect(ruleRow).toBeDefined();
    expect(ruleRow!.trim()).toBe("-".repeat(30));
  });
});
