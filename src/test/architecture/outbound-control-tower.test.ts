/**
 * Outbound Control Tower — architecture guards.
 *
 * The tower's whole value is that its numbers are server-truth and its
 * refresh is event-driven. These tests pin both properties so a future edit
 * cannot quietly reintroduce the reporting-dashboard failure mode:
 *
 *  1. The page composes; it never queries or aggregates.
 *  2. No hook in the tower polls — realtime invalidation is the refresh path.
 *  3. Every tower query-key prefix is registered in the realtime map.
 *  4. The old client-aggregating implementation is gone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PAGE = "src/pages/warehouse/OutboundDashboard.tsx";
const MODULE_DIR = "src/features/warehouse/outbound-tower";
const REALTIME = "src/features/warehouse/realtime/useWmsRealtimeSync.ts";

const read = (p: string) => readFileSync(p, "utf8");

describe("outbound control tower architecture", () => {
  it("the page composes only — no supabase client, no data fetching", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/integrations\/supabase\/client/);
    expect(src).not.toMatch(/useQuery\s*\(/);
    expect(src).not.toMatch(/\.from\(/);
  });

  it("the page does not aggregate — no reduce/filter over server rows", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/\.reduce\(/);
    expect(src).not.toMatch(/\.filter\(/);
  });

  it("no tower hook polls", () => {
    for (const f of readdirSync(MODULE_DIR)) {
      expect(read(join(MODULE_DIR, f))).not.toMatch(/refetchInterval/);
    }
  });

  it("every tower query key prefix is realtime-registered", () => {
    const hooks = read(join(MODULE_DIR, "useOutboundTower.ts"));
    const keys = [...hooks.matchAll(/\["(wms-outbound-[a-z-]+)"\]/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(5);

    const realtime = read(REALTIME);
    expect(realtime).toMatch(/OUTBOUND_QUERY_PREFIXES/);
    const prefixBlock = hooks.slice(hooks.indexOf("OUTBOUND_QUERY_PREFIXES"));
    for (const key of keys) {
      // Each key must be exported through the single realtime spread.
      const name = key.replace("wms-outbound-", "");
      expect(prefixBlock).toMatch(
        new RegExp(`OUTBOUND_KEYS\\.${name.replace(/-(.)/g, (_, c) => c.toUpperCase())}`),
      );
    }
  });

  it("the tower is wired into every outbound-moving table", () => {
    const realtime = read(REALTIME);
    for (const table of [
      "wms_tasks", "wms_pick_waves", "wms_pack_cartons", "wms_loading_manifests",
      "wms_exceptions", "wms_trailer_visits", "wms_yard_slots",
    ]) {
      const idx = realtime.indexOf(`${table}:`);
      expect(idx, `${table} missing from realtime map`).toBeGreaterThan(-1);
      const rest = realtime.slice(idx);
      const end = rest.indexOf("\n  ],");
      const block = end > 0 ? rest.slice(0, end) : rest;
      expect(block, `${table} does not invalidate the tower`).toMatch(
        /OUTBOUND_QUERY_PREFIXES/,
      );

    }
  });

  it("the legacy KPI-tile implementation is gone", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/StateBreakdown/);
    expect(src).not.toMatch(/DashboardPrimitives/);
  });
});
