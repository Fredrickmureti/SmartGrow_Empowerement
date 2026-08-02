/**
 * Architecture guard (Phase 2.0 §4; hardened by the Returns audit Phase 4b).
 *
 * The runtime source of truth for `warehouse.*` topics is the
 * `wms_events_catalog` table. The TypeScript layer references `WMS_TOPIC` in
 * `src/features/warehouse/events/topics.ts`. The two MUST stay in lockstep in
 * BOTH directions:
 *
 *  - a TS topic with no catalog row means observability tooling cannot decode
 *    the event;
 *  - a catalog row with no TS constant means a topic nobody can subscribe to
 *    from application code — dead vocabulary that silently rots (this is how
 *    `warehouse.return.opened|inspected|dispositioned` survived unnoticed).
 *
 * Intentional one-way rows must be declared in `WMS_DEPRECATED_TOPICS`.
 *
 * Static file-level check (no DB round-trip): the migrations folder is the
 * SoT for the SQL side.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { WMS_TOPIC, WMS_DEPRECATED_TOPICS } from "@/features/warehouse/events/topics";

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

/** Every `'warehouse.x.y'` literal appearing in a catalog-touching migration. */
function catalogTopics(sql: string): string[] {
  const found = new Set<string>();
  for (const m of sql.matchAll(/'(warehouse\.[a-z0-9_]+\.[a-z0-9_]+)'/g)) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

describe("wms_events_catalog stays in sync with WMS_TOPIC", () => {
  const migrations = collectMigrations();

  it("every WMS_TOPIC value has a matching seed row in a migration", () => {
    const missing = Object.values(WMS_TOPIC).filter((t) => !migrations.includes(t));
    expect(missing, `missing catalog rows for: ${missing.join(", ")}`).toEqual([]);
  });

  it("every seeded catalog topic is declared in TypeScript (or explicitly deprecated)", () => {
    const declared = new Set<string>([
      ...Object.values(WMS_TOPIC),
      ...WMS_DEPRECATED_TOPICS,
    ]);
    const undeclared = catalogTopics(migrations).filter((t) => !declared.has(t));
    expect(
      undeclared,
      `catalog topics with no WMS_TOPIC constant: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });

  it("deprecated topics are not re-declared in WMS_TOPIC", () => {
    const values = new Set<string>(Object.values(WMS_TOPIC));
    const resurrected = WMS_DEPRECATED_TOPICS.filter((t) => values.has(t));
    expect(resurrected).toEqual([]);
  });
});
