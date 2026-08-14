/**
 * Architecture guard — Phase 5 (event-driven integration, ADR 0101).
 *
 * 1. No client-emitted warehouse events. Every `warehouse.*` event is produced
 *    server-side (trigger or SECURITY DEFINER RPC); app code that inserts into
 *    `business_event_outbox` would produce unauthenticated, un-keyed events
 *    that bypass the FSM.
 * 2. One vocabulary in TypeScript: `warehouse.x.y` literals live only in
 *    `src/features/warehouse/events/topics.ts`; everything else imports
 *    `WMS_TOPIC`.
 * 3. The topics repaired/registered in the Phase 5 migration are declared, and
 *    the dead vocabulary the consumers used to key off is gone.
 * 4. The Phase 5 migration is the SoT for the SQL side: it seeds every newly
 *    registered topic and strips the retired count emissions.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { WMS_TOPIC } from "@/features/warehouse/events/topics";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC).filter(
  (f) =>
    !f.includes(`${path.sep}test${path.sep}`) &&
    !f.includes("__tests__") &&
    !/\.test\.tsx?$/.test(f),
);

function allMigrations(): string {
  let all = "";
  for (const name of readdirSync(MIGRATIONS).sort()) {
    const p = path.join(MIGRATIONS, name);
    if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
    all += "\n" + readFileSync(p, "utf8");
  }
  return all;
}

const NEWLY_REGISTERED = [
  "warehouse.appointment.rescheduled",
  "warehouse.exception.acknowledged",
  "warehouse.exception.assigned",
  "warehouse.exception.escalated",
  "warehouse.manifest.proof_captured",
  "warehouse.manifest.tracking_allocated",
  "warehouse.packaging.created",
  "warehouse.packaging.updated",
  "warehouse.packaging.archived",
  "warehouse.packaging.lifecycle_changed",
  "warehouse.packaging.consumed",
  "warehouse.packaging.reorder_needed",
  "warehouse.wave.planned",
  "warehouse.labour.plan_published",
  "warehouse.labour.gap_detected",
];

describe("wms event-driven integration (Phase 5)", () => {
  it("no application code inserts warehouse events into the outbox", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("business_event_outbox")) continue;
      // Reads (from(...).select) are fine; writes are not.
      const writes = /from\(\s*["']business_event_outbox["']\s*\)\s*\.\s*(insert|upsert|update|delete)/.test(
        src,
      );
      if (writes) offenders.push(path.relative(ROOT, file));
    }
    expect(
      offenders,
      "warehouse events must be produced server-side (trigger / SECURITY DEFINER RPC)",
    ).toEqual([]);
  });

  it("warehouse topic literals live only in the topic catalog module", () => {
    const catalog = path.join(
      "src",
      "features",
      "warehouse",
      "events",
      "topics.ts",
    );
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (rel === catalog) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(
        /["'](warehouse\.[a-z0-9_]+\.[a-z0-9_]+)["']/g,
      )) {
        offenders.push(`${rel} -> ${m[1]}`);
      }
    }
    expect(offenders, "import WMS_TOPIC instead of hardcoding topics").toEqual(
      [],
    );
  });

  it("declares every topic registered by the Phase 5 migration", () => {
    const declared = new Set<string>(Object.values(WMS_TOPIC));
    const missing = NEWLY_REGISTERED.filter((t) => !declared.has(t));
    expect(missing, `undeclared in WMS_TOPIC: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("seeds those topics into wms_events_catalog and strips the retired count emissions", () => {
    const sql = allMigrations();
    const unseeded = NEWLY_REGISTERED.filter((t) => !sql.includes(`'${t}'`));
    expect(unseeded, `not seeded in any migration: ${unseeded.join(", ")}`).toEqual(
      [],
    );

    // The Phase 5 migration is the newest definition of each count RPC; assert
    // the live body no longer emits the retired vocabulary.
    for (const fn of ["create_count_session_as", "post_count_session"]) {
      const marker = `CREATE OR REPLACE FUNCTION public.${fn}(`;
      const start = sql.lastIndexOf(marker);
      expect(start, `${fn} has no definition in the migration history`).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf("$function$;", start + 1) + 11);
      expect(
        /business_event_outbox/.test(body),
        `${fn} emits in-body — trg_wms_counts_emit is the single producer`,
      ).toBe(false);
    }

    const consumerStart = sql.lastIndexOf(
      "CREATE OR REPLACE FUNCTION public._wms_count_trigger_from_event(",
    );
    expect(consumerStart).toBeGreaterThan(-1);
    const consumer = sql.slice(
      consumerStart,
      sql.indexOf("$function$;", consumerStart + 1) + 11,
    );
    expect(consumer).toContain("warehouse.replen.completed");
    expect(consumer).toContain("warehouse.return.dispositions_posted");
    expect(consumer).not.toContain("warehouse.replenishment.completed");
  });
});
