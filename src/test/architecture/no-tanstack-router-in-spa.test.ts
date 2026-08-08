/**
 * Architecture guard: the application tree under src/ (outside src/routes and
 * src/router.tsx) is rendered by the legacy react-router-dom SPA mounted from
 * src/App.tsx. There is no TanStack router context there, so any TanStack
 * router hook — including the one behind <Link> — dereferences null and
 * crashes the screen with "Cannot read properties of null (reading 'isServer')".
 *
 * Regression origin: ProductAccountSelector imported Link from
 * @tanstack/react-router, which crashed /inventory-app/products/new as soon as
 * the account selectors rendered.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const SRC = resolve(__dirname, "../..");

/** Only these paths run inside the TanStack router. */
const ALLOWED = [
  /^routes\//,
  /^router\.tsx$/,
  /^routeTree\.gen\.ts$/,
  /^main\.tsx$/,
  /^test\/architecture\/no-tanstack-router-in-spa\.test\.ts$/,
];

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

describe("TanStack router imports stay inside src/routes", () => {
  it("no SPA-tree module imports @tanstack/react-router", () => {
    const offenders = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((rel) => !ALLOWED.some((re) => re.test(rel)))
      .filter((rel) => readFileSync(join(SRC, rel), "utf8").includes("@tanstack/react-router"));

    expect(offenders).toEqual([]);
  });
});
