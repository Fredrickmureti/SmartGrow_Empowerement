/**
 * Phase 3.8 architecture guard — Offline scan-replay idempotency.
 *
 * Pins:
 *   1. `wms_client_scan_receipts` exists with a UNIQUE (device_id,
 *      client_scan_id) index.
 *   2. The two mobile-facing wrappers (`wms_capture_receiving_line`,
 *      `wms_complete_pick_scan`) short-circuit on prior receipts and
 *      record a receipt at end.
 *   3. Both wrappers REVOKE from PUBLIC and GRANT EXECUTE to
 *      `authenticated, service_role`.
 *   4. `useOfflineScanQueue` is the only WMS module that stamps
 *      `client_scan_id` for these RPCs, and it uses
 *      `crypto.randomUUID()`.
 *
 * Source-level guard (no DB round-trip).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function migrationsContaining(needle: string): string {
  const dir = path.resolve(__dirname, "../../../supabase/migrations");
  let all = "";
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
    const src = readFileSync(p, "utf8");
    if (src.includes(needle)) all += "\n" + src;
  }
  return all;
}

describe("Phase 3.8 — offline scan replay idempotency", () => {
  it("wms_client_scan_receipts table exists with unique (device_id, client_scan_id) index", () => {
    const sql = migrationsContaining("wms_client_scan_receipts");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.wms_client_scan_receipts/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[\s\S]{0,120}?wms_client_scan_receipts[\s\S]{0,120}?\(\s*device_id\s*,\s*client_scan_id\s*\)/,
    );
  });

  it("wms_capture_receiving_line short-circuits on prior receipt and records receipt", () => {
    const sql = migrationsContaining("wms_capture_receiving_line");
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.wms_capture_receiving_line/);
    expect(sql).toMatch(/_wms_client_scan_lookup\(\s*p_device_id\s*,\s*p_client_scan_id\s*\)/);
    expect(sql).toMatch(/_wms_client_scan_record\(/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.wms_capture_receiving_line[\s\S]{0,200}?FROM PUBLIC/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.wms_capture_receiving_line[\s\S]{0,200}?TO authenticated, service_role/,
    );
  });

  it("wms_complete_pick_scan wraps complete_pick_task with replay guard", () => {
    const sql = migrationsContaining("wms_complete_pick_scan");
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.wms_complete_pick_scan/);
    expect(sql).toMatch(/_wms_client_scan_lookup\(/);
    expect(sql).toMatch(/public\.complete_pick_task\(\s*p_task_id\s*,\s*p_picked_qty/);
    expect(sql).toMatch(/_wms_client_scan_record\(/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.wms_complete_pick_scan[\s\S]{0,200}?FROM PUBLIC/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.wms_complete_pick_scan[\s\S]{0,200}?TO authenticated, service_role/,
    );
  });

  it("advisory lock serialises concurrent replays inside the lookup helper", () => {
    const sql = migrationsContaining("_wms_client_scan_lookup");
    expect(sql).toMatch(/pg_advisory_xact_lock\(/);
  });

  it("useOfflineScanQueue stamps client_scan_id via crypto.randomUUID and passes it to both RPCs", () => {
    const hookPath = path.resolve(
      __dirname,
      "../../features/warehouse/scanning/useOfflineScanQueue.ts",
    );
    const src = readFileSync(hookPath, "utf8");
    expect(src).toMatch(/crypto\.randomUUID\(\)/);
    expect(src).toMatch(/wms_capture_receiving_line/);
    expect(src).toMatch(/wms_complete_pick_scan/);
    expect(src).toMatch(/p_client_scan_id:\s*entry\.client_scan_id/);
    expect(src).toMatch(/p_device_id:\s*deviceId/);
  });
});
