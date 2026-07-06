/**
 * Architecture: every seeded bank export template must carry the ADR-0060
 * metadata surface — spec_reference (bank-file spec version), effective_date,
 * and a well-formed spec.columns array — so the linter's structural gate can
 * never be bypassed by a hand-written seed migration.
 *
 * Runs against migration files (source of truth) rather than live DB, so the
 * check is deterministic in CI.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const migrationsDir = path.join(process.cwd(), "supabase", "migrations");

function migrationFiles(): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => path.join(migrationsDir, f));
}

describe("Bank export template metadata gate", () => {
  it("ships a DB trigger enforcing spec_reference + effective_date", () => {
    const anyDefines = migrationFiles().some((f) => {
      const src = fs.readFileSync(f, "utf8");
      return /enforce_bank_export_template_meta/.test(src)
        && /trg_bank_export_template_meta/.test(src);
    });
    expect(anyDefines).toBe(true);
  });

  it("every INSERT into localization_pack_bank_export_templates lists spec_reference and effective_date", () => {
    const offenders: string[] = [];
    for (const f of migrationFiles()) {
      const src = fs.readFileSync(f, "utf8");
      const re = /INSERT\s+INTO\s+(?:public\.)?localization_pack_bank_export_templates\s*\(([^)]*)\)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const cols = m[1].toLowerCase();
        if (!cols.includes("spec_reference") || !cols.includes("effective_date")) {
          offenders.push(`${path.basename(f)}: INSERT missing spec_reference/effective_date columns`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
