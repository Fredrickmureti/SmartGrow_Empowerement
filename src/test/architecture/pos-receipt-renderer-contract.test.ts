/**
 * Stage X6 — POS receipt renderer contract guard.
 *
 * Locks two invariants that keep the post-payment lifecycle clean:
 *  1. Server-engine byte fetches (`generateDocumentEscPosBytes`,
 *     `generateDocumentPdf`) are only called from the dedicated renderer
 *     modules, not scattered across components / hooks. The legacy
 *     `ReceiptPreviewDialog` is exempt — it's the reprint-from-history
 *     surface and is being migrated incrementally.
 *  2. POSTerminal's success branch routes through PostPaymentScreen, not
 *     through inline `supabase.functions.invoke("generate-document", ...)`
 *     auto-print bytes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(__dirname, "..", "..", "..");

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

const RENDERER_DIR = join(root, "src", "lib", "pos", "receipt", "renderers");
const PDF_UTILS_PATH = join(root, "src", "services", "printing", "pdfUtils.ts");

// Components / hooks legitimately allowed to call the server engine
// directly (legacy + reprint-from-history). All NEW POS code MUST go
// through the renderer modules instead.
const ALLOWED_DIRECT_CALLERS = new Set([
  // legacy reprint-from-history dialog — migrated incrementally
  "src/components/pos/ReceiptPreviewDialog.tsx",
  // unified printing utility module IS the helper itself
  "src/services/printing/pdfUtils.ts",
  // documents/sales modules use generate-document for invoices/quotes —
  // their own contract tests cover them. Allow the helper everywhere
  // outside POS by scoping the scan to src/components/pos + src/pages/pos.
]);

describe("Stage X6 — POS receipt renderer contract", () => {
  it("renderer modules exist (PreviewRenderer, ThermalPrintRenderer, PdfRenderer, CustomerDisplayRenderer)", () => {
    const present = readdirSync(RENDERER_DIR);
    expect(present).toContain("PreviewRenderer.tsx");
    expect(present).toContain("ThermalPrintRenderer.ts");
    expect(present).toContain("PdfRenderer.ts");
    expect(present).toContain("CustomerDisplayRenderer.ts");
    expect(present).toContain("index.ts");
  });

  it("ReceiptDocumentModel builder is the single shape used by renderers", () => {
    const preview = readFileSync(join(RENDERER_DIR, "PreviewRenderer.tsx"), "utf8");
    const thermal = readFileSync(join(RENDERER_DIR, "ThermalPrintRenderer.ts"), "utf8");
    const pdf = readFileSync(join(RENDERER_DIR, "PdfRenderer.ts"), "utf8");
    expect(preview).toMatch(/ReceiptDocumentModel/);
    expect(thermal).toMatch(/ReceiptDocumentModel/);
    expect(pdf).toMatch(/ReceiptDocumentModel/);
  });

  it("POSTerminal no longer inlines `generate-document` auto-print bytes in the success path", () => {
    const src = readFileSync(join(root, "src", "pages", "pos", "POSTerminal.tsx"), "utf8");
    // The Stage W6 inline auto-print branch was: invoke("generate-document",
    // { body: { ...format: "escpos"... } }) immediately followed by
    // printRawBytes. Stage X3 routes that through PostPaymentScreen.
    expect(src).not.toMatch(/format:\s*"escpos"[\s\S]{0,200}printRawBytes/);
    // Sanity: PostPaymentScreen IS mounted.
    expect(src).toMatch(/PostPaymentScreen/);
  });

  it("POS UI surfaces (excluding ReceiptPreviewDialog and pdfUtils) do not call generateDocumentEscPosBytes directly", () => {
    const offenders: string[] = [];
    const candidates = [
      ...walk(join(root, "src", "components", "pos")),
      ...walk(join(root, "src", "pages", "pos")),
    ];
    for (const file of candidates) {
      const rel = relative(root, file).replace(/\\/g, "/");
      if (ALLOWED_DIRECT_CALLERS.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (/generateDocumentEscPosBytes\s*\(/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("PostPaymentScreen delegates print to the renderer modules (printThermal + renderReceiptPdf)", () => {
    const src = readFileSync(
      join(root, "src", "components", "pos", "PostPaymentScreen.tsx"),
      "utf8",
    );
    expect(src).toMatch(/printThermal/);
    expect(src).toMatch(/renderReceiptPdf/);
    expect(src).toMatch(/showSuccessOnCustomerDisplay/);
    // No direct server-engine import here.
    expect(src).not.toMatch(/generateDocumentEscPosBytes/);
  });

  it("Stage X7 — generate-document forwards merged ExtendedReceiptSettings into buildDocumentEscPos", () => {
    const src = readFileSync(
      join(root, "supabase", "functions", "generate-document", "index.ts"),
      "utf8",
    );
    // Snapshot path must read the frozen settings rows.
    expect(src).toMatch(/business_receipt_settings/);
    expect(src).toMatch(/register_receipt_settings/);
    // Live fallback must fetch them when no snapshot exists.
    expect(src).toMatch(/from\("businesses"\)[\s\S]{0,200}receipt_settings/);
    expect(src).toMatch(/from\("pos_settings"\)[\s\S]{0,200}receipt_settings/);
    // Merger from the shared module must be invoked.
    expect(src).toMatch(/mergeReceiptSettings/);
    // The builder call site must forward the merged object.
    expect(src).toMatch(/buildDocumentEscPos\([\s\S]*receiptSettings:/);
  });

  it("Stage X7 — buildDocumentEscPos consumes ExtendedReceiptSettings sections", () => {
    const src = readFileSync(
      join(root, "supabase", "functions", "_shared", "escpos", "builder.ts"),
      "utf8",
    );
    // Spot-check that key gating fields are referenced (not just the type).
    for (const field of [
      "item_display_format",
      "show_item_sku",
      "show_unit_price",
      "show_subtotal",
      "show_tax_breakdown",
      "show_payment_method",
      "show_amount_tendered",
      "show_change_due",
      "receipt_header",
      "receipt_footer",
      "show_etims_qr",
      "cashier_label_format",
    ]) {
      expect(src.includes(field)).toBe(true);
    }
  });

  it("Phase A.3 — Receipt previews render through MonospacePreview, not ad-hoc flexbox columns", () => {
    const targets = [
      "src/components/settings/ReceiptLivePreview.tsx",
      "src/components/pos/ReceiptPreviewDialog.tsx",
    ];
    for (const rel of targets) {
      const src = readFileSync(join(root, rel), "utf8");
      // Must use the shared monospace renderer.
      expect(src).toMatch(/MonospacePreview/);
      expect(src).toMatch(/buildReceiptLines/);
      // Must NOT reintroduce flexbox-based item rows or table-based layouts
      // for the receipt body. We scope the check to the items section by
      // looking for justify-between with QTY/PRICE/AMOUNT columns or any
      // <table>; both are bans we proved cause the misalignment.
      expect(src).not.toMatch(/<table\b/);
      expect(src).not.toMatch(/QTY[\s\S]{0,80}PRICE[\s\S]{0,80}AMOUNT/);
    }
  });
});