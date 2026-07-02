/**
 * Architecture guard — Inventory write-side branch stamping.
 *
 * Every .from(<inventory-table>).insert(...) in src/hooks or src/pages MUST
 * include the appropriate branch identity column in the payload so the row
 * is bound to a branch from creation:
 *
 *   - `stock_transfers` requires `from_branch_id` AND `to_branch_id`.
 *   - All other branch-bearing inventory tables require `branch_id`.
 *
 * Note: `stock_movements` has a DB trigger that derives `branch_id` from the
 * warehouse, but the code still passes `branch_id` explicitly (often `null`
 * to opt into the trigger). Either is acceptable — what we forbid is omitting
 * the key entirely, which would let a row land branch-less by accident.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SINGLE_BRANCH_TABLES = [
  "warehouses",
  "warehouse_stock",
  "stock_movements",
  "stock_adjustments",
  "stock_adjustment_items",
  "stock_reservations",
  "product_reorder_rules",
] as const;

const TRANSFER_TABLE = "stock_transfers";

const SCOPES = ["src/hooks", "src/pages"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function buildInsertRegex(tables: readonly string[]): RegExp {
  const union = tables.map((t) => `["']${t}["']`).join("|");
  return new RegExp(
    `\\.from\\(\\s*(?:${union})\\s*\\)[\\s\\S]{0,1500}?\\.insert\\(\\s*([\\s\\S]{0,2000}?)\\)`,
    "g",
  );
}

describe("inventory module — write-side branch identity stamping", () => {
  it("every insert() into a branch-bearing inventory table includes branch_id", () => {
    const re = buildInsertRegex(SINGLE_BRANCH_TABLES);
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const rel = file.replace(/\\/g, "/");
        const src = readFileSync(file, "utf8");
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(src)) !== null) {
          const payload = m[1] ?? "";
          if (!/branch_id\s*:/.test(payload) && !/\.\.\.\s*\w+/.test(payload)) {
            offenders.push(`${rel}: insert() near char ${m.index} missing branch_id`);
          }
        }
      }
    }
    expect(
      offenders,
      `Inventory writes must stamp branch_id (use parent row's branch_id, ` +
        `currentBranch?.id, or null to defer to a DB trigger).\n\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("every insert() into stock_transfers includes from_branch_id and to_branch_id", () => {
    const re = buildInsertRegex([TRANSFER_TABLE]);
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const rel = file.replace(/\\/g, "/");
        const src = readFileSync(file, "utf8");
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(src)) !== null) {
          const payload = m[1] ?? "";
          const hasFrom = /from_branch_id\s*:/.test(payload) || /\.\.\.\s*\w+/.test(payload);
          const hasTo = /to_branch_id\s*:/.test(payload) || /\.\.\.\s*\w+/.test(payload);
          if (!hasFrom || !hasTo) {
            offenders.push(
              `${rel}: stock_transfers insert near char ${m.index} missing ` +
                `${!hasFrom ? "from_branch_id " : ""}${!hasTo ? "to_branch_id" : ""}`,
            );
          }
        }
      }
    }
    expect(
      offenders,
      `stock_transfers writes must stamp BOTH from_branch_id and to_branch_id ` +
        `derived from the source/destination warehouse.\n\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
