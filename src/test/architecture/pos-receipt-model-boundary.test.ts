/**
 * POS receipt model boundary — Phase 3 (item 7) guardrail.
 *
 * `ReceiptDocumentModel` is the client UI/customer-display shape.
 * `DocumentData` (server) is the canonical print shape used by every
 * emitted receipt/PDF/ESC/POS byte stream. These two intentionally live
 * in parallel until the Phase-3 collapse ships (see the file docstring
 * on `src/lib/pos/receipt/ReceiptDocumentModel.ts`).
 *
 * This test locks in the invariant that keeps them from re-entangling:
 *   • Only POS UI surfaces and the customer-display renderer may import
 *     `ReceiptDocumentModel` / `buildReceiptDocument`.
 *   • No file under a print / PDF / ESC/POS / thermal pipeline may
 *     depend on it. Those paths must consume `DocumentData` only.
 *
 * If this test fails, the fix is almost never to add an allowlist entry —
 * it is to route the print/emit code through `DocumentData` instead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

/** Files that legitimately depend on the UI model. */
const ALLOWED = new Set<string>([
  "src/lib/pos/receipt/ReceiptDocumentModel.ts",
  "src/lib/pos/receipt/renderers/CustomerDisplayRenderer.ts",
  "src/components/pos/TransactionSummaryView.tsx",
  "src/components/pos/ReceiptPreviewBody.tsx",
  "src/apps/pos/terminal/receipt/PostPaymentSurface.tsx",
  "src/apps/pos/terminal/receipt/ReceiptWorkspace.tsx",
  "src/apps/pos/terminal/sale/ReceiptPreviewSheet.tsx",
  "src/apps/pos/terminal/history/HistoryWorkspace.tsx",
]);

/** Path fragments that identify the print / thermal / PDF / ESC/POS pipeline. */
const FORBIDDEN_FRAGMENTS = [
  "/services/printing/",
  "/lib/receipt/", // client mirror of the shared engine
  "/hooks/useDocumentPrint",
  "escpos",
  "thermal",
  "renderThermalPdf",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

describe("POS receipt model boundary", () => {
  const files = walk(SRC);

  it("only whitelisted UI surfaces import ReceiptDocumentModel / buildReceiptDocument", () => {
    const importers = files.filter((abs) => {
      const rel = relative(ROOT, abs).replaceAll("\\", "/");
      if (rel.startsWith("src/test/")) return false; // tests may import freely
      if (ALLOWED.has(rel)) return false;
      const src = readFileSync(abs, "utf8");
      return /from\s+["'][^"']*ReceiptDocumentModel["']/.test(src);
    });

    expect(
      importers.map((f) => relative(ROOT, f).replaceAll("\\", "/")),
      "Unexpected importer(s) of ReceiptDocumentModel — route through DocumentData instead",
    ).toEqual([]);
  });

  it("no print / PDF / ESC/POS / thermal file imports ReceiptDocumentModel", () => {
    const offenders = files.filter((abs) => {
      const rel = relative(ROOT, abs).replaceAll("\\", "/");
      if (rel.startsWith("src/test/")) return false;
      if (!FORBIDDEN_FRAGMENTS.some((frag) => rel.includes(frag))) return false;
      const src = readFileSync(abs, "utf8");
      return /ReceiptDocumentModel|buildReceiptDocument/.test(src);
    });

    expect(
      offenders.map((f) => relative(ROOT, f).replaceAll("\\", "/")),
      "Print/PDF/ESC-POS code must not depend on the UI model — consume DocumentData",
    ).toEqual([]);
  });
});
