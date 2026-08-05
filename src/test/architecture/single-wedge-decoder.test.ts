/**
 * Architecture guard — ONE keyboard-wedge decoder.
 *
 * `useScanCapture` is the only module allowed to decode rapid keystroke
 * bursts into barcodes. A second capture-phase keydown decoder anywhere
 * else double-decodes, fights over `preventDefault()`, and bypasses
 * `scanRouter` precedence, cross-source dedupe and scan telemetry.
 *
 * See ADR 0107 and the warehouse scanning consolidation pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");

/** The single sanctioned wedge decoder + the deprecated hook it replaced. */
const ALLOWED = [
  "src/hooks/pos/useScanCapture.ts",
  "src/hooks/pos/useBarcodeScanner.ts", // @deprecated, import-guarded separately
];

/** Signals that a keydown listener is decoding a barcode burst, not a hotkey. */
const DECODER_SIGNALS = [
  /minLength/,
  /maxGapMs/,
  /buffer\s*\+=/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("single keyboard-wedge decoder", () => {
  it("no module outside useScanCapture decodes keystroke bursts", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = file.slice(file.indexOf("src"));
      if (ALLOWED.includes(rel.split("\\").join("/"))) continue;
      const src = readFileSync(file, "utf8");
      if (!/addEventListener\(\s*['"]keydown/.test(src)) continue;
      const hits = DECODER_SIGNALS.filter((rx) => rx.test(src));
      if (hits.length >= 2) offenders.push(rel);
    }
    expect(offenders, `Wedge decoding must live only in useScanCapture. Offenders:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("KeyboardScannerDriver is a scanBus bridge, not a decoder", () => {
    const src = readFileSync(join(ROOT, "services/hardware/drivers/KeyboardScannerDriver.ts"), "utf8");
    expect(src).not.toMatch(/addEventListener\(\s*['"]keydown/);
    expect(src).toMatch(/scanBus\.on\(/);
  });

  it("HidScannerDriver publishes onto the canonical scanBus", () => {
    const src = readFileSync(join(ROOT, "services/hardware/drivers/HidScannerDriver.ts"), "utf8");
    expect(src).toMatch(/scanBus\.emit\(/);
    expect(src).toMatch(/source:\s*['"]hardware['"]/);
  });
});