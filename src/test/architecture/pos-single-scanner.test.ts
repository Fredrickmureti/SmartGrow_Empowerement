/**
 * Architecture guard: the central scanner kernel (`useScanCapture` mounted
 * once in `AuthenticatedShell` + `scanBus`/`scanRouter`/`<BarcodeInputField>`)
 * is the ONLY source of scan events repo-wide.
 *
 * No source file may import the deprecated `useBarcodeScanner` hook. The
 * `parseBarcodePayload` utility is allowed via the named import — it's a
 * pure helper, not a listener.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC_ROOT = path.resolve(__dirname, "../..");

// Skip these — the hook file itself, its unit test, and this guard.
const ALLOW = new Set([
  path.join(SRC_ROOT, "hooks/pos/useBarcodeScanner.ts"),
  path.join(SRC_ROOT, "hooks/pos/__tests__/barcodeScanner.test.ts"),
  path.join(SRC_ROOT, "test/architecture/pos-single-scanner.test.ts"),
  path.join(SRC_ROOT, "hooks/pos/index.ts"),
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

describe("scanner kernel is the single source of scan events (repo-wide)", () => {
  const files = walk(SRC_ROOT).filter((f) => !ALLOW.has(f));

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no source file imports the deprecated useBarcodeScanner hook", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Allow named imports of `parseBarcodePayload` (utility); forbid the
      // hook itself.
      if (/\buseBarcodeScanner\b/.test(src)) {
        offenders.push(path.relative(process.cwd(), f));
      }
    }
    expect(
      offenders,
      `These files still use the legacy scanner hook:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
