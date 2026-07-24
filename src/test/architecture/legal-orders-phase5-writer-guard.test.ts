/**
 * ADR-0094 Phase 5 — Legal Order writer-guard architecture pin.
 *
 * Any SQL migration that mutates `legal_orders_records.status` must live
 * inside one of the four sanctioned SECURITY DEFINER functions:
 *
 *   • garnishment_transition_impl
 *   • garnishment_transition
 *   • apply_system_garnishment_transition
 *   • apply_garnishment_payment_to_order
 *
 * Any other UPDATE ... SET status ... on that table is a lifecycle bypass
 * and must be refactored to go through the FSM. The Phase 2 DB trigger
 * (`_legal_order_fsm_guard`) rejects such writes at runtime; this test
 * fails the build before the migration ever runs.
 *
 * Also pins that Phase 5 event integration objects exist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const migrationsDir = "supabase/migrations";
const ALLOWED_FUNCTIONS = [
  "garnishment_transition_impl",
  "garnishment_transition",
  "apply_system_garnishment_transition",
  "apply_garnishment_payment_to_order",
];

function readMigrations(): Array<{ path: string; src: string }> {
  return readdirSync(join(repo, migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      path: `${migrationsDir}/${f}`,
      src: readFileSync(join(repo, migrationsDir, f), "utf8"),
    }));
}

/**
 * Split a SQL file into function bodies vs. non-function statements.
 * We only need to know which spans of SQL are wrapped by
 * `CREATE ... FUNCTION public.<name>(...) ... $$ ... $$`.
 */
function functionSpans(src: string): Array<{ name: string; start: number; end: number }> {
  const spans: Array<{ name: string; start: number; end: number }> = [];
  // Match: CREATE [OR REPLACE] FUNCTION public.<name>( ... ) ... $tag$ ... $tag$
  const rx = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) {
    const start = m.index;
    // Find first dollar-quoted tag after the header.
    const tagMatch = /\$([A-Za-z0-9_]*)\$/.exec(src.slice(start));
    if (!tagMatch) continue;
    const tag = tagMatch[1];
    const bodyOpen = start + tagMatch.index + tagMatch[0].length;
    const closer = new RegExp(`\\$${tag}\\$`, "g");
    closer.lastIndex = bodyOpen;
    const closeMatch = closer.exec(src);
    if (!closeMatch) continue;
    spans.push({ name: m[1], start, end: closeMatch.index + closeMatch[0].length });
  }
  return spans;
}

describe("Legal Orders — Phase 5 writer guard", () => {
  it("every migration UPDATE ... legal_orders_records SET status ... lives inside a sanctioned FSM function", () => {
    const rx = /update\s+(?:only\s+)?(?:public\.)?legal_orders_records\b[\s\S]{0,400}?\bset\b[\s\S]{0,400}?\bstatus\s*=/gi;
    const offenders: string[] = [];
    for (const { path, src } of readMigrations()) {
      const spans = functionSpans(src);
      let m: RegExpExecArray | null;
      while ((m = rx.exec(src)) !== null) {
        const hit = m.index;
        const wrapping = spans.find(
          (s) => hit >= s.start && hit <= s.end && ALLOWED_FUNCTIONS.includes(s.name),
        );
        if (!wrapping) {
          const line = src.slice(0, hit).split("\n").length;
          offenders.push(`${path}:${line}`);
        }
      }
    }
    expect(
      offenders,
      `Direct status writes bypass the FSM. Move the UPDATE inside one of: ${ALLOWED_FUNCTIONS.join(", ")}.`,
    ).toEqual([]);
  });

  it("Phase 5 event-integration objects are present in migrations", () => {
    const combined = readMigrations().map((m) => m.src).join("\n");
    expect(combined).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.legal_order_check_finance_drift\b/i);
    expect(combined).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.legal_order_notify_employee\b/i);
    expect(combined).toMatch(/legal_order_subscriber_dispatch_log/);
    // status_changed subscription rows registered.
    expect(combined).toMatch(/'legal_order\.status_changed',\s*'finance\.drift_checker'/);
    expect(combined).toMatch(/'legal_order\.status_changed',\s*'ess\.employee_notifier'/);
    expect(combined).toMatch(/'legal_order\.payment_posted',\s*'finance\.drift_checker'/);
    expect(combined).toMatch(/'legal_order\.payment_posted',\s*'ess\.employee_notifier'/);
  });

  it("outbox dispatcher routes legal_order.status_changed", () => {
    const src = readFileSync(
      join(repo, "supabase/functions/outbox-dispatcher/index.ts"),
      "utf8",
    );
    expect(src).toMatch(/"legal_order\.status_changed"\s*:/);
    expect(src).toMatch(/legal_order_check_finance_drift/);
    expect(src).toMatch(/legal_order_notify_employee/);
  });

  it("ADR-0094 documents the event integration contract", () => {
    const adr = readFileSync(
      join(repo, "docs/adr/0094-legal-order-event-integration.md"),
      "utf8",
    );
    expect(adr).toMatch(/legal_order\.status_changed/);
    expect(adr).toMatch(/legal_order\.payment_posted/);
    expect(adr).toMatch(/finance\.drift_checker/);
    expect(adr).toMatch(/ess\.employee_notifier/);
  });
});
