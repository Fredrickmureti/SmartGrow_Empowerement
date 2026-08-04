/**
 * Printer *status* and print *dispatch* are separate concerns.
 *
 * These two lived in one file (`hooks/pos/usePrinterStatus.ts`), which
 * meant a hardware-reachability hook imported the print client, and a
 * document-dispatch hook was scoped to POS. Both halves were wrong:
 *
 *   - reachability is a platform hardware question every module asks;
 *   - dispatch is a printing-pipeline concern that merely *consults*
 *     reachability.
 *
 * This guard keeps them apart, and keeps the dependency pointing one way:
 * printing may ask hardware, hardware may never reach for printing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../..");

const STATUS = "hooks/hardware/usePrinterStatus.ts";
const DISPATCH = "hooks/printing/usePrintWithFallback.ts";

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf-8");
}

describe("printer status / print dispatch separation", () => {
  it("both owners exist at their canonical paths", () => {
    for (const rel of [STATUS, DISPATCH]) {
      expect(existsSync(resolve(SRC, rel)), `${rel} must exist`).toBe(true);
    }
  });

  it("the status hook never imports the print pipeline", () => {
    const body = read(STATUS);
    expect(
      body,
      "usePrinterStatus answers a hardware question; it must not dispatch documents",
    ).not.toMatch(/from\s+["']@\/services\/printing\/PrintClient["']/);
    expect(body).not.toMatch(/printClient\./);
    expect(body).not.toMatch(/generateDocumentPdf|printPdfInPage/);
    // Readiness comes from the single readiness service (registry +
    // workstation heartbeat), not from the local runtime probe.
    expect(body).toMatch(/from\s+["']@\/services\/hardware\/readiness["']/);
  });

  it("the dispatch hook reads reachability through the hardware hook", () => {
    const body = read(DISPATCH);
    expect(body).toContain('from "@/hooks/hardware/usePrinterStatus"');
    // It must not re-derive status by talking to the device layer itself.
    expect(
      body,
      "dispatch must consult printerStatusSnapshot(), not the device layer directly",
    ).not.toMatch(/hardwareClient\.devices/);
  });

  it("the status hook does not re-export the dispatch hook", () => {
    // Prose references are fine; a re-export would re-merge the concerns.
    const body = read(STATUS);
    expect(body).not.toMatch(/export\s*\{[^}]*usePrintWithFallback/);
    expect(body).not.toMatch(/export\s+function\s+usePrintWithFallback/);
  });
});
