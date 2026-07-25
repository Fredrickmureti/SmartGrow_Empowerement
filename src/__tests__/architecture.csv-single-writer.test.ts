/**
 * Architecture guard — single-owner CSV writer.
 *
 * Only `src/lib/exports/csv.ts` may construct `text/csv` Blobs in the
 * client bundle. Every other module MUST route downloads through
 * `downloadCsv` / `csvBlob` from `@/lib/exports/csv`. This mirrors
 * ADR-0085's rendering-ownership pattern for CSV bytes.
 *
 * PrintClient is an allowed exemption: it uploads print artifacts to
 * the server-side print router, not a user-facing Excel download.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");
const ALLOWLIST = new Set([
  "lib/exports/csv.ts",
  // Print router transport — uploads to server, never surfaces to a
  // spreadsheet application. Bytes are pass-through, not authored.
  "services/printing/PrintClient.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("architecture: single CSV writer", () => {
  it("no client file constructs a text/csv Blob outside the canonical writer", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      // Detect any `new Blob(..., { type: "text/csv..." })` shape.
      if (/new\s+Blob\s*\([^)]*text\/csv/i.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
