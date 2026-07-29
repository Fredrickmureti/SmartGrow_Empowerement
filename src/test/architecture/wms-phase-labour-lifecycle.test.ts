/**
 * Phase 3.6 guard — Labour / task orchestration.
 *
 * Verifies the structural pieces landed by the Phase 3.6 migration:
 *
 *   1. `wms_labour_queue_view` exists somewhere in supabase/migrations
 *      (unified queue is the single supervisor + mobile RF surface).
 *   2. It is declared with `security_invoker = true` — inheriting RLS
 *      from `wms_tasks` is the whole point; a definer view would leak
 *      cross-business rows to any authenticated caller.
 *   3. The cross-dock evaluator seeds a stage-for-dispatch task
 *      (`source_doc_type = 'wms_crossdock_opportunity'`) so cross-dock
 *      surfaces in the same labour queue as normal pick / pack work.
 *
 * Pure source inspection — no DB, no React tree.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

function readAllMigrations(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf-8"))
    .join("\n");
}

describe("wms-phase-labour-lifecycle (Phase 3.6)", () => {
  const sql = readAllMigrations();

  it("declares wms_labour_queue_view", () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.wms_labour_queue_view/i);
  });

  it("wms_labour_queue_view uses security_invoker=true (RLS inherited from wms_tasks)", () => {
    const match = sql.match(
      /CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.wms_labour_queue_view[\s\S]*?AS\s+SELECT/i,
    );
    expect(match, "wms_labour_queue_view declaration not found").toBeTruthy();
    expect(match![0]).toMatch(/security_invoker\s*=\s*true/i);
  });

  it("cross-dock evaluator seeds a stage-for-dispatch task", () => {
    // Latest definition of evaluate_crossdock_on_receiving_line must
    // insert into wms_tasks with the crossdock opportunity as source.
    // Match each definition up to the closing dollar-quote tag ($$ or
    // $function$); the latest one must seed the stage-for-dispatch task.
    const defs = sql.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.evaluate_crossdock_on_receiving_line[\s\S]*?END\s*\$(?:function)?\$\s*;/gi,
    );
    expect(defs?.length ?? 0).toBeGreaterThan(0);
    const latest = defs![defs!.length - 1];
    expect(latest).toMatch(/INSERT\s+INTO\s+public\.wms_tasks/i);
    expect(latest).toMatch(/wms_crossdock_opportunity/);
  });

  it("_wms_emit_task_event maps paused and resumed to canonical topics", () => {
    const defs = sql.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\._wms_emit_task_event[\s\S]*?END;\s*\$(?:function)?\$\s*;/gi,
    );
    expect(defs?.length ?? 0).toBeGreaterThan(0);
    const latest = defs![defs!.length - 1];
    expect(latest).toMatch(/WHEN\s+'paused'\s+THEN\s+'paused'/i);
    expect(latest).toMatch(/WHEN\s+'resumed'\s+THEN\s+'resumed'/i);
  });

  it("task-event idempotency key is scoped by row_version", () => {
    // Prevents pause->resume->pause loops from colliding on the outbox
    // unique index and silently dropping later transitions.
    const defs = sql.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\._wms_emit_task_event[\s\S]*?END;\s*\$(?:function)?\$\s*;/gi,
    );
    const latest = defs![defs!.length - 1];
    expect(latest).toMatch(/wms\.task:[\s\S]*row_version/);
  });

  it("wms_transition_task allows pause/resume edges", () => {
    const defs = sql.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.wms_transition_task[\s\S]*?END\s*\$(?:function)?\$\s*;/gi,
    );
    expect(defs?.length ?? 0).toBeGreaterThan(0);
    const latest = defs![defs!.length - 1];
    expect(latest).toMatch(/'in_progress>paused'/);
    expect(latest).toMatch(/'paused>resumed'/);
    expect(latest).toMatch(/'paused>cancelled'/);
    expect(latest).toMatch(/'resumed>in_progress'/);
  });
});