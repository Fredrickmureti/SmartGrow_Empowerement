/**
 * Architecture guard — `check_warehouse_stock_alerts` must reference real
 * columns on `warehouse_stock`.
 *
 * Background regression: a migration introduced `v_ws.ws_reorder_level`,
 * but the actual column on `public.warehouse_stock` is `reorder_level`.
 * The trigger `trg_warehouse_stock_alerts` fires on every UPDATE OF quantity,
 * which made every stock adjustment fail with PG `42703` surfaced as HTTP
 * 400 from PostgREST. The latest definition of this function must:
 *   - NOT reference `ws_reorder_level` (a column that does not exist)
 *   - reference `v_ws.reorder_level` (per-warehouse threshold)
 *   - reference `v_product.reorder_level` (product-level fallback)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = "supabase/migrations";

function latestBody(fnName: string): { file: string; body: string } | null {
  const re = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${fnName}[\\s\\S]*?\\$(?:function)?\\$([\\s\\S]*?)\\$(?:function)?\\$\\s*;`,
    "gi",
  );
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(MIG_DIR, files[i]), "utf8");
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    const r = new RegExp(re);
    while ((m = r.exec(sql))) matches.push(m[1]);
    if (matches.length > 0) {
      return { file: files[i], body: matches[matches.length - 1] };
    }
  }
  return null;
}

describe("check_warehouse_stock_alerts column references", () => {
  const latest = latestBody("check_warehouse_stock_alerts");

  it("must be defined in some migration", () => {
    expect(latest).not.toBeNull();
  });

  it("must NOT reference the non-existent ws_reorder_level column", () => {
    if (!latest) return;
    expect(
      /ws_reorder_level/.test(latest.body),
      `${latest.file}: check_warehouse_stock_alerts references ws_reorder_level, ` +
        `which does not exist on warehouse_stock. Use reorder_level instead.`,
    ).toBe(false);
  });

  it("must read the per-warehouse threshold from v_ws.reorder_level", () => {
    if (!latest) return;
    expect(
      /v_ws\.reorder_level/.test(latest.body),
      `${latest.file}: check_warehouse_stock_alerts must read v_ws.reorder_level ` +
        `(per-warehouse threshold).`,
    ).toBe(true);
  });

  it("must fall back to v_product.reorder_level", () => {
    if (!latest) return;
    expect(
      /v_product\.reorder_level/.test(latest.body),
      `${latest.file}: check_warehouse_stock_alerts must fall back to ` +
        `v_product.reorder_level when the per-warehouse value is absent.`,
    ).toBe(true);
  });
});
