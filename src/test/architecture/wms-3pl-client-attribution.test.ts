/**
 * Architecture guard — 3PL client attribution (Phase 3).
 *
 * Billing is worthless without knowing *whose* goods moved. Two defects
 * made attribution impossible:
 *
 *  1. warehouse events carried no `client_id`, so every billable activity
 *     landed in the "no client" bucket the invoice generator filters out;
 *  2. `emit_yard_event` called a 9-argument `_wms_emit_outbox` overload
 *     that does not exist, and its `EXCEPTION WHEN OTHERS` swallowed the
 *     undefined_function error — so zero `warehouse.trailer.*` events ever
 *     reached the outbox and `yard_dwell` could never bill.
 *
 * These guards pin both fixes to the newest migration that defines the
 * emitters, and pin the client column onto the physical aggregates.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

function newestMigrationDefining(marker: string): string {
  const dir = path.join(ROOT, "supabase/migrations");
  const hits = readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .filter((n) => {
      const p = path.join(dir, n);
      return statSync(p).isFile() && readFileSync(p, "utf8").includes(marker);
    });
  expect(hits.length, `no migration defines ${marker}`).toBeGreaterThan(0);
  return readFileSync(path.join(dir, hits[hits.length - 1]), "utf8");
}

function typedColumns(table: string): string[] {
  const src = readFileSync(path.join(ROOT, "src/integrations/supabase/types.ts"), "utf8");
  const start = src.indexOf(`      ${table}: {\n        Row: {`);
  expect(start, `table ${table} not found in generated types`).toBeGreaterThan(-1);
  const rowStart = src.indexOf("Row: {", start) + "Row: {".length;
  const rowEnd = src.indexOf("\n        }", rowStart);
  return [...src.slice(rowStart, rowEnd).matchAll(/^\s{10}([a-z0-9_]+)\??:/gim)].map((m) => m[1]);
}

describe("3PL client attribution", () => {
  it("every warehouse event stamps the billing client", () => {
    const sql = newestMigrationDefining("FUNCTION public._wms_emit_event");
    expect(sql).toContain("_wms_resolve_client_id");
    expect(sql).toMatch(/'client_id',\s*_client/);
  });

  it("the client resolver walks plate then aggregate, not payload only", () => {
    const sql = newestMigrationDefining("FUNCTION public._wms_resolve_client_id");
    for (const table of [
      "wms_license_plates",
      "wms_receiving_sessions",
      "wms_loading_manifests",
      "wms_trailer_visits",
    ]) {
      expect(sql, `resolver ignores ${table}`).toContain(`public.${table}`);
    }
  });

  it("yard events publish through the real emitter and are not swallowed", () => {
    const sql = newestMigrationDefining("FUNCTION public.emit_yard_event");
    const body = sql.slice(sql.indexOf("FUNCTION public.emit_yard_event"));
    expect(body).toContain("_wms_emit_event(");
    expect(body).not.toContain("_wms_emit_outbox");
    // A blanket handler here is what hid the broken call for two releases.
    expect(body.slice(0, body.indexOf("$function$;") + 11)).not.toMatch(
      /EXCEPTION\s+WHEN\s+OTHERS/i,
    );
  });

  it("the physical aggregates carry a client column", () => {
    for (const table of [
      "wms_license_plates",
      "wms_receiving_sessions",
      "wms_loading_manifests",
      "wms_trailer_visits",
    ]) {
      expect(typedColumns(table), `${table} has no client_id`).toContain("client_id");
    }
  });

  it("capture prefers a client-specific tariff over the default rate", () => {
    const sql = newestMigrationDefining("FUNCTION public.capture_billable_activity");
    expect(sql).toMatch(/t\.client_id IS NULL OR t\.client_id = v_client/);
    expect(sql).toMatch(/ORDER BY \(t\.client_id IS NOT NULL\) DESC/);
  });
});
