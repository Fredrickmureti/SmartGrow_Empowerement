/**
 * Architecture guard — ONE camera decode engine.
 *
 * Barcode decoding from a camera is the kind of code that quietly gets
 * copy-pasted: every screen that wants "scan to add" grows its own
 * `getUserMedia` + `BarcodeDetector` + ZXing ladder, each with slightly
 * different dedupe, teardown and torch handling. That is how a phone ends
 * up with two live MediaStreams, or a camera that keeps running after a
 * dialog closes.
 *
 * `src/services/scanner/camera/useCameraDecoder.ts` is the only module
 * allowed to own that ladder. Everything else composes it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/** Owns the engine. */
const ENGINE = "src/services/scanner/camera/useCameraDecoder.ts";

/**
 * Documented exceptions.
 * - `deviceMode.ts` only feature-detects a camera, it never opens one.
 * - `DeviceModeChoice.tsx` likewise feature-detects before offering the mode.
 * - `captureSelfie.ts` is attendance photo capture, not barcode decoding.
 * - `MobileScannerPage.tsx` is the companion-phone cockpit: a device-side
 *   pipeline with ROI cropping, zoom ramp and vendor SDK bridges that
 *   predates the shared engine. Tracked for consolidation; it must not grow
 *   new copies elsewhere in the meantime.
 */
const EXEMPT = new Set([
  "src/services/scanner/camera/deviceMode.ts",
  "src/components/scanner/DeviceModeChoice.tsx",
  "src/lib/attendance/captureSelfie.ts",
  "src/pages/pos/MobileScannerPage.tsx",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC).map((full) => ({
  rel: full.slice(process.cwd().length + 1).replace(/\\/g, "/"),
  body: readFileSync(full, "utf8"),
}));

/** Strips comments so prose about BarcodeDetector is not a violation. */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("scanner: one camera engine", () => {
  it("only useCameraDecoder opens a camera stream", () => {
    const offenders = files
      .filter((f) => f.rel !== ENGINE && !EXEMPT.has(f.rel) && !f.rel.startsWith("src/test/"))
      .filter((f) => /getUserMedia/.test(code(f.body)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("only useCameraDecoder touches BarcodeDetector or ZXing", () => {
    const offenders = files
      .filter((f) => f.rel !== ENGINE && !EXEMPT.has(f.rel) && !f.rel.startsWith("src/test/"))
      .filter((f) => /BarcodeDetector|@zxing\//.test(code(f.body)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the handheld viewfinder is mounted exactly once, in the app shell", () => {
    const mounts = files.filter(
      (f) =>
        f.rel !== "src/components/scanner/LocalScanOverlay.tsx" &&
        !f.rel.startsWith("src/test/") &&
        /<LocalScanOverlay/.test(code(f.body)),
    );
    expect(mounts.map((f) => f.rel)).toEqual(["src/components/auth/AuthenticatedShell.tsx"]);
  });

  it("scan surfaces reach the camera through ScanCameraButton / useLocalScan", () => {
    // openLocalScan is the service seam; UI must not call it ad hoc.
    const offenders = files
      .filter(
        (f) =>
          !f.rel.startsWith("src/services/scanner/camera/") &&
          f.rel !== "src/hooks/scanner/useLocalScan.ts" &&
          !f.rel.startsWith("src/test/"),
      )
      .filter((f) => /openLocalScan\s*\(/.test(code(f.body)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
