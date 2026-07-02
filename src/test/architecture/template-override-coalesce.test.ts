/**
 * Stage C — architecture guard for template override coalesce.
 *
 * Both generators MUST:
 *   1. Look up an override for (business_id, template_code) BEFORE falling
 *      back to the pack template.
 *   2. Reject generation when the override's snapshot of the pack template's
 *      updated_at no longer matches the live pack template (TEMPLATE_OUT_OF_DATE).
 *   3. Stamp the persisted payload with template_source / template_version /
 *      override_version so historical regenerations stay deterministic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = [
  "supabase/functions/generate-tax-certificate/index.ts",
  "supabase/functions/generate-statutory-return/index.ts",
];

describe("Stage C — template override coalesce", () => {
  for (const rel of FILES) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");

    describe(rel, () => {
      it("queries the override table", () => {
        const table = rel.includes("certificate")
          ? "payroll_certificate_template_overrides"
          : "payroll_return_template_overrides";
        expect(src).toContain(table);
      });

      it("emits TEMPLATE_OUT_OF_DATE when base updated_at drifted", () => {
        expect(src).toContain("TEMPLATE_OUT_OF_DATE");
        expect(src).toMatch(/base_template_updated_at/);
      });

      it("stamps payload with template_source + template_version + override_version", () => {
        expect(src).toMatch(/template_source:/);
        expect(src).toMatch(/template_version:/);
        expect(src).toMatch(/override_version:/);
      });
    });
  }
});
