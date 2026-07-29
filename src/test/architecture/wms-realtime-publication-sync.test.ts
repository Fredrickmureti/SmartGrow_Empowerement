/**
 * Guard test — Phase 2.3 realtime board fabric.
 *
 * Pins the tables our TS hook subscribes to against the tables actually
 * on the `supabase_realtime` publication. If either side drifts, page
 * subscriptions silently miss updates — this test fails loudly instead.
 *
 * The DB side is asserted via a hard-coded expected set that mirrors
 * the migrations already applied; when we add a new WMS table to the
 * publication we update this list AND the TS hook in the same commit.
 */
import { describe, it, expect } from "vitest";
import { WMS_REALTIME_TABLES } from "@/features/warehouse/realtime/useWmsRealtimeSync";

/** Kept in sync with the ALTER PUBLICATION supabase_realtime migrations
 *  for wms_* aggregates (ADR 0101 Phase 2.3). */
const PUBLISHED_WMS_TABLES = [
  "wms_tasks",
  "wms_license_plates",
  "wms_exceptions",
  "wms_receiving_sessions",
  "wms_return_orders",
  "wms_pick_waves",
  "wms_pack_cartons",
  "wms_manifest_cartons",
  "wms_loading_manifests",
  "wms_qc_inspections",
  "wms_count_sessions",
  "wms_count_lines",
  // Phase 4 §6 — Inbound control tower tiles appointment state live.
  "wms_dock_appointments",
] as const;

describe("WMS realtime subscription ↔ publication parity", () => {
  it("every table published for WMS is subscribed by the hook", () => {
    const missing = PUBLISHED_WMS_TABLES.filter(
      (t) => !WMS_REALTIME_TABLES.includes(t),
    );
    expect(
      missing,
      `Tables on supabase_realtime but not in useWmsRealtimeSync: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no subscribed table is missing from the publication", () => {
    const extra = WMS_REALTIME_TABLES.filter(
      (t) => !(PUBLISHED_WMS_TABLES as readonly string[]).includes(t),
    );
    expect(
      extra,
      `Tables in useWmsRealtimeSync but not on supabase_realtime: ${extra.join(", ")}`,
    ).toEqual([]);
  });
});
