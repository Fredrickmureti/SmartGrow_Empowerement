/**
 * Architecture guard — effectivity binding on pack editors.
 *
 * Every localization pack table that carries `effective_from` /
 * `effective_to` columns publishes time-scoped statutory rules. The
 * corresponding editor MUST expose both bounds; a UI that hides them
 * causes the publisher to silently ship "effective forever" rules,
 * which is a compliance defect (a Kenyan PAYE bracket that never
 * ends will over-tax employees when the next Finance Act lands).
 *
 * This test scans migration SQL for every `localization_pack_*` table
 * carrying an effective_from column, then asserts that a matching
 * editor component references BOTH column names. New pack tables that
 * add effectivity MUST also ship an editor that respects it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const MIGRATIONS = resolve(__dirname, "../../../supabase/migrations");
const COMPONENTS = resolve(__dirname, "../../features/localization/components");

/** Editors known to bind effectivity, keyed by table name. */
const EDITOR_MAP: Record<string, string[]> = {
  localization_pack_tax_templates: ["reference/TaxTemplatesEditor.tsx"],
  localization_pack_account_templates: ["reference/AccountTemplatesEditor.tsx"],
  localization_pack_remittance_schedules: ["reference/RemittanceSchedulesEditor.tsx"],
  localization_pack_return_templates: ["ReturnTemplateEditor.tsx", "TemplateEditor.tsx"],
  localization_pack_certificate_templates: ["TemplateEditor.tsx"],
  localization_pack_payroll_templates: ["TemplateEditor.tsx"],
  localization_pack_garnishment_kinds: ["GarnishmentsEditor.tsx"],
  localization_pack_garnishment_policies: ["GarnishmentsEditor.tsx"],
  localization_pack_bank_export_templates: ["BankExportTemplatesEditor.tsx"],
};

/** Concatenate every migration SQL — the effective schema. */
function allSql(): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  return files.map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n---\n");
}

/**
 * Extract pack tables that carry effective_from. Only matches column
 * declarations bound to the table's own CREATE TABLE or an ALTER TABLE
 * … ADD COLUMN statement within a short window (500 chars) — a broader
 * scan falsely attributes effective_from columns from unrelated tables
 * in the same migration file.
 */
function tablesWithEffectivity(sql: string): Set<string> {
  const hits = new Set<string>();
  // ALTER TABLE public.<table> ... ADD COLUMN ... effective_from within 500 chars
  for (const m of sql.matchAll(
    /ALTER\s+TABLE\s+public\.(localization_pack_\w+)[\s\S]{0,500}?ADD\s+COLUMN[\s\S]{0,200}?effective_from/gi,
  )) {
    hits.add(m[1]);
  }
  // CREATE TABLE public.<table> ( ... effective_from ... );
  for (const m of sql.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.(localization_pack_\w+)\s*\(([\s\S]*?)\)\s*;/gi,
  )) {
    if (/\beffective_from\b/i.test(m[2])) hits.add(m[1]);
  }
  return hits;
}

describe("localization editor — effectivity binding", () => {
  const sql = allSql();
  const tables = tablesWithEffectivity(sql);

  it("effectivity-bearing pack tables (if any) are all classified", () => {
    // Today no localization_pack_* table carries effective_from at the
    // template row itself — effectivity is expressed inside `parameters`
    // and enforced by `payroll_statutory_rules.effective_from` at
    // install time. This assertion locks that invariant: the first
    // pack table that grows an effective_from column MUST also gain
    // an editor entry in EDITOR_MAP, or this test fails loudly.
    for (const t of tables) {
      expect(
        EDITOR_MAP[t],
        `New effectivity-bearing pack table ${t} — add it to EDITOR_MAP.`,
      ).toBeTruthy();
    }
  });

  it("every effectivity-bearing pack table has a mapped editor", () => {
    for (const t of tables) {
      const editors = EDITOR_MAP[t];
      expect(
        editors,
        `Pack table ${t} carries effective_from/effective_to but is not mapped to any editor in localization-effectivity-binding.test.ts. Add it to EDITOR_MAP with the editor file(s) that bind both bounds.`,
      ).toBeTruthy();
    }
  });

  it("each mapped editor references both effective_from and effective_to", () => {
    for (const [table, editors] of Object.entries(EDITOR_MAP)) {
      if (!tables.has(table)) continue;
      for (const rel of editors) {
        const p = join(COMPONENTS, rel);
        if (!existsSync(p)) continue; // covered by editor-coverage guard
        const src = readFileSync(p, "utf8");
        expect(
          src.includes("effective_from"),
          `${rel} (editor for ${table}) does not reference effective_from — publisher would ship rules with no start date.`,
        ).toBe(true);
        expect(
          src.includes("effective_to"),
          `${rel} (editor for ${table}) does not reference effective_to — publisher would ship rules that never expire.`,
        ).toBe(true);
      }
    }
  });
});
