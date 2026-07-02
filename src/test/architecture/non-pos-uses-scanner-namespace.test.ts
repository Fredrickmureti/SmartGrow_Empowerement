/**
 * Architecture guard — Plan P5.
 *
 * Non-POS modules MUST consume the scanner kernel via the canonical
 * `@/services/scanner` barrel, never the legacy `@/services/pos/scan*`
 * modules. POS-internal code (the terminal cart, POS hooks, the POS
 * page tree, scanner kernel internals themselves, and the test tree)
 * are exempt because they ARE the POS module and the scanner
 * implementation.
 *
 * Locks the namespace boundary that prevents Sales / Inventory /
 * Purchases from re-coupling to POS-shaped internals.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC_ROOT = path.resolve(__dirname, "../..");

const EXEMPT_PREFIXES = [
  path.join(SRC_ROOT, "services/pos"),
  path.join(SRC_ROOT, "services/scanner"),
  path.join(SRC_ROOT, "hooks/pos"),
  path.join(SRC_ROOT, "hooks/scanner"),
  path.join(SRC_ROOT, "pages/pos"),
  path.join(SRC_ROOT, "components/pos"),
  path.join(SRC_ROOT, "test"),
  path.join(SRC_ROOT, "apps/pos"),
  path.join(SRC_ROOT, "contexts/POSCartContext.tsx"),
];

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

describe("non-POS modules use the canonical @/services/scanner namespace", () => {
  const files = walk(SRC_ROOT).filter(
    (f) => !EXEMPT_PREFIXES.some((p) => f.startsWith(p)),
  );

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no non-POS file imports from @/services/pos/scan*", () => {
    const offenders: string[] = [];
    const re = /from\s+["']@\/services\/pos\/scan[A-Za-z]+["']/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (re.test(src)) offenders.push(path.relative(process.cwd(), f));
    }
    expect(
      offenders,
      `These non-POS files still import from @/services/pos/scan*. Switch to @/services/scanner:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
