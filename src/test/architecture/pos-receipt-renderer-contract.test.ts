/**
 * Stage X6 — POS receipt renderer contract guard.
 *
 * Locks two invariants that keep the post-payment lifecycle clean:
 *  1. Server-engine byte fetches (`generateDocumentEscPosBytes`,
 *     `generateDocumentPdf`) are only called from the dedicated renderer
 *     modules, not scattered across components / hooks. The legacy
 *     `ReceiptPreviewDialog` is exempt — it's the reprint-from-history
 *     surface and is being migrated incrementally.
 *  2. POSTerminal's success branch routes through PostPaymentSurface, not
 *     through inline `supabase.functions.invoke("generate-document", ...)`
 *     auto-print bytes.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  // unified printing utility module IS the helper itself
  "src/services/printing/pdfUtils.ts",
  // Step 5.0 — the shared receipt preview body owns pro-forma / reprint
  // ESC/POS fetches for POSReports and the sale.receiptPreview sheet.
  "src/components/pos/ReceiptPreviewBody.tsx",
  // documents/sales modules use generate-document for invoices/quotes —
  // their own contract tests cover them. Allow the helper everywhere
  // outside POS by scoping the scan to src/components/pos + src/pages/pos.
]);

describe("Stage X6 — POS receipt renderer contract", () => {
  it("on-screen renderer modules exist (CustomerDisplayRenderer + barrel)", () => {
    const present = readdirSync(RENDERER_DIR);
    expect(present).toContain("CustomerDisplayRenderer.ts");
    expect(present).toContain("index.ts");
  });

  it("Wave 4 — legacy HTML PreviewRenderer is retired in favour of MonospacePreview", () => {
    // The old Tailwind-based `PreviewRenderer` fragmented the pipeline:
    // the operator saw an HTML approximation while the printer / PDF
    // used a different engine. All POS previews now flow through the
    // unified `buildReceiptLines` + `MonospacePreview` chain.
    const present = readdirSync(RENDERER_DIR);
    expect(present).not.toContain("PreviewRenderer.tsx");
    expect(present).not.toContain("PreviewRenderer.ts");
  });

  it("Milestone B — legacy print renderer modules (ThermalPrintRenderer, PdfRenderer) are demoted and removed", () => {
    // Their responsibilities moved into `printClient.print()` and
    // `printClient.renderReceiptPdfBlob`. Recreating them would
    // fragment the print chokepoint again.
    const present = readdirSync(RENDERER_DIR);
    expect(present).not.toContain("ThermalPrintRenderer.ts");
    expect(present).not.toContain("PdfRenderer.ts");
  });

  it("POS paper preview consumes the server-rendered ESC/POS artifact", () => {
    // The human-readable summary may use ReceiptDocumentModel, but the view
    // labelled Receipt must show rows returned by the same server render that
    // creates printer bytes. Rebuilding from live settings caused production
    // preview/print drift.
    const src = readFileSync(
      join(root, "src", "apps", "pos", "terminal", "receipt", "PostPaymentSurface.tsx"),
      "utf8",
    );
    expect(src).toMatch(/ReceiptDocumentModel|buildReceiptDocument/);
    expect(src).toMatch(/renderDocumentPreview/);
    expect(src).toMatch(/preview_lines/);
    expect(src).toMatch(/MonospacePreview/);
    expect(src).not.toMatch(/\bbuildReceiptLines\s*\(/);
  });

  it("POSTerminal no longer inlines `generate-document` auto-print bytes in the success path", () => {
    const src = readFileSync(join(root, "src", "pages", "pos", "POSTerminal.tsx"), "utf8");
    expect(src).not.toMatch(/format:\s*"escpos"[\s\S]{0,200}printRawBytes/);
    expect(src).toMatch(/PostPaymentSurface/);
  });

  it("POS UI surfaces (excluding pdfUtils) do not call generateDocumentEscPosBytes directly", () => {
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

  it("PostPaymentSurface delegates print to PrintService (single chokepoint)", () => {
    const src = readFileSync(
      join(root, "src", "apps", "pos", "terminal", "receipt", "PostPaymentSurface.tsx"),
      "utf8",
    );
    // The `printClient` shim is gone: the terminal now enters the one
    // pipeline through `printDocument` / `renderDocumentBlob`, which
    // resolve a document record before any bytes are produced.
    expect(src).toMatch(/printDocument\s*\(/);
    expect(src).toMatch(/renderDocumentBlob\s*\(/);
    expect(src).not.toMatch(/printClient\./);
    expect(src).not.toMatch(/printReceiptThermal/);
    expect(src).not.toMatch(/printRawBytes,/);
    expect(src).toMatch(/showSuccessOnCustomerDisplay/);
    // Legacy renderer helpers must not resurface.
    expect(src).not.toMatch(/\bprintThermal\b/);
    expect(src).not.toMatch(/\brenderReceiptPdf\b/);
    expect(src).not.toMatch(/generateDocumentEscPosBytes/);
  });


  it("Stage X7 — generate-document forwards merged ExtendedReceiptSettings into the canonical ESC/POS emitter", () => {
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
    // The emitter call site must forward the merged object through the
    // canonical Line[]-AST renderer. The legacy builder is forbidden here.
    expect(src).toMatch(
      /renderDocumentEscPosWithResult\([\s\S]*?receiptSettings:/,
    );
    expect(src).not.toMatch(/\bbuildDocumentEscPos\s*\(/);
  });

  it("58mm production routing reads printer_profiles.paper_format and fails closed on an unsafe grid", () => {
    const src = readFileSync(
      join(root, "supabase", "functions", "generate-document", "index.ts"),
      "utf8",
    );
    expect(src).toMatch(/code128_native, paper_format, is_calibrated/);
    expect(src).not.toMatch(/code128_native, paper_size, is_calibrated/);
    expect(src).toMatch(/width === "58mm"[\s\S]{0,300}escposRows\.columns !== 32[\s\S]{0,200}escposRows\.font !== "A"/);
    expect(src).toMatch(/legacy POS status row reached production path/);
  });

  it("ADR-0085 — the legacy ESC/POS builder is deleted, not merely unused", () => {
    // `buildDocumentEscPos` was a second row producer for thermal receipts
    // whose item-context defaults had already drifted from the canonical
    // engine. It is gone; the only producer is `_shared/receipt/lines.ts`.
    expect(
      existsSync(join(root, "supabase/functions/_shared/escpos/builder.ts")),
      "legacy escpos/builder.ts must stay deleted",
    ).toBe(false);

    const offenders: string[] = [];
    for (const dir of [join(root, "supabase", "functions"), join(root, "src")]) {
      for (const file of walk(dir)) {
        const rel = relative(root, file).replace(/\\/g, "/");
        const src = readFileSync(file, "utf8");
        if (/\bbuildDocumentEscPos\s*\(/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("Phase A.3 — Receipt previews render through MonospacePreview, not ad-hoc flexbox columns", () => {
    const targets = [
      "src/components/settings/ReceiptLivePreview.tsx",
      // Step 5.2 retired `ReceiptPreviewDialog`; the shared body is now
      // the assertion target and covers every reprint surface.
      "src/components/pos/ReceiptPreviewBody.tsx",
      "src/apps/pos/terminal/receipt/PostPaymentSurface.tsx",
    ];
    for (const rel of targets) {
      const src = readFileSync(join(root, rel), "utf8");
      // Must use the shared monospace renderer.
      expect(src).toMatch(/MonospacePreview/);
      if (!rel.endsWith("PostPaymentSurface.tsx")) {
        expect(src).toMatch(/buildReceiptLines/);
      } else {
        expect(src).toMatch(/renderDocumentPreview/);
        expect(src).not.toMatch(/\bbuildReceiptLines\s*\(/);
      }
      // Must NOT reintroduce flexbox-based item rows or table-based layouts
      // for the receipt body. We scope the check to the items section by
      // looking for justify-between with QTY/PRICE/AMOUNT columns or any
      // <table>; both are bans we proved cause the misalignment.
      expect(src).not.toMatch(/<table\b/);
      expect(src).not.toMatch(/QTY[\s\S]{0,80}PRICE[\s\S]{0,80}AMOUNT/);
    }
  });
});