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

    // Strip the `kind === "return"` branch so we only inspect code paths that
    // can execute when saving a certificate override.
    code = code.replace(
      /if\s*\(\s*kind\s*===\s*"return"\s*\)\s*\{[\s\S]*?\n\s*\}/g,
      "",
    );

    for (const k of FORBIDDEN) {
      expect(
        code.includes(k),
        `Certificate override mutation must not reference "${k}" — ` +
          `legal metadata is pack-owned per ADR-0060.`,
      ).toBe(false);
    }
  });
});
