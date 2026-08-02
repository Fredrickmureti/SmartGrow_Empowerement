/**
 * ADR 0105 — Packaging Master architecture guard.
 *
 * Phase 2 scope: the server owns every write to the packaging master.
 * UI-level assertions (PackStation -> suggest_packaging, SSCC minting,
 * label routing) land with the later phases.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");
const SRC_DIR = path.resolve(process.cwd(), "src");

function readAllMigrations(): string {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("ADR 0105 — Packaging Master server-owned writes", () => {
  const sql = readAllMigrations();

  it("declares the packaging master schema", () => {
    expect(sql).toMatch(/CREATE TABLE[^;]*public\.wms_packaging_types/i);
    expect(sql).toMatch(/CREATE TABLE[^;]*public\.wms_packaging_carriers/i);
    expect(sql).toMatch(/CREATE TABLE[^;]*public\.wms_packaging_availability/i);
    expect(sql).toMatch(/CREATE TABLE[^;]*public\.wms_packaging_events/i);
  });

  it.each([
    "wms_packaging_upsert",
    "wms_packaging_set_lifecycle",
    "wms_packaging_archive",
    "wms_packaging_set_carrier_rule",
    "wms_packaging_set_availability",
  ])("installs the %s writer and grants it to authenticated", (fn) => {
    expect(sql).toMatch(new RegExp(`FUNCTION\\s+public\\.${fn}\\s*\\(`, "i"));
    expect(sql).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO[^;]*authenticated`, "i"),
    );
  });

  it("writes an audit row and emits an event on every master change", () => {
    expect(sql).toMatch(/FUNCTION public\._wms_packaging_log/i);
    expect(sql).toMatch(/FUNCTION public\.emit_packaging_event/i);
    expect(sql).toMatch(/warehouse\.packaging\.created/);
    expect(sql).toMatch(/warehouse\.packaging\.updated/);
    expect(sql).toMatch(/warehouse\.packaging\.lifecycle_changed/);
  });

  it("guards every writer with business access + inventory:write", () => {
    expect(sql).toMatch(/user_can_access_business\(auth\.uid\(\), p_business_id\)/);
    expect(sql).toMatch(/user_has_module_permission\(auth\.uid\(\), p_business_id, 'inventory', 'write'\)/);
  });

  it("revokes direct client writes on the master tables", () => {
    for (const table of [
      "wms_packaging_types",
      "wms_packaging_carriers",
      "wms_packaging_availability",
    ]) {
      expect(sql).toMatch(
        new RegExp(`REVOKE INSERT, UPDATE, DELETE ON public\\.${table} FROM authenticated`, "i"),
      );
    }
  });

  it("has no client-side write to the packaging master", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file.includes(path.join("integrations", "supabase"))) continue;
      if (file.includes(path.join("test", "architecture"))) continue;
      const text = fs.readFileSync(file, "utf8");
      const re =
        /from\(\s*["'](wms_packaging_types|wms_packaging_carriers|wms_packaging_availability|wms_packaging_events)["']\s*\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/g;
      if (re.test(text)) offenders.push(path.relative(SRC_DIR, file));
    }
    expect(offenders).toEqual([]);
  });
});
