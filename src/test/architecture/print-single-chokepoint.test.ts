/**
 * Plan phase G · Guardrail G2 — `printClient.print()` is the single
 * entry-point for document printing.
 *
 * `generateDocumentPdf` / `generateDocumentEscPosBytes` (bytes producers)
 * and `printPdfInPage` (PDF transport) must only be composed inside the
 * printing service. `hardwareClient.printRawBytes` / `printLabelBytes`
 * (raw-hardware transport) must only be invoked from the printing service
 * or the hardware service that owns the transport itself. Anywhere else
 * indicates a page that has assembled its own private pipeline instead of
 * going through `printClient.print()` — the exact fragmentation Plan
 * phase C is collapsing.
 *
 * Allow-list carves out:
 *  - printing/hardware service internals (canonical owners),
 *  - the two `useDocumentPrint`/`usePrintOrPreview` legacy hooks that
 *    still delegate to the pipeline internals and are scheduled for
 *    removal in Plan phase C,
 *  - a small set of POS / reports / inventory hooks that fire raw bytes
 *    directly and are tracked separately by the hardware audit. Any NEW
 *    caller must be added to `PIPELINE_ALLOWED` intentionally — that PR
 *    review is the whole point of the guard.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");

/**
 * May reference `generateDocumentPdf`, `generateDocumentEscPosBytes`,
 * `printPdfInPage` — i.e. compose the PDF/bytes pipeline directly.
 */
const PIPELINE_ALLOWED = new Set<string>([
  // Canonical pipeline owners.
  "services/printing/PrintClient.ts",
  "services/printing/pdfUtils.ts",
  "services/printing/reprintClient.ts",
  "services/printing/previewSurface.ts",

  // Legacy hooks — Plan phase C deletes these.
  "hooks/useDocumentPrint.ts",
  "hooks/usePrintOrPreview.ts",

  // POS printer status probe (uses PDF path for A4 fallback).
  "hooks/pos/usePrinterStatus.ts",
  // POS receipt saga (event-driven; runs its own single-flight).
  "components/events/BusinessSagaMount.tsx",
  // POS terminal post-payment surface (deterministic, owns its own queue).
  "apps/pos/terminal/receipt/PostPaymentSurface.tsx",

  // Reports export/preview surfaces (batch export path).
  "services/reports/ReportExportService.ts",
  "components/reports/PrintPreviewDialog.tsx",
]);

/**
 * May call `hardwareClient.printRawBytes` / `hardwareClient.printLabelBytes`.
 * A narrower set than PIPELINE_ALLOWED — only files that legitimately drive
 * hardware directly (drivers, self-tests, label printer hook).
 */
const HARDWARE_ALLOWED = new Set<string>([
  "services/printing/PrintClient.ts",
  "services/printing/reprintClient.ts",
  "services/hardware/HardwareClient.ts",

  // Legacy / adjacent hardware surfaces.
  "hooks/hardware/useHardwareProxy.ts",
  "hooks/pos/useTestPrintReceipt.ts",
  "hooks/inventory/useInventoryLabelPrinter.ts",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".tanstack") continue;
    if (entry === "test" || entry === "__tests__") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("print single chokepoint · guard G2 (PrintClient owns the pipeline)", () => {
  it("only pipeline owners compose generateDocumentPdf / generateDocumentEscPosBytes / printPdfInPage", () => {
    const re = /\b(generateDocumentPdf|generateDocumentEscPosBytes|printPdfInPage)\s*\(/;
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      if (PIPELINE_ALLOWED.has(rel)) continue;
      const text = readFileSync(abs, "utf-8");
      if (re.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Files composing the PDF/bytes pipeline outside PIPELINE_ALLOWED:\n${offenders.join("\n")}\n\n` +
        `Call printClient.print({ documentType, documentId, intent }) instead.`,
    ).toEqual([]);
  });

  it("only hardware owners call hardwareClient.printRawBytes / printLabelBytes", () => {
    const re = /hardwareClient\s*\.\s*(printRawBytes|printLabelBytes)\s*\(/;
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      if (HARDWARE_ALLOWED.has(rel)) continue;
      const text = readFileSync(abs, "utf-8");
      if (re.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Files firing raw hardware bytes outside HARDWARE_ALLOWED:\n${offenders.join("\n")}\n\n` +
        `Route through printClient.print() (format: 'escpos' | 'zpl') instead.`,
    ).toEqual([]);
  });
});
