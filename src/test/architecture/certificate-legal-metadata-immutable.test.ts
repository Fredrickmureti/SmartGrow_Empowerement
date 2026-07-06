/**
 * ADR-0060 invariant (parity with return templates): legal metadata on
 * certificate templates is pack-owned. Tenant-level override mutations on
 * `payroll_certificate_template_overrides` MUST NOT forward any legal-basis
 * column. Allowing tenants to alter these fields would let a business
 * misrepresent the statutory basis of an issued certificate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FORBIDDEN = [
  "legal_reference",
  "regulation_citation",
  "effective_date",
  "sunset_date",
  "authority_id",
  "revision_notes",
  "submission_channel",
  "approval_required",
];

describe("certificate-legal-metadata-immutable", () => {
  it("override-save hook does not forward any legal-metadata field", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/hooks/payroll/useTemplateOverrides.ts"),
      "utf8",
    );
    let code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    // Strip the `kind === "return"` branch so only certificate-reachable
    // writes remain.
    code = code.replace(
      /if\s*\(\s*kind\s*===\s*"return"\s*\)\s*\{[\s\S]*?\n\s{0,6}\}/g,
      "",
    );

    // Only care about actual writes to the upsert row, not the shared input
    // TypeScript type declaration.
    const writes = code
      .split("\n")
      .filter((l) => /\brow[\.\[]/.test(l))
      .join("\n");

    for (const k of FORBIDDEN) {
      expect(
        writes.includes(k),
        `Certificate override upsert must not write "${k}" — ` +
          `legal metadata is pack-owned per ADR-0060.`,
      ).toBe(false);
    }
  });
});
