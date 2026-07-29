/**
 * Architecture guard (Phase 2.0 §4).
 *
 * The runtime source of truth for `warehouse.*` topics is the
 * `wms_events_catalog` table. The TypeScript layer references
 * `WMS_TOPIC` in `src/features/warehouse/events/topics.ts`. The two
 * MUST stay in lockstep — a producer added on one side without the
 * other means observers can't decode events (or drift the other way).
 *
 * This is a static file-level check (no DB round-trip). The migration
 * that seeds `wms_events_catalog` is the SoT for the SQL side; the
 * test asserts the union of topic strings declared in the migrations
 * folder matches `WMS_TOPIC` values.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { WMS_TOPIC } from "@/features/warehouse/events/topics";

function collectMigrations(): string {
  const dir = path.resolve(__dirname, "../../../supabase/migrations");
  let all = "";
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
    const src = readFileSync(p, "utf8");
    if (src.includes("wms_events_catalog")) all += "\n" + src;
  }
  return all;
}

describe("wms_events_catalog stays in sync with WMS_TOPIC", () => {
  it("every WMS_TOPIC value has a matching seed row in a migration", () => {
    const migrations = collectMigrations();
    const missing = Object.values(WMS_TOPIC).filter((t) => !migrations.includes(t));
    expect(missing, `missing catalog rows for: ${missing.join(", ")}`).toEqual([]);
  });
});
