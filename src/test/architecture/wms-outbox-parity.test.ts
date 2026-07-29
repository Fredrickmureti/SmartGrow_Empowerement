/**
 * Architecture guard — Phase 2.4 §5/§6 (event emission parity).
 *
 * Four invariants that were each violated in production before this
 * phase, and would be easy to silently re-break:
 *
 * 1. Emission is trigger-based. Twenty-one legacy domain RPCs mutate the
 *    WMS aggregate tables without calling `_wms_emit_event`; the AFTER
 *    triggers are the only reason those transitions reach the outbox.
 *    Dropping a trigger makes an aggregate go silent with no test
 *    failure anywhere else.
 * 2. Single producer. The FSM RPCs used to ALSO emit in-body, from a
 *    record refreshed by `UPDATE ... RETURNING` — so their `from_status`
 *    / `from_state` was always the *new* value. Triggers see OLD, so
 *    emission now lives there exclusively; an in-body `_wms_emit_event`
 *    on these functions reintroduces both the duplicate and the defect.
 * 3. One vocabulary. `warehouse.plate.*` / `warehouse.task.started` were
 *    a rival naming scheme whose idempotency keys collided with the
 *    catalogued topics, making the published `event_type` for an
 *    `in_progress` transition non-deterministic. They must stay retired.
 * 4. The task lease reaper is scheduled. `wms_task_reap_expired` existed
 *    for months but was never wired to pg_cron, so a task claimed by a
 *    device that went offline stayed claimed forever.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");
const SRC = path.resolve(__dirname, "../..");

function allMigrations(): string {
  let all = "";
  for (const name of readdirSync(MIGRATIONS).sort()) {
    const p = path.join(MIGRATIONS, name);
    if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
    all += "\n" + readFileSync(p, "utf8");
  }
  return all;
}

/**
 * Body of the *last* definition of a function across the migration
 * history — i.e. the one that is live in the database.
 */
function latestFunctionBody(sql: string, name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = sql.lastIndexOf(marker);
  if (start === -1) return "";
  const bodyOpen = sql.indexOf("$function$", start);
  if (bodyOpen === -1) return "";
  const bodyClose = sql.indexOf("$function$", bodyOpen + 10);
  return sql.slice(bodyOpen, bodyClose === -1 ? undefined : bodyClose);
}

/** Aggregate table -> the trigger that must emit its state changes. */
const EMIT_TRIGGERS: Array<[string, string]> = [
  ["wms_tasks", "trg_wms_tasks_emit"],
  ["wms_license_plates", "trg_wms_lpn_emit"],
  ["wms_license_plates", "trg_wms_lpn_moved"],
  ["wms_pick_waves", "trg_wms_waves_emit"],
  ["wms_loading_manifests", "trg_wms_manifests_emit"],
  ["wms_qc_inspections", "trg_wms_qc_emit"],
  ["wms_count_sessions", "trg_wms_counts_emit"],
  ["wms_trailer_visits", "trg_wms_trailers_emit"],
];

/** FSM RPCs whose emission was moved out to the triggers above. */
const TRIGGER_OWNED_RPCS = [
  "wms_transition_task",
  "wms_transition_lpn",
  "wms_claim_next_task",
];


describe("wms outbox emission parity", () => {
  const sql = allMigrations();

  it("every WMS aggregate table has a live emit trigger", () => {
    const missing = EMIT_TRIGGERS.filter(([table, trigger]) => {
      const created = new RegExp(`CREATE TRIGGER ${trigger}\\b[\\s\\S]{0,200}?ON public\\.${table}\\b`, "i");
      // A later migration may DROP it without recreating it.
      const drops = (sql.match(new RegExp(`DROP TRIGGER IF EXISTS ${trigger}\\b`, "gi")) ?? []).length;
      const creates = (sql.match(new RegExp(`CREATE TRIGGER ${trigger}\\b`, "gi")) ?? []).length;
      return !created.test(sql) || creates < drops;
    });
    expect(
      missing.map(([t, g]) => `${t} -> ${g}`),
      "WMS aggregate tables missing an outbox emit trigger",
    ).toEqual([]);
  });

  it("the retired rival topic vocabulary is not reintroduced", () => {
    const retired = ["warehouse.plate.moved", "warehouse.plate.sealed", "warehouse.task.started"];
    const offenders: string[] = [];
    for (const topic of retired) {
      // Historical migrations legitimately mention them; runtime TS must not.
      const hits = walkTs(SRC).filter((f) => readFileSync(f, "utf8").includes(topic));
      offenders.push(...hits.map((f) => `${topic} in ${path.relative(SRC, f)}`));
    }
    expect(offenders, "retired WMS topics must not reappear in runtime code").toEqual([]);
  });

  it("the task lease reaper is scheduled on pg_cron", () => {
    expect(sql).toMatch(/cron\.schedule\(\s*'wms-task-lease-reaper'/);
    expect(sql).toMatch(/wms_task_reap_expired\(\)/);
  });
});

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (/\.(ts|tsx)$/.test(name) && full !== __filename) out.push(full);
  }
  return out;
}
