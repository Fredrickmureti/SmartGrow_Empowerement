/**
 * Audit Wave 10 (P0 #6 / P1 #8) — `PrintService` is dead.
 *
 * The legacy `printService` singleton has been replaced by:
 *   - `printClient` (`@/services/printing/PrintClient`) — the single
 *     chokepoint for every print path (PDF, ESC/POS, ZPL).
 *   - `usePrinterStatus` (`@/hooks/pos/usePrinterStatus`) — UI-facing
 *     hook backed by `hardwareClient.devices.getStatuses()` with
 *     polling and "fallback dialog" plumbing.
 *   - Shared types in `@/services/printing/types`.
 *
 * This guard fails CI if anything outside this file imports the old
 * shim path again. The same regex covers the singleton import and
 * any `.checkPrinterStatus`/`.smartPrint` re-introduction.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".tanstack") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("PrintService shim is retired (Wave 10)", () => {
  it("no source file references `@/services/printing/PrintService`", () => {
    const re = /services\/printing\/PrintService(?!\/?\.test|\b\.ts|Client)/;
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      if (rel === "test/architecture/no-printservice-shim.test.ts") continue;
      const text = readFileSync(abs, "utf-8");
      if (/from\s+["']@\/services\/printing\/PrintService["']/.test(text)) {
        offenders.push(rel);
      }
      // Catch raw `printService.` calls (singleton method access) too.
      if (/\bprintService\.(checkPrinterStatus|smartPrint|onPrinterStatusChange|startPrinterMonitoring|stopPrinterMonitoring|isElectron|getPrinters|printToPDF|silentPrint|browserPrint)\b/.test(text)) {
        offenders.push(`${rel} (singleton method call)`);
      }
      void re;
    }
    expect(
      offenders,
      `Files still using the deleted PrintService shim:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the shim file itself no longer exists", () => {
    expect(existsSync(resolve(ROOT, "services/printing/PrintService.ts"))).toBe(false);
  });
});
