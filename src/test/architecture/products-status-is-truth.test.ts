/**
 * `products.is_active` is a DERIVED column (a database trigger maintains it
 * from `products.status`). Filtering or branching on it in the app re-creates
 * a second, lagging version of product truth — exactly the drift this wave
 * removed. Read `status` instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe("products lifecycle is read from status, not is_active", () => {
  it("no file filters the products table on is_active", () => {
    const offenders: string[] = [];

    for (const file of walk(ROOT)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes('from("products")')) continue;

      // Look at each products query block and reject is_active filters in it.
      const blocks = src.split('from("products")').slice(1);
      for (const block of blocks) {
        const head = block.slice(0, 600);
        if (/\.eq\(\s*["']is_active["']/.test(head)) {
          offenders.push(file.replace(process.cwd() + "/", ""));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
