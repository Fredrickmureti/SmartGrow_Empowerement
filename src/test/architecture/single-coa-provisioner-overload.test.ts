import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard — R1 of the COA re-audit.
 *
 * Two overloads of `provision_default_chart_of_accounts` is the failure
 * mode that re-opened the NHIF/SHIF/PAYE leak: the safe `text` overload
 * filters statutory rows; the legacy `varchar` overload does not. After
 * the R1 migration only the `text` overload may exist.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

describe("provision_default_chart_of_accounts has exactly one overload", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("no migration creates a varchar / character varying overload", () => {
    const violations: string[] = [];

    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const createMatches = sql.match(
        /create\s+(or\s+replace\s+)?function\s+[\w.]*provision_default_chart_of_accounts\s*\([^)]*\)/gi,
      );
      if (!createMatches) continue;

      for (const sig of createMatches) {
        const sigLower = sig.toLowerCase();
        const usesVarchar =
          /character\s+varying/.test(sigLower) || /\bvarchar\b/.test(sigLower);
        if (usesVarchar) {
          // The original 2026-01-21 migration introduced it; the R1
          // migration explicitly drops that overload.
          if (file === "20260121114629_1cbef1fe-4829-49e4-9d60-33196d60106f.sql") {
            continue;
          }
          violations.push(
            `${file}: re-introduces varchar overload of provision_default_chart_of_accounts`,
          );
        }
      }
    }

    expect(
      violations,
      `Detected forbidden overload re-introduction:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("the R1 drop of the varchar overload remains in migration history", () => {
    const found = files.some((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return /drop\s+function[^;]*provision_default_chart_of_accounts[^;]*character\s+varying/i.test(
        sql,
      );
    });
    expect(
      found,
      "The R1 DROP FUNCTION ... (uuid, uuid, character varying) is missing from migration history. " +
        "Without it, the dangerous overload re-appears on every fresh DB rebuild.",
    ).toBe(true);
  });
});
