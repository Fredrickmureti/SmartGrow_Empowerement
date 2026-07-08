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
});

