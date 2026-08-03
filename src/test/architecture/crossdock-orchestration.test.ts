/**
 * Architecture guard — Cross-dock orchestration (ADR 0107, Phase 7).
 *
 * Cross-dock is a decision engine, not a table editor. This guard locks
 * the boundaries that make that true:
 *  - every `wms_crossdock_state` value has a registered event topic;
 *  - the board never calls an RPC directly (aggregate wrapper only);
 *  - nothing writes the opportunities table outside the RPCs;
 *  - the automatic-break subscribers and the requalification sweep stay
 *    wired in SQL;
 *  - the routing label goes through the print platform, never raw ZPL.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const ROOT = path.resolve(SRC, "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

const wrapper = readFileSync(
  path.join(SRC, "features/warehouse/crossdock/useCrossdock.ts"),
  "utf8",
);
const board = readFileSync(path.join(SRC, "pages/warehouse/CrossdockBoard.tsx"), "utf8");
const topics = readFileSync(path.join(SRC, "features/warehouse/events/topics.ts"), "utf8");
const labels = readFileSync(
  path.join(SRC, "features/warehouse/crossdock/crossdockLabels.ts"),
  "utf8",
);

function allMigrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Terminal + transitional states the FSM can reach. */
const STATES = [
  "detected",
  "qualified",
  "approved",
  "staging",
  "staged",
  "loaded",
  "completed",
  "rejected",
  "expired",
  "broken",
  "cancelled",
];

describe("cross-dock orchestration guards", () => {
  it("every lifecycle state has a registered event topic", () => {
    const missing = STATES.filter(
      (s) => s !== "detected" && !topics.includes(`warehouse.crossdock.${s}`),
    );
    expect(missing, `topics.ts is missing warehouse.crossdock.* for: ${missing}`).toEqual([]);
  });

  it("the board calls no cross-dock RPC directly", () => {
    expect(board).not.toMatch(/supabase\s*\.\s*rpc\s*\(/);
    expect(board).not.toMatch(/from\(\s*["']wms_crossdock_/);
  });

  it("no client file writes the opportunities table outside the RPCs", () => {
    const banned =
      /from\(\s*["']wms_crossdock_(opportunities|history)["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    const offenders = walk(SRC)
      .filter((f) => !/[\\/]test[\\/]/.test(f))
      .filter((f) => banned.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(offenders, `cross-dock writes are RPC-only:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the wrapper covers every orchestration RPC", () => {
    for (const fn of [
      "wms_crossdock_approve",
      "wms_crossdock_reject",
      "wms_crossdock_start_staging",
      "wms_crossdock_confirm_staged",
      "wms_crossdock_mark_loaded",
      "wms_crossdock_complete",
      "wms_crossdock_break",
      "wms_crossdock_sweep_expired",
      "wms_crossdock_requalify_sweep",
    ]) {
      expect(wrapper, `wrapper does not expose ${fn}`).toContain(fn);
    }
  });

  it("automatic break subscribers and the sweeps exist in SQL", () => {
    const sql = allMigrationSql();
    for (const symbol of [
      "_wms_crossdock_auto_break",
      "wms_crossdock_requalify_sweep",
      "wms_crossdock_sweep_expired",
      "wms_crossdock_board_view",
      "wms_crossdock_metrics_view",
    ]) {
      expect(sql, `${symbol} is not defined in any migration`).toContain(symbol);
    }
  });

  it("detection covers sales order, transfer and replenishment demand", () => {
    const sql = allMigrationSql();
    for (const demand of ["'sales_order'", "'transfer'", "'replenishment'"]) {
      expect(sql, `_wms_crossdock_detect never matches ${demand}`).toContain(
        `${demand}::public.wms_crossdock_demand_type`,
      );
    }
  });

  it("the routing label is dispatched through the print platform", () => {
    expect(labels).toContain("printWmsLabel");
    expect(labels).toContain("WMS_LABEL_KEY.CROSSDOCK_ROUTING");
    expect(labels).not.toMatch(/\^XA[\s\S]*\^XZ/);
    expect(board).toContain("printCrossdockRoutingLabel");
  });
});
