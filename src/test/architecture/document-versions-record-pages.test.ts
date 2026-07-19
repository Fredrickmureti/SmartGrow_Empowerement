/**
 * Wave B3.5 — every full record page under Sales / Purchases must mount
 * `DocumentVersionsSection` so record pages and peek sheets show the
 * same immutable artifact history (ADR-0084).
 *
 * A record page that ships without the section would silently regress
 * the audit-trail UX for that document type; this guard catches it in
 * CI, mirroring the peek-sheet expectation set in Wave B3.4.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");
const RECORD_DIRS = [
  resolve(ROOT, "features/sales"),
  resolve(ROOT, "features/purchases"),
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/RecordPage\.tsx$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("Wave B3.5 — record pages mount DocumentVersionsSection", () => {
  it("every *RecordPage.tsx under Sales/Purchases imports DocumentVersionsSection", () => {
    const pages: string[] = [];
    for (const dir of RECORD_DIRS) walk(dir, pages);
    expect(pages.length, "expected to find at least one RecordPage.tsx").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const abs of pages) {
      const text = readFileSync(abs, "utf-8");
      if (!/DocumentVersionsSection/.test(text)) {
        offenders.push(relative(ROOT, abs).split("\\").join("/"));
      }
    }
    expect(
      offenders,
      `Record pages missing DocumentVersionsSection (Wave B3.5 parity):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});