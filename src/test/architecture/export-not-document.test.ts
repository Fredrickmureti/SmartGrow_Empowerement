/**
 * Data exports are not documents.
 *
 * A CSV/XLSX extract has no template, no paper geometry, no printer policy,
 * no disposition routing, and no physical device. It used to be dispatched
 * through `printClient.downloadExport(...)`, which put a pure data concern
 * inside the print pipeline and gave the print client a second, unrelated
 * reason to change.
 *
 * `@/services/exports` now owns extracts outright. This test keeps the two
 * pipelines from re-merging in either direction.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf-8");
}

describe("export / print separation", () => {
  it("the print client no longer exposes export methods", () => {
    const printClient = read("services/printing/PrintClient.ts");
    expect(printClient).not.toMatch(/async\s+exportDocument\s*\(/);
    expect(printClient).not.toMatch(/async\s+downloadExport\s*\(/);
  });

  it("the exports service never imports from the printing pipeline", () => {
    const dir = resolve(SRC, "services/exports");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const body = readFileSync(resolve(dir, file), "utf-8");
      expect(
        body,
        `${file} must not depend on the print pipeline`,
      ).not.toMatch(/from\s+["']@\/services\/printing\//);
      expect(body).not.toMatch(/from\s+["']@\/services\/hardware\//);
    }
  });

  it("statement pages take exports from the exports service", () => {
    for (const page of ["pages/CustomerStatements.tsx", "pages/VendorStatements.tsx"]) {
      const body = read(page);
      expect(body, `${page} should import the exports service`).toContain(
        'from "@/services/exports"',
      );
      expect(body, `${page} should not import the print client`).not.toMatch(
        /from\s+["']@\/services\/printing\/PrintClient["']/,
      );
      expect(body).not.toMatch(/printClient\./);
    }
  });
});
