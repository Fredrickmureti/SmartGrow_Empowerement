/**
 * Architecture guard — Physical Count is a lifecycle-managed business event.
 *
 * Confirms:
 *  1. The counting page hits the shim RPC (`apply_physical_count_atomic`) OR
 *     one of the new lifecycle RPCs. It must not write to
 *     `stock_adjustments`, `stock_movements`, or `journal_entries` directly.
 *  2. The workspace page only calls the lifecycle RPCs, never mutates the
 *     ledger tables from the client.
 *  3. No file under `src/` posts a JE with `source_type='physical_count'` on
 *     its own — that source type is deprecated in favour of
 *     `inventory_adjustment` + `source_subtype='physical_count'`, produced
 *     by the D2 `physical_count_post` RPC.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const ALL = walk(ROOT);

describe("Physical Count business event", () => {
  it("counting page never writes to stock_adjustments/stock_movements/journal_entries directly", () => {
    const src = readFileSync(join(ROOT, "pages/inventory/PhysicalCount.tsx"), "utf8");
    const forbidden = [
      /\.from\(["']stock_adjustments["']\)\s*\.insert/,
      /\.from\(["']stock_adjustment_items["']\)\s*\.insert/,
      /\.from\(["']stock_movements["']\)\s*\.insert/,
      /\.from\(["']journal_entries["']\)\s*\.insert/,
      /\.from\(["']journal_entry_lines["']\)\s*\.insert/,
    ];
    for (const rx of forbidden) {
      expect(src, `PhysicalCount.tsx must not write directly: ${rx}`).not.toMatch(rx);
    }
  });

  it("workspace page uses only lifecycle RPCs, never direct writes", () => {
    const src = readFileSync(
      join(ROOT, "pages/inventory/PhysicalCountWorkspace.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/\.from\(["']stock_adjustments["']\)\s*\.insert/);
    expect(src).not.toMatch(/\.from\(["']journal_entries["']\)\s*\.insert/);
    // Must reference the lifecycle RPCs
    expect(src).toMatch(/physical_count_(freeze|submit|approve|post|cancel)/);
  });

  it("no file emits a journal entry with source_type='physical_count' (deprecated)", () => {
    const offenders: string[] = [];
    for (const file of ALL) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const src = readFileSync(file, "utf8");
      if (
        /source_type\s*:\s*['"]physical_count['"]/.test(src) &&
        /from\(["']journal_entries["']\)\s*\.insert/.test(src)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no client code calls the retired apply_physical_count_atomic shim", () => {
    const offenders: string[] = [];
    for (const file of ALL) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      if (file.endsWith("integrations/supabase/types.ts")) continue; // auto-generated
      const src = readFileSync(file, "utf8");
      if (/apply_physical_count_atomic/.test(src)) offenders.push(file);
    }
    expect(offenders, `The shim is retired; use physical_count_* lifecycle RPCs.\n${offenders.join("\n")}`).toEqual([]);
  });

  it("detail workspace consumes the server-side preflight and JE preview", () => {
    const src = readFileSync(join(ROOT, "pages/inventory/PhysicalCountDetail.tsx"), "utf8");
    expect(src).toMatch(/physical_count_preflight/);
    expect(src).toMatch(/physical_count_preview_je/);
    expect(src).toMatch(/tolerance_flags|tolerance_override_reason/);
  });

  it("client lifecycle calls do NOT pass p_allow_self (SoD is decided server-side)", () => {
    // The governed lifecycle RPCs now have a single signature each — the
    // ambiguous overload pair that once required p_allow_self to disambiguate
    // has been dropped. Separation-of-duties is enforced entirely server-side
    // by governance_assert_not_self (governance_mode + self_action_policy +
    // overrides). Sending p_allow_self from the client is dead weight and is
    // forbidden so the browser can never claim to bypass SoD.
    const files = [
      join(ROOT, "pages/inventory/PhysicalCount.tsx"),
      join(ROOT, "pages/inventory/PhysicalCountWorkspace.tsx"),
      join(ROOT, "pages/inventory/PhysicalCountDetail.tsx"),
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const callsLifecycle = /physical_count_(submit|approve|post)/.test(src);
      if (!callsLifecycle) continue;
      expect(src, `${file} must NOT send p_allow_self — SoD is server-side`).not.toMatch(
        /p_allow_self\s*:/,
      );
    }
  });

  it("latest physical_count_post migration delegates GL posting to approve_stock_adjustment_atomic and never writes generated columns", () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .reverse();
    const latestPost = files.find((file) => {
      const src = readFileSync(join(MIGRATIONS, file), "utf8");
      return /CREATE OR REPLACE FUNCTION public\.physical_count_post\s*\(/.test(src);
    });
    expect(latestPost, "physical_count_post migration must exist").toBeTruthy();
    const src = readFileSync(join(MIGRATIONS, latestPost!), "utf8");

    // Delegates to the standard adjustment RPC (ADR 0016).
    expect(src, "physical_count_post must delegate to approve_stock_adjustment_atomic")
      .toMatch(/approve_stock_adjustment_atomic\s*\(/);

    // Must never write variance_qty — it is a GENERATED column.
    expect(src, "physical_count_post must not write variance_qty").not.toMatch(
      /variance_qty\s*=(?!\s*EXCLUDED)/,
    );

    // Must not hand-roll a journal entry (that path bypasses ADR 0016 invariants).
    expect(src, "physical_count_post must not insert journal_entries directly")
      .not.toMatch(/INSERT\s+INTO\s+public\.journal_entries\b/i);
    expect(src, "physical_count_post must not insert journal_entry_lines directly")
      .not.toMatch(/INSERT\s+INTO\s+public\.journal_entry_lines\b/i);

    // Idempotency: retried POST must reuse the same stock_adjustment row.
    expect(src, "physical_count_post must use client_request_id for idempotency")
      .toMatch(/client_request_id/);

    // The count's own reconciliation adjustment must be exempted from its own
    // freeze via the transaction-local override GUC, otherwise the delegated
    // approve call raises E_PC_WAREHOUSE_FROZEN on its own stock_movements insert.
    expect(
      src,
      "physical_count_post must wrap approve_stock_adjustment_atomic in a txn-local freeze override",
    ).toMatch(/set_config\(\s*'app\.physical_count_freeze_override'/);
  });


  it("latest physical-count governance migration removes stale inline SoD overloads", () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .reverse();
    const latestGovernanceFix = files.find((file) => {
      const src = readFileSync(join(MIGRATIONS, file), "utf8");
      return /physical_count_(submit|approve|post)/.test(src) && /governance|compatibility/i.test(src);
    });
    expect(latestGovernanceFix).toBeTruthy();
    const src = readFileSync(join(MIGRATIONS, latestGovernanceFix!), "utf8");
    expect(src).toMatch(/governance_assert_not_self|RETURN public\.physical_count_(submit|approve|post)/);
    expect(src).not.toMatch(/segregation of duties/);
  });
});

