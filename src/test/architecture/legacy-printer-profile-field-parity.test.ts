/**
 * Wave 9d Phase 5 — field-parity guard for `printer_profiles` retirement.
 *
 * Every column that exists on `public.printer_profiles` (per the
 * generated Supabase types) MUST have an entry in
 * `LEGACY_PRINTER_PROFILE_FIELD_MAP`. If a future migration adds a
 * column and this test starts failing, decide its new home BEFORE
 * Phase 6 drops the table.
 *
 * The mapping file itself must remain documentation-only — importing it
 * at runtime would keep the legacy schema alive in the bundle.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { LEGACY_PRINTER_PROFILE_FIELD_MAP } from "@/apps/platform/hardware/legacyPrinterProfileFieldMap";

const ROOT = resolve(__dirname, "../../..");
const TYPES = resolve(ROOT, "src/integrations/supabase/types.ts");

/** Extract the `Row: { ... }` field names of a table block from types.ts. */
function readTableRowColumns(table: string): string[] {
  const src = readFileSync(TYPES, "utf-8");
  const start = src.indexOf(`${table}: {`);
  if (start < 0) throw new Error(`table not found in types.ts: ${table}`);
  const rowIdx = src.indexOf("Row: {", start);
  if (rowIdx < 0) throw new Error(`Row block not found for ${table}`);
  const end = src.indexOf("}", rowIdx);
  const body = src.slice(rowIdx + "Row: {".length, end);
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l) => l.split(":")[0].trim())
    .filter(Boolean);
}

describe("Wave 9d Phase 5 — printer_profiles field parity", () => {
  it("every printer_profiles column has a documented new home", () => {
    const columns = readTableRowColumns("printer_profiles");
    const mapped = new Set(Object.keys(LEGACY_PRINTER_PROFILE_FIELD_MAP));
    const missing = columns.filter((c) => !mapped.has(c));
    expect(
      missing,
      `Unmapped printer_profiles columns — add them to LEGACY_PRINTER_PROFILE_FIELD_MAP: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("mapping file is not imported at runtime (documentation-only)", () => {
    // Anything under src/ except the file itself and this test.
    const out = (() => {
      try {
        return execSync(
          `rg -l --no-messages "legacyPrinterProfileFieldMap" src/`,
          { cwd: ROOT, encoding: "utf-8" },
        );
      } catch {
        return "";
      }
    })();
    const importers = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(
        (f) =>
          !f.endsWith("legacyPrinterProfileFieldMap.ts") &&
          !f.endsWith("legacy-printer-profile-field-parity.test.ts"),
      );
    expect(
      importers,
      `Mapping is documentation-only; remove runtime import(s): ${importers.join(", ")}`,
    ).toEqual([]);
  });
});
