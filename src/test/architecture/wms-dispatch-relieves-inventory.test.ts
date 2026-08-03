/**
 * Phase A architecture guard — dispatch relieves inventory.
 *
 * Audit finding this pins:
 *
 *   None of complete_pick_task, seal_pack_carton, load_carton_onto_manifest,
 *   close_loading_manifest, dispatch_loading_manifest or
 *   wms_transition_manifest touched stock_movements or stock_quants. The one
 *   ledger-correct outbound primitive, wms_lpn_dispatch(), existed and was
 *   called by nothing on the manifest path. Goods left the building while the
 *   books still carried them.
 *
 * Phase A hooks wms_lpn_dispatch into the `closed -> dispatched` FSM edge and
 * collapses the legacy wrappers into thin delegates so there is exactly one
 * implementation of dispatch semantics.
 *
 * Source-level guard (no DB round-trip) against a future edit reverting this.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../supabase/migrations");

/** Concatenate every migration mentioning `needle`, newest last. */
function collectMigrationsMentioning(needle: string): string {
  let all = "";
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
    const p = path.join(MIGRATIONS_DIR, name);
    if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
    const src = readFileSync(p, "utf8");
    if (src.includes(needle)) all += "\n" + src;
  }
  return all;
}

/** The most recent CREATE OR REPLACE body for a given function name. */
function latestDefinitionOf(fnName: string): string {
  let latest = "";
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
    const p = path.join(MIGRATIONS_DIR, name);
    if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
    const src = readFileSync(p, "utf8");
    const re = new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${fnName}\\s*\\([\\s\\S]*?\\$function\\$;`,
      "g",
    );
    const matches = src.match(re);
    if (matches?.length) latest = matches[matches.length - 1];
  }
  return latest;
}

describe("Phase A — dispatch relieves inventory", () => {
  it("the manifest FSM calls wms_lpn_dispatch on the dispatched edge", () => {
    const def = latestDefinitionOf("wms_transition_manifest");
    expect(def).not.toBe("");
    expect(def).toMatch(/wms_lpn_dispatch/);
    // Gated on dispatch specifically — never on close or cancel.
    expect(def).toMatch(/IF p_to_state = 'dispatched'[\s\S]{0,2000}wms_lpn_dispatch/);
  });

  it("skips license plates that are already shipped (idempotent replay)", () => {
    const def = latestDefinitionOf("wms_transition_manifest");
    expect(def).toMatch(/IS DISTINCT FROM 'shipped'/);
  });

  it("does not swallow stock-relief failures", () => {
    const def = latestDefinitionOf("wms_transition_manifest");
    // A BEGIN/EXCEPTION WHEN OTHERS wrapper around the relief call would let a
    // truck leave with an unbalanced ledger. Outbox emits may warn; relief may not.
    expect(def).not.toMatch(
      /wms_lpn_dispatch[\s\S]{0,400}EXCEPTION\s+WHEN\s+OTHERS[\s\S]{0,200}RAISE\s+WARNING/,
    );
  });

  it("keeps scan-out enforcement in place alongside the ledger hook", () => {
    const def = latestDefinitionOf("wms_transition_manifest");
    expect(def).toMatch(/WMS_SCAN_SHORTAGE/);
    expect(def).toMatch(/p_to_state\s+IN\s*\(\s*'closed'\s*,\s*'dispatched'\s*\)/);
  });

  it("legacy close/dispatch wrappers delegate to the FSM (single authority)", () => {
    const dispatchDef = latestDefinitionOf("dispatch_loading_manifest");
    const closeDef = latestDefinitionOf("close_loading_manifest");
    expect(dispatchDef).toMatch(/wms_transition_manifest/);
    expect(closeDef).toMatch(/wms_transition_manifest/);
    // Neither wrapper may keep its own copy of the state write.
    expect(dispatchDef).not.toMatch(/UPDATE public\.wms_loading_manifests\s+SET\s+state\s*=\s*'dispatched'/);
  });

  it("drops the stale 3-argument open_loading_manifest overload", () => {
    const sql = collectMigrationsMentioning("open_loading_manifest");
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.open_loading_manifest\(uuid, uuid, timestamptz\)/);
  });

  it("the manifest planner always sends p_appointment_id so one overload resolves", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../pages/warehouse/LoadingManifestPlanner.tsx"),
      "utf8",
    );
    expect(src).toMatch(/p_appointment_id:\s*appointmentId\s*\|\|\s*null/);
    expect(src).not.toMatch(/p_appointment_id:\s*appointmentId\s*\|\|\s*undefined/);
  });
});
