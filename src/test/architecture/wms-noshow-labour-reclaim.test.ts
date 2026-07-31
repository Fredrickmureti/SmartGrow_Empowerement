/**
 * Phase 5.2 — trailer no-show must reclaim booked loading labour.
 *
 * Business event: a truck that never shows up must not keep a loading
 * manifest, its cartons, or the `load` tasks booked against it. Closing
 * only the yard visit leaves operators assigned to work that can never
 * complete, and the labour board over-reports committed hours.
 *
 * The cascade is deliberately routed through `wms_transition_manifest`
 * (the same path a manual manifest cancel takes) so cartons are unlinked,
 * waves reopened, and each cancelled task emits warehouse.task.cancelled
 * exactly once — no second, divergent cancellation implementation.
 *
 * These guards read the migration SQL: the shape of the cascade is the
 * contract, and a future edit that inlines its own UPDATE would silently
 * skip the task-lifecycle events.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { WMS_TOPIC } from "@/features/warehouse/events/topics";

const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");

/** Body of the latest migration that redefines `fn`. */
function latestDefinitionOf(fn: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found = "";
  for (const f of files) {
    const sql = readFileSync(path.join(MIGRATIONS, f), "utf8");
    const re = new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${fn}\\b[\\s\\S]*?\\$\\$;`,
      "g",
    );
    const hits = sql.match(re);
    if (hits) found = hits[hits.length - 1];
  }
  return found;
}

describe("wms trailer no-show → labour reclaim", () => {
  const noShow = latestDefinitionOf("mark_trailer_no_show");
  const openManifest = latestDefinitionOf("open_loading_manifest");

  it("a manifest records the trailer visit it is being loaded onto", () => {
    const all = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
      .join("\n");
    expect(all).toMatch(
      /ALTER TABLE public\.wms_loading_manifests[\s\S]{0,120}trailer_visit_id/,
    );
    expect(openManifest, "open_loading_manifest must resolve the trailer visit").toMatch(
      /trailer_visit_id/,
    );
    expect(openManifest).toMatch(/FROM public\.wms_trailer_visits/);
  });

  it("no-show cancels the trailer's open manifests through the shared cascade", () => {
    expect(noShow).not.toBe("");
    // Only draft/loading manifests — never a closed or dispatched one.
    expect(noShow).toMatch(/state IN \('draft','loading'\)/);
    // The cascade, not a bespoke UPDATE of task state.
    expect(noShow).toMatch(/wms_transition_manifest\(/);
    expect(
      noShow,
      "must not hand-roll task cancellation — route through wms_transition_manifest",
    ).not.toMatch(/UPDATE public\.wms_tasks[\s\S]{0,200}cancelled/);
  });

  it("the cascade matches on the trailer link and falls back to the appointment", () => {
    expect(noShow).toMatch(/m\.trailer_visit_id = v_visit\.id/);
    expect(noShow).toMatch(/m\.appointment_id = v_visit\.appointment_id/);
  });

  it("a reclaim event is emitted with the released counts", () => {
    expect(noShow).toMatch(/'warehouse\.labour\.reclaimed'/);
    expect(noShow).toMatch(/'cancelled_manifests'/);
    expect(noShow).toMatch(/'released_load_tasks'/);
    // Idempotency key shape stays canonical.
    expect(noShow).toMatch(/wms\.trailer_visit:.*:labour_reclaimed/);
  });

  it("the reclaim topic is registered client-side and in the catalog", () => {
    expect(WMS_TOPIC.LABOUR_RECLAIMED).toBe("warehouse.labour.reclaimed");
    const all = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
      .join("\n");
    expect(all).toMatch(
      /INSERT INTO public\.wms_events_catalog[\s\S]{0,400}'warehouse\.labour\.reclaimed'/,
    );
  });

  it("a trailer at a dock still cannot be no-showed", () => {
    expect(noShow).toMatch(/at_dock[\s\S]{0,120}depart it instead/);
  });
});
