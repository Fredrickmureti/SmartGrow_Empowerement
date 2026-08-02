/**
 * Phase 3.9 architecture guard — unified offline scan-replay idempotency.
 *
 * Pins:
 *   1. `wms_client_scan_receipts` exists with a UNIQUE (device_id,
 *      client_scan_id) index and an advisory-locked lookup helper.
 *   2. `wms_replay_guarded_call` is the single server-side chokepoint: it
 *      short-circuits on a prior receipt, records a receipt, rejects
 *      non-whitelisted RPC names, and is granted to authenticated only.
 *   3. The live mobile queue (`src/apps/warehouse-mobile/offlineQueue.ts`)
 *      is the module that stamps `client_scan_id` via `crypto.randomUUID()`
 *      and routes every call through the dispatcher.
 *   4. Every `enqueue("<rpc>")` literal used by the mobile screens appears
 *      in the dispatcher whitelist — a new mobile RPC cannot ship without a
 *      replay decision.
 *   5. No second IndexedDB scan queue exists (the Phase 3.8 dead hook is
 *      gone and must not come back).
 *
 * Source-level guard (no DB round-trip).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const QUEUE_PATH = path.join(ROOT, "src/apps/warehouse-mobile/offlineQueue.ts");
const MOBILE_PAGES = path.join(ROOT, "src/pages/warehouse-mobile");

function migrationsContaining(needle: string): string {
  const dir = path.join(ROOT, "supabase/migrations");
  let all = "";
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
    const src = readFileSync(p, "utf8");
    if (src.includes(needle)) all += "\n" + src;
  }
  return all;
}

function dispatcherSql(): string {
  return migrationsContaining("wms_replay_guarded_call");
}

describe("Phase 3.9 — unified offline scan replay idempotency", () => {
  it("wms_client_scan_receipts table exists with unique (device_id, client_scan_id) index", () => {
    const sql = migrationsContaining("wms_client_scan_receipts");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.wms_client_scan_receipts/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[\s\S]{0,120}?wms_client_scan_receipts[\s\S]{0,120}?\(\s*device_id\s*,\s*client_scan_id\s*\)/,
    );
  });

  it("advisory lock serialises concurrent replays inside the lookup helper", () => {
    const sql = migrationsContaining("_wms_client_scan_lookup");
    expect(sql).toMatch(/pg_advisory_xact_lock\(/);
  });

  it("wms_replay_guarded_call short-circuits, records, and rejects unknown RPCs", () => {
    const sql = dispatcherSql();
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.wms_replay_guarded_call/);
    expect(sql).toMatch(/_wms_client_scan_lookup\(\s*p_device_id\s*,\s*p_client_scan_id\s*\)/);
    expect(sql).toMatch(/_wms_client_scan_record\(/);
    expect(sql).toMatch(/WMS_REPLAY_UNSUPPORTED_RPC/);
    // Whitelist must be a static CASE, never dynamic SQL.
    expect(sql).not.toMatch(/EXECUTE\s+format\(/);
  });

  it("wms_replay_guarded_call is revoked from PUBLIC and granted to authenticated", () => {
    const sql = dispatcherSql();
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.wms_replay_guarded_call[\s\S]{0,120}?FROM PUBLIC/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.wms_replay_guarded_call[\s\S]{0,120}?TO authenticated, service_role/,
    );
  });

  it("the live mobile queue stamps client_scan_id and calls the dispatcher", () => {
    const src = readFileSync(QUEUE_PATH, "utf8");
    expect(src).toMatch(/crypto\.randomUUID\(\)/);
    expect(src).toMatch(/wms_replay_guarded_call/);
    expect(src).toMatch(/p_client_scan_id:\s*row\.id/);
    expect(src).toMatch(/p_device_id:\s*row\.device_id/);
    // No bare RPC path may survive alongside the guarded dispatcher.
    expect(src).not.toMatch(/supabase\.rpc\s+as\s+any/);
  });

  it("every mobile enqueue() RPC is whitelisted in the dispatcher", () => {
    const sql = dispatcherSql();
    const used = new Set<string>();
    for (const name of readdirSync(MOBILE_PAGES)) {
      if (!name.endsWith(".tsx")) continue;
      const src = readFileSync(path.join(MOBILE_PAGES, name), "utf8");
      for (const m of src.matchAll(/enqueue(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) {
        used.add(m[1]);
      }
    }
    expect(used.size).toBeGreaterThan(5);
    const missing = [...used].filter((rpc) => !sql.includes(`WHEN '${rpc}' THEN`));
    expect(missing, `not replay-whitelisted: ${missing.join(", ")}`).toEqual([]);
  });

  it("no duplicate IndexedDB scan queue exists outside offlineQueue.ts", () => {
    expect(
      existsSync(path.join(ROOT, "src/features/warehouse/scanning/useOfflineScanQueue.ts")),
    ).toBe(false);
    const scanningDir = path.join(ROOT, "src/features/warehouse/scanning");
    for (const name of readdirSync(scanningDir)) {
      const src = readFileSync(path.join(scanningDir, name), "utf8");
      expect(src, `${name} must not open an IndexedDB scan store`).not.toMatch(/openDB\(/);
    }
  });
});

describe("Phase 5.1 — desktop replay safety", () => {
  const SEAM = path.join(ROOT, "src/features/warehouse/scanning/replayGuardedCall.ts");
  const DESKTOP_DIRS = [
    path.join(ROOT, "src/pages/warehouse"),
    path.join(ROOT, "src/features/warehouse/aggregates"),
  ];

  /** RPCs that mutate quantities or aggregate state and therefore must not be
   *  callable from a desktop screen outside the replay dispatcher. */
  const MUTATING_RPCS = [
    "record_count",
    "post_count_session",
    "open_pack_carton",
    "assign_line_to_carton",
    "seal_pack_carton",
    "complete_pack_task",
    "complete_pick_task",
    "complete_putaway_task",
    "create_pick_wave",
    "release_pick_wave",
    "load_carton_onto_manifest",
    "close_loading_manifest",
    "dispatch_loading_manifest",
    "accept_qc_inspection",
    "reject_qc_inspection",
    "cancel_qc_inspection",
    "receive_goods_to_wms",
  ];

  function desktopFiles(): Array<{ name: string; src: string }> {
    const out: Array<{ name: string; src: string }> = [];
    for (const dir of DESKTOP_DIRS) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!/\.(ts|tsx)$/.test(name)) continue;
        out.push({ name, src: readFileSync(path.join(dir, name), "utf8") });
      }
    }
    return out;
  }

  it("the desktop seam stamps a stable intent id and calls the dispatcher", () => {
    const src = readFileSync(SEAM, "utf8");
    expect(src).toMatch(/wms_replay_guarded_call/);
    expect(src).toMatch(/p_client_scan_id:\s*clientScanId/);
    expect(src).toMatch(/p_device_id:\s*deviceId\(\)/);
    // Intent identity, not a fresh uuid per call — otherwise a double-click
    // produces two ids and the ledger cannot dedupe it.
    expect(src).toMatch(/function intentId\(/);
    expect(src).toMatch(/INTENT_TTL_MS/);
  });

  it("device identity has exactly one definition", () => {
    const seam = readFileSync(SEAM, "utf8");
    expect(seam).toMatch(/wms_client_device_id/);
    const queue = readFileSync(QUEUE_PATH, "utf8");
    expect(queue).not.toMatch(/localStorage\.getItem\("wms_client_device_id"\)/);
    expect(queue).toMatch(/replayGuardedCall/);
  });

  it("no desktop warehouse module calls a mutating RPC outside the seam", () => {
    const offenders: string[] = [];
    for (const { name, src } of desktopFiles()) {
      for (const m of src.matchAll(/supabase\.rpc\(\s*"([a-z0-9_]+)"/g)) {
        if (MUTATING_RPCS.includes(m[1])) offenders.push(`${name}: ${m[1]}`);
      }
    }
    expect(offenders, `route through replayGuardedCall(): ${offenders.join(", ")}`).toEqual([]);
  });

  it("every RPC the desktop seam dispatches is whitelisted server-side", () => {
    const sql = dispatcherSql();
    const used = new Set<string>();
    for (const { src } of desktopFiles()) {
      for (const m of src.matchAll(/replayGuardedCall(?:<[^>]*>)?\(\s*\n?\s*"([a-z0-9_]+)"/g)) {
        used.add(m[1]);
      }
    }
    expect(used.size).toBeGreaterThan(8);
    const missing = [...used].filter((rpc) => !sql.includes(`WHEN '${rpc}' THEN`));
    expect(missing, `not replay-whitelisted: ${missing.join(", ")}`).toEqual([]);
  });
});
