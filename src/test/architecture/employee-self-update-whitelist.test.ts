/**
 * Wave F5 — Self-update whitelist consistency.
 *
 * The DB trigger `enforce_employee_self_update_columns` is the
 * authoritative server-side guard (Wave E1). The frontend
 * `SELF_SERVICE_FIELDS` set in `EmployeeProfile.tsx` is a UX hint that
 * prunes the patch before sending; it MUST be a subset of the DB
 * whitelist or users will see opaque 42501 errors trying to update fields
 * the UI thinks are self-service.
 *
 * This test (a) asserts the trigger exists in some migration and
 * (b) asserts every entry in SELF_SERVICE_FIELDS appears in the trigger
 * definition's whitelist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

function readAllMigrations(): string {
  const dir = "supabase/migrations";
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n--FILE--\n");
}

describe("employee self-update whitelist parity", () => {
  const profileSrc = readFileSync("src/pages/hr/EmployeeProfile.tsx", "utf8");
  const migrations = readAllMigrations();

  it("DB trigger enforce_employee_self_update_columns is defined", () => {
    expect(migrations).toMatch(/enforce_employee_self_update_columns/);
  });

  it("every SELF_SERVICE_FIELDS entry is referenced in the trigger definition", () => {
    const setMatch = profileSrc.match(/SELF_SERVICE_FIELDS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
    expect(setMatch, "SELF_SERVICE_FIELDS literal not found in EmployeeProfile.tsx").toBeTruthy();
    const raw = setMatch![1];
    const fields = Array.from(raw.matchAll(/["']([a-z_]+)["']/g)).map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(0);

    // Pull the trigger body — everything from the function name up to the next $$ end marker.
    const fnMatch = migrations.match(
      /enforce_employee_self_update_columns[\s\S]*?\$\$;/,
    );
    expect(fnMatch, "trigger function body not found in migrations").toBeTruthy();
    const fnBody = fnMatch![0];

    const missing = fields.filter((f) => !new RegExp(`\\b${f}\\b`).test(fnBody));
    expect(
      missing,
      `Frontend whitelists fields the DB trigger will reject: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});