/**
 * Wave Control Tower — architecture guards (ADR-0112, Phase 7).
 *
 * Wave planning is only trustworthy while the release verdict has one
 * owner. These tests pin the properties that make that true:
 *
 *  1. The page composes; it never queries or aggregates server rows.
 *  2. Readiness and risk are never re-derived in the client.
 *  3. `release_pick_wave` has exactly one call site, in the wrapper layer.
 *  4. Lifecycle changes go through the FSM wrapper, never a table write.
 *  5. Refresh is realtime invalidation — no tower hook polls.
 *  6. Every tower link resolves to a real warehouse route.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PAGE = "src/pages/warehouse/WavePlanner.tsx";
const MODULE_DIR = "src/features/warehouse/wave-tower";
const REALTIME = "src/features/warehouse/realtime/useWmsRealtimeSync.ts";
const OPS = "src/features/warehouse/aggregates/useDomainOperations.ts";
const ROUTES = "src/apps/warehouse/routes.tsx";

const read = (p: string) => readFileSync(p, "utf8");
const moduleFiles = () =>
  readdirSync(MODULE_DIR).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

describe("wave control tower architecture", () => {
  it("the page composes only — no supabase client, no direct queries", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/integrations\/supabase\/client/);
    expect(src).not.toMatch(/useQuery\s*\(/);
    expect(src).not.toMatch(/\.from\(/);
    expect(src).not.toMatch(/supabase\.rpc\(/);
  });

  it("the page does not aggregate server rows", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/\.reduce\(/);
    expect(src).not.toMatch(/rows\.filter\(|data\.filter\(/);
  });

  it("readiness and risk are read, never recomputed, in the client", () => {
    for (const f of moduleFiles()) {
      const src = read(join(MODULE_DIR, f));
      // No client-side verdict arithmetic against labour/stock/dock inputs.
      expect(src, `${f} recomputes a readiness verdict`).not.toMatch(
        /(available_hours|required_hours|gap_seconds)\s*[<>]=?/,
      );
    }
  });

  it("release has exactly one call site and it lives in the wrapper layer", () => {
    const hits = moduleFiles()
      .map((f) => read(join(MODULE_DIR, f)))
      .concat(read(PAGE))
      .filter((src) => src.includes('"release_pick_wave"'));
    expect(hits, "release_pick_wave called outside the wrapper layer").toHaveLength(0);

    const ops = read(OPS);
    const calls = [...ops.matchAll(/"release_pick_wave"/g)];
    expect(calls, "release_pick_wave must have one call site").toHaveLength(1);
  });

  it("lifecycle changes go through the FSM wrapper, never a table write", () => {
    for (const f of moduleFiles().concat([PAGE])) {
      const src = f === PAGE ? read(PAGE) : read(join(MODULE_DIR, f));
      expect(src, `${f} writes wave state directly`).not.toMatch(
        /from\(["']wms_pick_waves["']\)[\s\S]{0,80}\.update\(/,
      );
    }
    expect(read(PAGE)).toMatch(/useWaveTransition/);
  });

  it("no tower hook polls", () => {
    for (const f of moduleFiles()) {
      expect(read(join(MODULE_DIR, f)), `${f} polls`).not.toMatch(/refetchInterval/);
    }
  });

  it("every tower query prefix is realtime-registered on wave-moving tables", () => {
    const hooks = read(join(MODULE_DIR, "useWaveTower.ts"));
    expect(hooks).toMatch(/export const WAVE_QUERY_PREFIXES/);

    const realtime = read(REALTIME);
    expect(realtime).toMatch(/WAVE_QUERY_PREFIXES/);
    for (const table of ["wms_pick_waves", "wms_pick_wave_lines", "wms_tasks", "wms_exceptions"]) {
      const idx = realtime.indexOf(`${table}: [`);
      expect(idx, `${table} missing from realtime map`).toBeGreaterThan(-1);
      const rest = realtime.slice(idx);
      const end = rest.indexOf("\n  ],");
      const block = end > 0 ? rest.slice(0, end) : rest;
      expect(block, `${table} does not invalidate the wave tower`).toMatch(
        /WAVE_QUERY_PREFIXES/,
      );
    }
  });

  it("every in-app link points at a real warehouse route", () => {
    const routes = read(ROUTES);
    for (const f of moduleFiles()) {
      const src = read(join(MODULE_DIR, f));
      for (const m of src.matchAll(/to="(\/[^"$]+)"/g)) {
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
