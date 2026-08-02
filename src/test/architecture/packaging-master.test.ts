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

  // Phase 4.5 — privilege drift guard. RLS is not the only line of defence:
  // the raw grants must not exist either, for anon or authenticated.
  it("leaves no write privilege on any packaging or SSCC table (defence in depth)", () => {
    const hardening = sql.match(
      /Phase 4\.5: revoke client write privileges[\s\S]*?END \$\$;/i,
    )?.[0];
    expect(hardening, "the Phase 4.5 hardening migration must be present").toBeTruthy();
    for (const table of [
      "wms_packaging_types",
      "wms_packaging_carriers",
      "wms_packaging_availability",
      "wms_packaging_events",
      "wms_sscc_registry",
      "wms_sscc_events",
      "wms_gs1_config",
    ]) {
      expect(hardening).toContain(`'${table}'`);
    }
    expect(hardening).toMatch(/REVOKE ALL ON public\.%I FROM anon/i);
    expect(hardening).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE[^']*ON public\.%I FROM authenticated/i,
    );
  });

  // Phase 4.5 — one pack path. Desktop and mobile must both cartonize through
  // the geometry-aware engine; neither may fall back to the legacy RPCs.
  it.each([
    "src/pages/warehouse/PackStation.tsx",
    "src/pages/warehouse-mobile/MobilePack.tsx",
  ])("%s packs through the Packaging Master engine", (rel) => {
    const src = fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
    expect(src).toMatch(/suggest_packaging|suggestPackaging/);
    expect(src).toMatch(/assign_packaging_to_pack|assignPackagingToPack/);
    expect(src).not.toMatch(/["']suggest_carton["']/);
    expect(src).not.toMatch(/["']assign_carton_to_pack["']/);
  });

  // The SSCC entity type is a Postgres enum — client literals must mirror it.
  it("uses only real wms_sscc_entity labels on the client", () => {
    const seam = fs.readFileSync(
      path.resolve(SRC_DIR, "features/warehouse/packaging/cartonSscc.ts"),
      "utf8",
    );
    expect(seam).toMatch(/export type SsccEntityType[^;]*"carton"/);
    for (const file of walk(SRC_DIR)) {
      if (file.includes(path.join("test", "architecture"))) continue;
      expect(fs.readFileSync(file, "utf8"), `${file} uses a non-existent SSCC entity label`)
        .not.toMatch(/["'](pack_carton|shipment)["']\s*(,|\)|\}|;)/);
    }
  });


  it("ships cartonization v2 with per-axis fit, fill cap and dim weight", () => {
    expect(sql).toMatch(/FUNCTION public\.suggest_packaging\(/i);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.suggest_packaging\([^)]*\) TO[^;]*authenticated/i,
    );
    // rotation-invariant per-axis fit, not volume-only
    expect(sql).toMatch(/FUNCTION public\.wms_packaging_fits_item\(/i);
    expect(sql).toMatch(/all_items_fit/);
    expect(sql).toMatch(/max_volume_fill_pct/);
    expect(sql).toMatch(/dim_weight_kg/);
    expect(sql).toMatch(/billable_per_unit_kg/);
    // never a silent NULL — every miss carries a reason
    for (const reason of [
      "missing_dimensions",
      "item_exceeds_all_packaging",
      "no_packaging_matches_constraints",
      "no_active_packaging",
    ]) {
      expect(sql).toContain(`'${reason}'`);
    }
  });

  it("owns GS1/SSCC-18 identity on the server", () => {
    expect(sql).toMatch(/CREATE TABLE[^;]*public\.wms_gs1_config/i);
    expect(sql).toMatch(/CREATE TABLE[^;]*public\.wms_sscc_registry/i);
    // check digit + 18-digit builder + validator
    expect(sql).toMatch(/FUNCTION public\.gs1_check_digit\(/i);
    expect(sql).toMatch(/FUNCTION public\.wms_sscc_build\(/i);
    expect(sql).toMatch(/FUNCTION public\.wms_sscc_is_valid\(/i);
    // serials are allocated, never recycled, and unique per business
    expect(sql).toMatch(/CONSTRAINT wms_sscc_registry_sscc_uniq\s+UNIQUE \(sscc\)/i);
    expect(sql).toMatch(/wms_sscc_registry_serial_uniq\s+UNIQUE \(business_id, serial_reference\)/i);
    expect(sql).toMatch(/idx_wms_sscc_registry_active_entity/i);
    expect(sql).toMatch(/GS1_SERIAL_EXHAUSTED/);
    expect(sql).toMatch(/WMS_GS1_NOT_CONFIGURED/);
  });

  it.each([
    "wms_gs1_config_upsert",
    "wms_sscc_allocate",
    "wms_sscc_void",
    "wms_sscc_label_payload",
  ])("installs the %s routine and grants it to authenticated", (fn) => {
    expect(sql).toMatch(new RegExp(`FUNCTION\\s+public\\.${fn}\\s*\\(`, "i"));
    expect(sql).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\)[\\s\\S]{0,40}?authenticated`, "i"),
    );
  });

  it("keeps GS1 tables read-only for clients", () => {
    for (const table of ["wms_gs1_config", "wms_sscc_registry"]) {
      expect(sql).toMatch(new RegExp(`GRANT SELECT\\s+ON public\\.${table} TO authenticated`, "i"));
      expect(sql).not.toMatch(
        new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON public\\.${table} TO authenticated`, "i"),
      );
    }
  });

  // ---------------------------------------------------------------- Phase 5
  // Handling units carry packaging identity (ADR 0105 §7) and a scanned
  // carton resolves back to its handling unit server-side (§8).

  it("gives license plates a packaging identity derived server-side", () => {
    expect(sql).toMatch(/ALTER TABLE[\s\S]{0,80}wms_license_plates[\s\S]{0,120}packaging_type_id/i);
    expect(sql).toMatch(/FUNCTION public\.wms_packaging_class_to_lpn_type\(/i);
    expect(sql).toMatch(/FUNCTION public\.wms_lpn_set_packaging\(/i);
    expect(sql).toMatch(/FUNCTION public\.wms_resolve_carton_scan\(/i);
  });

  it("routes plate packaging and carton scans through the sanctioned client seam", () => {
    const seam = fs.readFileSync(
      path.join(SRC_DIR, "features/warehouse/packaging/handlingUnitPackaging.ts"),
      "utf8",
    );
    // writes go through the replay ledger, reads through the resolver RPC
    expect(seam).toContain("replayGuardedCall(\"wms_lpn_set_packaging\"");
    expect(seam).toContain("wms_resolve_carton_scan");
    // no client-side SSCC parsing / plate mutation
    expect(seam).not.toMatch(/\.from\(\s*["']wms_license_plates["']\s*\)/);
  });

  it("registers wms_lpn_set_packaging in the replay dispatcher", () => {
    // The dispatcher branch is spliced into wms_replay_guarded_call by a DO
    // block, so pin the wrapper + the splice that installs the branch.
    expect(sql).toMatch(/FUNCTION public\._wms_replay_lpn_set_packaging\(/i);
    expect(sql).toMatch(/wms_lpn_set_packaging[\s\S]{0,400}wms_replay_guarded_call|wms_replay_guarded_call[\s\S]{0,600}wms_lpn_set_packaging/);
  });

  it("PackStation resolves pack.carton scans instead of parsing codes itself", () => {
    const page = fs.readFileSync(path.join(SRC_DIR, "pages/warehouse/PackStation.tsx"), "utf8");
    expect(page).toContain('intent: "pack.carton"');
    expect(page).toContain("resolveCartonScan");
  });

  it.each(["pages/warehouse/PackStation.tsx", "pages/warehouse-mobile/MobilePack.tsx"])(
    "%s reads packaging_type_id, never the legacy carton_type_id",
    (rel) => {
      const text = fs.readFileSync(path.join(SRC_DIR, rel), "utf8");
      expect(text).toContain("packaging_type_id");
      expect(text).not.toContain("carton_type_id");
    },
  );

  it("has no client-side write to the packaging master", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file.includes(path.join("integrations", "supabase"))) continue;
      if (file.includes(path.join("test", "architecture"))) continue;
      const text = fs.readFileSync(file, "utf8");
      const re =
        /from\(\s*["'](wms_packaging_types|wms_packaging_carriers|wms_packaging_availability|wms_packaging_events|wms_gs1_config|wms_sscc_registry)["']\s*\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/g;
      if (re.test(text)) offenders.push(path.relative(SRC_DIR, file));
    }
    expect(offenders).toEqual([]);
  });
});

