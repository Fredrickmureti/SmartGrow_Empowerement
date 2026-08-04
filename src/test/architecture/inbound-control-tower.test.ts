/**
 * Inbound Control Tower — architecture guards.
 *
 * The tower's whole value is that its numbers are server-truth and its
 * refresh is event-driven. These tests pin both properties so a future edit
 * cannot quietly reintroduce the reporting-dashboard failure mode:
 *
 *  1. The page composes; it never queries or aggregates.
 *  2. No hook in the tower polls — realtime invalidation is the refresh path.
 *  3. Every tower query-key prefix is registered in the realtime map.
 *  4. No exception or discrepancy is classified in the client.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PAGE = "src/pages/warehouse/InboundDashboard.tsx";
const MODULE_DIR = "src/features/warehouse/inbound-tower";
const REALTIME = "src/features/warehouse/realtime/useWmsRealtimeSync.ts";

const read = (p: string) => readFileSync(p, "utf8");

describe("inbound control tower architecture", () => {
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

  it("no client-side exception classification (the legacy regex failure)", () => {
    for (const f of readdirSync(MODULE_DIR)) {
      const src = read(join(MODULE_DIR, f));
      expect(src, `${f} matches exception text in the client`).not.toMatch(
        /\.(reason|kind|message)\s*[?.]*\s*\.?(match|test|includes)\(/,
      );
    }
    expect(read(PAGE)).not.toMatch(/\/(damage|short|over)/i);
  });

  it("every tower query key prefix is realtime-registered", () => {
    const hooks = read(join(MODULE_DIR, "useInboundTower.ts"));
    const keys = [...hooks.matchAll(/\["(wms-inbound-[a-z-]+)"\]/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(5);

    const realtime = read(REALTIME);
    expect(realtime).toMatch(/INBOUND_QUERY_PREFIXES/);
    const prefixBlock = hooks.slice(hooks.indexOf("INBOUND_QUERY_PREFIXES"));
    for (const key of keys) {
      const name = key.replace("wms-inbound-", "");
      expect(prefixBlock).toMatch(
        new RegExp(`INBOUND_KEYS\\.${name.replace(/-(.)/g, (_, c) => c.toUpperCase())}`),
      );
    }
  });

  it("the tower is wired into every inbound-moving table", () => {
    const realtime = read(REALTIME);
    for (const table of [
      "wms_tasks", "wms_receiving_sessions", "wms_qc_inspections",
      "wms_dock_appointments", "wms_exceptions", "wms_trailer_visits",
      "wms_yard_slots",
    ]) {
      const idx = realtime.indexOf(`${table}:`);
      expect(idx, `${table} missing from realtime map`).toBeGreaterThan(-1);
      const rest = realtime.slice(idx);
      const end = rest.indexOf("\n  ],");
      const block = end > 0 ? rest.slice(0, end) : rest;
      expect(block, `${table} does not invalidate the tower`).toMatch(
        /INBOUND_QUERY_PREFIXES/,
      );
    }
  });

  it("the legacy KPI-tile implementation is gone", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/DashboardPrimitives/);
    expect(src).not.toMatch(/StatCard/);
  });

  it("every in-app link points at a real warehouse route", () => {
    const routes = read("src/apps/warehouse/routes.tsx");
    for (const f of readdirSync(MODULE_DIR)) {
      const src = read(join(MODULE_DIR, f));
      for (const m of src.matchAll(/to="(\/[^"]+)"/g)) {
        const href = m[1];
        expect(href, `${f} links outside the warehouse app`).toMatch(/^\/warehouse-app\//);
        const seg = href.replace("/warehouse-app/", "").split("/")[0];
        expect(
          routes.includes(`path="${seg}"`),
          `${f} links to /warehouse-app/${seg} which has no route`,
        ).toBe(true);
      }
    }
  });
});
