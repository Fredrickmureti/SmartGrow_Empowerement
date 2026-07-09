/**
 * Architecture guard — the Inventory app is mounted at `/inventory-app/*`
 * (see `src/App.tsx`). The legacy `/inventory/...` prefix has no matching
 * route and produces a 404 on navigation.
 *
 * Regression: after posting a Physical Count the workspace redirected to
 * `/inventory/physical-counts/<uuid>` which 404-ed even though the count
 * detail route exists. This test locks the URL contract so the two
 * prefixes cannot drift again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const SCAN_DIRS = [
  join(process.cwd(), "src", "pages", "inventory"),
  join(process.cwd(), "src", "apps", "inventory"),
  join(process.cwd(), "src", "components"),
];

// Match string/template literals starting with `/inventory/` but NOT
// `/inventory-app/`. Covers "…", '…', and `…` literals.
const OFFENDER = /["'`]\/inventory\/(?!app\/)/;

describe("Inventory URL prefix contract", () => {
  it("no source file links to the legacy /inventory/... prefix", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(dir)) {
        const src = readFileSync(file, "utf8");
        const lines = src.split("\n");
        lines.forEach((line, i) => {
          if (OFFENDER.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        });
      }
    }
    expect(
      offenders,
      `Inventory app is mounted at /inventory-app/*. Use that prefix.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
