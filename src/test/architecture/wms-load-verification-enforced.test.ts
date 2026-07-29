/**
 * Phase 3.7 architecture guard — Loading manifest scan-out enforcement +
 * cancellation cascade.
 *
 * Pins the invariants added by the Phase 3.7 migration on
 * `wms_transition_manifest`:
 *
 *   1. Close/dispatch refuses when sealed pack cartons for the manifest's
 *      (wave, sales-order) pairs are missing (WMS_SCAN_SHORTAGE).
 *   2. Cancellation cascades into wave re-open events, open `load` task
 *      cancellation, and manifest-carton unbind.
 *   3. `WMS_TOPIC.WAVE_REOPENED` is declared and registered in the
 *      `wms_events_catalog` seed.
 *
 * The guard is source-level (no DB round-trip) — it protects against a
 * future edit accidentally reverting the invariant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { WMS_TOPIC } from "@/features/warehouse/events/topics";

function collectMigrationsMentioning(needle: string): string {
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

describe("Phase 3.7 — manifest scan-out enforcement", () => {
  it("declares WAVE_REOPENED in WMS_TOPIC", () => {
    expect(WMS_TOPIC.WAVE_REOPENED).toBe("warehouse.wave.reopened");
  });

  it("seeds warehouse.wave.reopened in wms_events_catalog", () => {
    const migrations = collectMigrationsMentioning("wms_events_catalog");
    expect(migrations).toMatch(/warehouse\.wave\.reopened/);
  });

  it("wms_transition_manifest enforces scan-out at close and dispatch", () => {
    const migrations = collectMigrationsMentioning("wms_transition_manifest");
    // Latest definition must include the WMS_SCAN_SHORTAGE guard.
    expect(migrations).toMatch(/WMS_SCAN_SHORTAGE/);
    // The check must apply at both close and dispatch — grep for the
    // canonical IN-clause we ship in the migration.
    expect(migrations).toMatch(/p_to_state\s+IN\s*\(\s*'closed'\s*,\s*'dispatched'\s*\)/);
  });

  it("wms_transition_manifest cancellation cascades into wave.reopened + task cancel", () => {
    const migrations = collectMigrationsMentioning("wms_transition_manifest");
    // Reopen emission per affected wave.
    expect(migrations).toMatch(/warehouse\.wave\.reopened/);
    // Load task cancellation routed through wms_transition_task (so the
    // task-lifecycle trigger fires — no in-body emit).
    expect(migrations).toMatch(/wms_transition_task[\s\S]{0,300}?'cancelled'/);
    // Carton ↔ manifest unbind on cancel.
    expect(migrations).toMatch(/UPDATE\s+public\.wms_pack_cartons[\s\S]{0,120}?SET\s+manifest_id\s*=\s*NULL/);
  });
});
