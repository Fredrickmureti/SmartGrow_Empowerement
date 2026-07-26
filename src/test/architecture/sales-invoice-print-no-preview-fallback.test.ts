/**
 * Regression guard — Sales invoice Print must not silently fall back to the
 * preview dialog. Product Labels queue every rapid click onto the raw hardware
 * path; Sales invoice Print must do the same via PrintClient instead of using
 * the preview-fallback hook, whose failure path opens preview.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INVOICES = resolve(__dirname, "../../pages/Invoices.tsx");
const SRC = readFileSync(INVOICES, "utf-8");

describe("Sales invoice print path", () => {
  it("does not import or use the preview-fallback print hook", () => {
    expect(SRC).not.toContain("usePrintOrPreview");
    expect(SRC).not.toMatch(/generateDocument\s*\(/);
  });

  it("routes primary invoice print through PrintClient.print", () => {
    expect(SRC).toContain('from "@/services/printing/PrintClient"');
    expect(SRC).toMatch(/const\s+handlePrintInvoice\s*=\s*async/);
    expect(SRC).toMatch(/printClient\.print\s*\(\s*\{/);
    expect(SRC).toMatch(/documentType:\s*"invoice"/);
    expect(SRC).toMatch(/idempotencyKey:\s*clickIdempotencyKey/);
  });

  it("does not open PrintPreviewDialog from the primary invoice print handler", () => {
    const handler = SRC.match(/const\s+handlePrintInvoice\s*=\s*async[\s\S]*?^\s*};/m)?.[0] ?? "";
    expect(handler).not.toContain("openDocumentPreview");
    expect(handler).not.toContain("setPrintPreviewOpen(true)");
    expect(handler).not.toContain("setPrintPreviewOpen( true )");
  });
});