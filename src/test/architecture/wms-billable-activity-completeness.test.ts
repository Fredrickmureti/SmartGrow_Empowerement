/**
 * Architecture guard (Phase 5.4).
 *
 * Every 3PL billable activity offered as a tariff in `BillingBoard` must
 * have a *producer*: either an event branch inside
 * `_wms_map_event_to_activity` (outbox-driven activities), or an explicit
 * accrual function (time-based activities such as storage days).
 *
 * Without this, an activity can be priced in the UI and silently never
 * billed — which is exactly how `storage_lpn_day` shipped with a tariff
 * selector and no producer at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

function migrationsText(filter: (src: string) => boolean): string {
  const dir = path.join(ROOT, "supabase/migrations");
  let all = "";
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
    const src = readFileSync(p, "utf8");
    if (filter(src)) all += "\n" + src;
  }
  return all;
}

function billingBoardActivities(): string[] {
  const src = readFileSync(
    path.join(ROOT, "src/pages/warehouse/BillingBoard.tsx"),
    "utf8",
  );
  const block = src.match(/const ACTIVITIES = \[([\s\S]*?)\] as const;/);
  expect(block, "ACTIVITIES list not found in BillingBoard.tsx").toBeTruthy();
  return [...block![1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

describe("3PL billable activity completeness", () => {
  const activities = billingBoardActivities();

  it("BillingBoard exposes a non-trivial activity list", () => {
    expect(activities.length).toBeGreaterThan(5);
  });

  it("every tariffable activity has an event mapper branch or an accrual producer", () => {
    const sql = migrationsText(
      (s) =>
        s.includes("_wms_map_event_to_activity") ||
        s.includes("wms_accrue_storage_days"),
    );

    const unproduced = activities.filter((a) => {
      // Producer = the activity string appears on the right-hand side of a
      // mapper branch, or is inserted by an accrual function.
      const mapped = new RegExp(`THEN\\s+'${a}'`).test(sql);
      const accrued = new RegExp(`,\\s*'${a}',`).test(sql);
      return !mapped && !accrued;
    });

    expect(
      unproduced,
      `activities priced in BillingBoard with no producer: ${unproduced.join(", ")}`,
    ).toEqual([]);
  });

  it("the storage accrual is idempotent and permission-checked", () => {
    const sql = migrationsText((s) => s.includes("wms_accrue_storage_days"));
    expect(sql).toContain("uq_wms_billable_storage_day");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("user_has_module_permission");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.wms_accrue_storage_days/);
  });

  it("task-completion events carry the task_type the mapper branches on", () => {
    // The mapper prices putaway/pick/pack off `payload->>'task_type'`;
    // an emitter that omits it silently drops billable work on the floor.
    const sql = migrationsText((s) => s.includes("_wms_emit_task_event"));
    expect(sql).toMatch(/'warehouse\.task\.'\s*\|\|/);
    expect(sql).toMatch(/jsonb_build_object\(\s*'task_type',/);
  });


  it("the accrual is reachable from the BillingBoard UI", () => {
    const src = readFileSync(
      path.join(ROOT, "src/pages/warehouse/BillingBoard.tsx"),
      "utf8",
    );
    expect(src).toContain("wms_accrue_storage_days");
    expect(src).toMatch(/Accrue storage/);
  });
});
