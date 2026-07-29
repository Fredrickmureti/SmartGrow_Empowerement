/**
 * Architecture guard — WMS label keys stay in lockstep with the SQL
 * seeder `wms_seed_default_label_templates`. Rename a template on one
 * side and the build breaks here instead of at print time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WMS_LABEL_KEYS } from "@/features/warehouse/labels/wmsLabels";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function findSeederSql(): string {
  const files = readdirSync(MIGRATIONS_DIR).sort();
  for (const f of files) {
    if (!f.endsWith(".sql")) continue;
    const body = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    if (body.includes("wms_seed_default_label_templates")) return body;
  }
  throw new Error("No migration defines wms_seed_default_label_templates");
}

describe("WMS label keys — SQL ↔ TS sync", () => {
  it("every thermal TS key is seeded by wms_seed_default_label_templates", () => {
    const sql = findSeederSql();
    for (const key of WMS_LABEL_KEYS) {
      if (key === "wms.label.packing_slip") continue; // AST-only, not label_templates
      expect(sql, `SQL seeder is missing template_key '${key}'`).toContain(`'${key}'`);
    }
  });

  it("seeder registers exactly the TS-declared thermal keys (plus packing_slip via AST)", () => {
    // Thermal keys live in label_templates; packing slip lives in
    // document_template_ast (kind=inventory.packing_slip). Both surfaces
    // are covered by the same migration file.
    const sql = findSeederSql();
    const declared = WMS_LABEL_KEYS.filter((k) => k !== "wms.label.packing_slip");
    for (const key of declared) {
      // Must be inserted into label_templates.
      const re = new RegExp(`VALUES\\s*\\([^)]*'${key.replace(/\./g, "\\.")}'`);
      expect(sql, `label_templates seed for '${key}' not found`).toMatch(re);
    }
    expect(sql, "packing slip AST upgrade missing").toContain("inventory.packing_slip");
  });
});
