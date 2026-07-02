/**
 * Architecture guard — only `useNativeScanner` (the hook) and the
 * adapters themselves may import from `@/services/scanner/native/*`.
 * Anything else would create a second integration seam and let the
 * cockpit's dedupe / replay / telemetry pipeline drift apart.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

const ALLOW = new Set<string>([
  path.join(SRC, "hooks/scanner/useNativeScanner.ts"),
  // The adapters import each other / the bus internally.
  path.join(SRC, "services/scanner/native/dataWedgeAdapter.ts"),
  path.join(SRC, "services/scanner/native/honeywellAdapter.ts"),
  path.join(SRC, "services/scanner/native/swiftDecoderAdapter.ts"),
  path.join(SRC, "services/scanner/native/detectNativeScanner.ts"),
  path.join(SRC, "services/scanner/native/nativeScanBus.ts"),
  // Tests legitimately reach in.
  path.join(SRC, "test/scanner/detect-native-scanner.test.ts"),
  path.join(SRC, "test/scanner/data-wedge-adapter.test.ts"),
  path.join(SRC, "test/scanner/honeywell-adapter.test.ts"),
  path.join(SRC, "test/scanner/swift-decoder-adapter.test.ts"),
  path.join(SRC, "test/scanner/use-native-scanner.test.tsx"),
  path.join(SRC, "test/architecture/native-scanner-seam.test.ts"),
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const IMPORT_RE = /from\s+["']@\/services\/scanner\/native\/[^"']+["']/;

describe("native scanner seam discipline", () => {
  it("only useNativeScanner / adapters may import @/services/scanner/native/*", () => {
    const offenders: string[] = [];
    const files = walk(SRC).filter((f) => !ALLOW.has(f));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (IMPORT_RE.test(src)) {
        offenders.push(path.relative(process.cwd(), f));
      }
    }
    expect(
      offenders,
      `These files import the native-scanner internals directly. Route them through useNativeScanner instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
