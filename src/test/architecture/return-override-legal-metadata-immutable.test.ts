/**
 * Slice-C invariant: legal metadata on return templates is pack-owned.
 *
 * `payroll_return_template_overrides` MUST NOT carry columns for
 * legal_reference / regulation_citation / effective_date / sunset_date /
 * authority_id / digital_signature_spec / acknowledgement_spec /
 * api_endpoint_spec / approval_required.
 *
 * The override-save mutation also MUST NOT write any of those keys.
 * Allowing tenants to alter legal metadata would let a business
 * misrepresent the filing's legal basis and break ADR-0036 audit posture.
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
  "digital_signature_spec",
  "acknowledgement_spec",
  "api_endpoint_spec",
  "approval_required",
];

describe("return-override-legal-metadata-immutable", () => {
  it("override-save hook does not forward any legal-metadata field", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/hooks/payroll/useTemplateOverrides.ts"),
      "utf8",
    );
    // Strip comments so we only fail on real code references.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const k of FORBIDDEN) {
      expect(
        code.includes(k),
        `Override mutation must not reference legal-metadata column "${k}". ` +
          `Legal metadata is pack-owned per Slice-C / ADR-0036.`,
      ).toBe(false);
    }
  });
});
