/**
 * ADR-0060: the `certificate_template_v2` JSON Schema is the contract
 * between the publisher editor and the runtime renderer. If the seed
 * migration drifts from the editor's section palette, or if
 * `data_source` ever grows a value other than `payroll_employee_ytd`,
 * this test screams — because any of those regressions would let a
 * publisher ship a certificate the renderer cannot draw.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function findSchemaSeed(): string {
  const dir = "supabase/migrations";
  const files = readdirSync(dir).sort();
  for (const f of files) {
    if (!f.endsWith(".sql")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    if (
      /pack_rule_type_schemas/.test(src) &&
      /'certificate_template'/.test(src) &&
      /'v2'/.test(src)
    ) {
      return src;
    }
  }
  throw new Error("certificate_template v2 schema seed migration not found");
}

describe("certificate-template-v2-schema", () => {
  const sql = findSchemaSeed();

  it("data_source enum is exactly ['payroll_employee_ytd']", () => {
    // Match "'data_source' ... enum: [..'payroll_employee_ytd'..]" section.
    const m = /jsonb_build_object\(\s*'type'\s*,\s*'string'\s*,\s*'enum'\s*,\s*jsonb_build_array\(\s*'([^']+)'\s*\)\s*\)/.exec(
      sql,
    );
    expect(m, "no data_source enum found").toBeTruthy();
    expect(m![1]).toBe("payroll_employee_ytd");
  });

  it("section-type enum matches the editor's SECTION_TYPES whitelist", () => {
    const editor = readFileSync(
      "src/features/localization/components/CertificateTemplateEditor.tsx",
      "utf8",
    );
    // Only look inside the SECTION_TYPES declaration — INCLUDE_OPTIONS
    // and other value:"…" objects (page orientation, etc.) live nearby
    // and would otherwise get picked up.
    const sectionsBlock = /SECTION_TYPES\s*=\s*\[([\s\S]*?)\n\]/.exec(editor);
    expect(sectionsBlock, "SECTION_TYPES block not found in editor").toBeTruthy();
    const editorTypes = Array.from(
      sectionsBlock![1].matchAll(/\{\s*value:\s*"([a-z_]+)"/g),
    ).map((m) => m[1]);
    expect(editorTypes.length).toBeGreaterThan(4);

    // Pull the section-type enum from the SQL (all string literals inside
    // the sections.items.properties.type enum jsonb_build_array).
    const enumBlock = /'enum'\s*,\s*jsonb_build_array\(\s*([^)]*'signature_block'[^)]*)\)/s.exec(
      sql,
    );
    expect(enumBlock, "signature_block enum block not found").toBeTruthy();
    const sqlTypes = Array.from(enumBlock![1].matchAll(/'([a-z_]+)'/g)).map(
      (m) => m[1],
    );

    for (const t of editorTypes) {
      expect(sqlTypes, `Editor exposes "${t}" — schema must list it too`).toContain(t);
    }
  });

  it("schema is registered as computation_kind v2", () => {
    expect(sql).toMatch(/'certificate_template'\s*,\s*\n?\s*'v2'/);
  });
});