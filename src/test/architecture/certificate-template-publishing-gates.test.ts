import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR 0060 — publisher gates for certificate templates.
 *
 * Three invariants must hold, together, or the platform quietly slides
 * back into "publisher can ship a broken statutory template":
 *
 *   1. A JSON Schema for `certificate_template_v2` must be seeded so
 *      the DB trigger can validate future writes.
 *   2. The publish edge function must fail publish when a certificate
 *      template is missing legal metadata / is legacy_unvalidated.
 *   3. The publish snapshot must include `pack_rule_type_schemas` so
 *      pack versions carry the schema catalogue that graded them.
 */
describe("certificate template publishing gates (ADR 0060)", () => {
  it("registers a certificate_template_v2 JSON Schema in migrations", () => {
    const dir = "supabase/migrations";
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const found = files.some((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return (
        /pack_rule_type_schemas/.test(sql) &&
        /certificate_template/.test(sql) &&
        /'v2'/.test(sql)
      );
    });
    expect(found).toBe(true);
  });

  it("publish edge function lints certificate legal metadata", () => {
    const src = readFileSync(
      "supabase/functions/publish-localization-pack-version/index.ts",
      "utf8",
    );
    expect(src).toMatch(/localization_pack_certificate_templates/);
    expect(src).toMatch(/missing statutory authority/);
    expect(src).toMatch(/missing legal reference/);
    expect(src).toMatch(/legacy pre-v2 body/);
  });

  it("publish snapshot includes pack_rule_type_schemas", () => {
    const src = readFileSync(
      "supabase/functions/publish-localization-pack-version/index.ts",
      "utf8",
    );
    expect(src).toMatch(/SNAPSHOT_GLOBAL_TABLES[\s\S]*pack_rule_type_schemas/);
  });

  it("attaches a validator trigger to certificate templates", () => {
    const dir = "supabase/migrations";
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const found = files.some((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return /trg_assert_certificate_template_body_valid[\s\S]*localization_pack_certificate_templates/i.test(
        sql,
      );
    });
    expect(found).toBe(true);
  });
});
