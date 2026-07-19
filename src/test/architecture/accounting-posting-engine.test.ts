/**
 * B6 architecture guard — Single Accounting Posting Engine.
 *
 * Enforces the invariants documented in .lovable/plan.md §6:
 *   1. No new producer-specific `retry_*_posting` RPC may exist. The
 *      only valid manual retry verb is `accounting_post_event`.
 *   2. Producer-specific GL posters (`post_*_gl`) may still exist as
 *      internal builders, but MUST be reachable only via the engine.
 *      The outbox dispatcher may reference `accounting_post_event`
 *      and MUST NOT reference `post_pos_statement_gl` directly.
 *   3. Non-admin UI surfaces must not read `business_event_outbox`.
 *      Only allow-listed admin/support pages may do so.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function rgFiles(pattern: string, path: string): string[] {
  try {
    return execSync(`rg -l ${JSON.stringify(pattern)} ${path}`, {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe("Accounting Posting Engine — B6 architectural surface", () => {
  it("legacy retry_pos_statement_posting RPC has been dropped and not recreated", () => {
    // Historical CREATE OR REPLACE statements in old migrations are OK
    // (immutable history); the invariant is that the most recent
    // migration touching this symbol is the B6 DROP.
    const files = rgFiles(
      "retry_pos_statement_posting",
      "supabase/migrations",
    ).sort();
    const latest = files[files.length - 1];
    expect(latest).toBeTruthy();
    const sql = readFileSync(latest, "utf8");
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.retry_pos_statement_posting/,
    );
  });

  it("dispatcher calls the engine, not the producer-specific poster", () => {
    const dispatcher = readFileSync(
      "supabase/functions/outbox-dispatcher/index.ts",
      "utf8",
    );
    expect(dispatcher).toMatch(/accounting_post_event/);
    expect(dispatcher).not.toMatch(/post_pos_statement_gl/);
  });

  it("POS statement close trigger emits accounting_event_id in outbox payload", () => {
    const migrations = rgFiles(
      "_pos_stmt_enqueue_gl_post",
      "supabase/migrations",
    ).sort();
    const latest = migrations[migrations.length - 1];
    expect(latest).toBeTruthy();
    const sql = readFileSync(latest, "utf8");
    expect(sql).toMatch(/accounting_event_id/);
    expect(sql).toMatch(/business_idempotency_key/);
  });

  it("non-admin UI does not read business_event_outbox directly", () => {
    const allow = new Set<string>([
      // Accountant-facing operational workspace: reads outbox only to
      // enrich the admin-collapsible "Delivery diagnostics" panel.
      "src/pages/finance/AccountingEventsWorkspace.tsx",
      // Admin-only hardware / ops surface.
      "src/pages/admin/HardwareOpsPage.tsx",
      // Payroll admin control-center / lifecycle timeline: pre-existing
      // admin surfaces that render workflow events. Not accountant-facing.
      "src/pages/hr/payroll/PayrollControlCenter.tsx",
      "src/components/payroll/PayrollRunLifecycleTimeline.tsx",
      // Infrastructure — not a UI surface.
      "src/services/events/BusinessSaga.ts",
      "src/services/events/domainEventBus.ts",
    ]);
    // Only match actual PostgREST reads, not comments/documentation.
    const files = rgFiles(
      "\\.from\\((\"|')business_event_outbox",
      "src",
    );
    const offenders = files.filter((f) => {
      if (f.startsWith("src/test/")) return false;
      if (f.startsWith("src/__tests__/")) return false;
      if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) return false;
      if (f === "src/integrations/supabase/types.ts") return false;
      return !allow.has(f);
    });
    expect(offenders).toEqual([]);
  });
});
