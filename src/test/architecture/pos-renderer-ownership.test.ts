/**
 * Milestone B — POS renderer ownership guard.
 *
 * The legacy `ThermalPrintRenderer` / `PdfRenderer` client wrappers were
 * demoted into `printClient.printReceiptThermal` and
 * `printClient.renderReceiptPdfBlob`. This test locks the invariant that
 * no file outside `PrintClient.ts` itself may reintroduce imports of the
 * removed renderer paths — POS UI must go through `printClient`.
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

const BANNED_IMPORT_PATTERNS = [
  /from\s+["']@\/lib\/pos\/receipt\/renderers\/ThermalPrintRenderer["']/,
  /from\s+["']@\/lib\/pos\/receipt\/renderers\/PdfRenderer["']/,
  /from\s+["']\.\.?\/(?:[^"']+\/)?ThermalPrintRenderer["']/,
  /from\s+["']\.\.?\/(?:[^"']+\/)?PdfRenderer["']/,
];

// Symbols that used to live on the renderer barrel. Importing them from
// `@/lib/pos/receipt/renderers` today is impossible (they were removed),
// but we assert against the identifier too so a future contributor can't
// resurrect them under a different path.
const BANNED_SYMBOL_IMPORT = /import\s*\{[^}]*\b(?:printThermal|renderReceiptPdf)\b[^}]*\}\s*from\s+["']@\/lib\/pos\/receipt\/renderers["']/;

describe("Milestone B — POS renderer ownership", () => {
  it("no file imports the removed ThermalPrintRenderer / PdfRenderer modules", () => {
    const offenders: string[] = [];
    const roots = [
      join(root, "src", "components"),
      join(root, "src", "pages"),
      join(root, "src", "features"),
      join(root, "src", "hooks"),
      join(root, "src", "lib"),
    ];
    for (const r of roots) {
      let files: string[] = [];
      try {
        files = walk(r);
      } catch {
        continue;
      }
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        const rel = relative(root, file).replace(/\\/g, "/");
        if (BANNED_IMPORT_PATTERNS.some((p) => p.test(src)) || BANNED_SYMBOL_IMPORT.test(src)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("PrintClient owns the receipt helpers via the single chokepoint", () => {
    const src = readFileSync(
      join(root, "src", "services", "printing", "PrintClient.ts"),
      "utf8",
    );
    // Phase 5 Step B — `printReceiptThermal` (caller-supplied transport
    // callback) is deleted. Thermal receipts go through `print()` →
    // `dispatchThermalBytes` → `execAssignment` so the resolver, not the
    // caller, picks the device.
    expect(src).not.toMatch(/printReceiptThermal/);
    expect(src).toMatch(/dispatchThermalBytes\s*\(/);
    expect(src).toMatch(/renderReceiptPdfBlob\s*\(/);
  });

  it("renderer barrel exports only on-screen renderers", () => {
    const src = readFileSync(
      join(root, "src", "lib", "pos", "receipt", "renderers", "index.ts"),
      "utf8",
    );
    // After Wave 4 the HTML `PreviewRenderer` is gone; the barrel only
    // re-exports the customer-display renderer and the paper-width
    // type alias used by POS surfaces. Previews now flow through the
    // unified `MonospacePreview` from `@/lib/receipt/preview`.
    expect(src).toMatch(/CustomerDisplayRenderer|showSuccessOnCustomerDisplay/);
    expect(src).toMatch(/ReceiptPaperWidth/);
    expect(src).not.toMatch(/from\s+["']\.\/PreviewRenderer["']/);
    expect(src).not.toMatch(/from\s+["']\.\/ThermalPrintRenderer["']/);
    expect(src).not.toMatch(/from\s+["']\.\/PdfRenderer["']/);
    expect(src).not.toMatch(/export\s+\{[^}]*\bprintThermal\b/);
    expect(src).not.toMatch(/export\s+\{[^}]*\brenderReceiptPdf\b/);
  });
});
