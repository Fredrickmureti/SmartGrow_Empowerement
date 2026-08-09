/**
 * Architecture guard — Sales Order domain governance (convergence Phases 1–5).
 *
 * The Sales Order is a commercial commitment: it posts no GL, inventory moves
 * only at delivery, and every state transition is owned by the database.
 *
 * Confirms:
 *  1. Creation goes through `create_sales_order_atomic` — no client insert into
 *     `sales_orders` / `sales_order_items`, and no client-minted number.
 *  2. Cancellation goes through `cancel_sales_order_atomic` — the client never
 *     writes `status` on `sales_orders`.
 *  3. Delivery notes for an order are created by
 *     `create_delivery_from_sales_order_atomic` — no client header+lines insert.
 *  4. Fulfilment / billing quantities are read from `so_line_balances`; app code
 *     does not re-sum SO, DN or invoice lines, and never writes the quantity
 *     ledger columns.
 *  5. Backorders are derived (`so_backorder_lines`); nothing writes the legacy
 *     `backorders` table or `quantity_backordered`.
 *  6. Every sales-order status string used in app code exists in the DB CHECK
 *     vocabulary.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const appFiles = walk(ROOT).filter(
  (f) =>
    !f.includes("__tests__") &&
    !f.includes(`${join("src", "test")}`) &&
    !/\.test\.(ts|tsx)$/.test(f) &&
    !f.endsWith(join("integrations", "supabase", "types.ts")),
);

const read = (f: string) => readFileSync(f, "utf8");

/** The legal vocabulary — mirrors `sales_orders_status_check`. */
const SO_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "confirmed",
  "processing",
  "partial",
  "fulfilled",
  "invoiced",
  "cancelled",
];

describe("Sales Order — DB-owned lifecycle", () => {
  it("creates orders only through create_sales_order_atomic", () => {
    const offenders: string[] = [];
    for (const f of appFiles) {
      const src = read(f);
      if (
        /\.from\(\s*["'](sales_orders|sales_order_items)["']/.test(src) &&
        /\.insert\(/.test(src)
      ) {
        // allow only when the insert belongs to a different table in the file
        const blocks = src.split(/\.from\(/).slice(1);
        for (const b of blocks) {
          if (
            /^\s*["'](sales_orders|sales_order_items)["']/.test(b) &&
            /^[^]{0,600}\.insert\(/.test(b.split(".from(")[0])
          ) {
            offenders.push(f);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never writes sales_orders.status from the client", () => {
    const offenders: string[] = [];
    for (const f of appFiles) {
      const src = read(f);
      const blocks = src.split(/\.from\(\s*["']sales_orders["']\s*\)/).slice(1);
      for (const b of blocks) {
        const scope = b.slice(0, 500);
        if (/\.update\(\s*\{[^}]*\bstatus\s*:/s.test(scope)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses the atomic cancel and delivery RPCs", () => {
    const hook = read(join(ROOT, "hooks", "useSalesOrders.ts"));
    expect(hook).toContain("cancel_sales_order_atomic");
    expect(hook).toContain("create_delivery_from_sales_order_atomic");
    expect(hook).toContain("create_sales_order_atomic");
    // the old client-side DN header+lines insert is gone
    expect(hook).not.toMatch(/\.from\(\s*["']delivery_note_items["']\s*\)\s*\.insert/);
  });

  it("edits orders through update_sales_order_atomic, preserving the line ledger", () => {
    const page = read(join(ROOT, "features", "sales", "orders", "SalesOrderEditPage.tsx"));
    expect(page).toContain("update_sales_order_atomic");
    // delete-then-reinsert wipes quantity_fulfilled / quantity_invoiced and the
    // invoice_items provenance links; it must never come back.
    expect(page).not.toMatch(/\.from\(\s*["']sales_order_items["']\s*\)\s*\.delete/);
  });

  it("moves approval transitions into set_sales_order_approval_state_atomic", () => {
    const hook = read(join(ROOT, "hooks", "useSalesOrderApproval.ts"));
    expect(hook).toContain("set_sales_order_approval_state_atomic");
    expect(hook).toContain("confirm_sales_order_atomic");
  });
});


describe("Sales Order — quantity ledger is the single source of truth", () => {
  it("never writes the ledger columns from the client", () => {
    const forbidden = /\b(quantity_invoiced|quantity_cancelled|quantity_backordered|quantity_fulfilled)\s*:/;
    const offenders = appFiles.filter((f) => {
      const src = read(f);
      if (!forbidden.test(src)) return false;
      return /\.update\(|\.insert\(|\.upsert\(/.test(src) && /sales_order_items/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("reads fulfilment progress from so_line_balances", () => {
    const consumers = [
      join(ROOT, "pages", "SalesOrders.tsx"),
      join(ROOT, "hooks", "useSalesOrders.ts"),
    ];
    for (const f of consumers) {
      expect(read(f)).toContain("so_line_balances");
    }
  });
});

describe("Sales Order — one backorder engine", () => {
  it("derives backorders from the ledger view and never writes the legacy table", () => {
    const hook = read(join(ROOT, "hooks", "useBackorders.ts"));
    expect(hook).toContain("so_backorder_lines");
    expect(hook).not.toMatch(/\.from\(\s*["']backorders["']/);
    expect(hook).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it("no app file writes the backorders table", () => {
    const offenders = appFiles.filter((f) => {
      const src = read(f);
      const blocks = src.split(/\.from\(\s*["']backorders["']/).slice(1);
      return blocks.some((b) => /\.(insert|update|delete|upsert)\(/.test(b.slice(0, 400)));
    });
    expect(offenders).toEqual([]);
  });
});

describe("Sales Order — status vocabulary", () => {
  it("app code only uses statuses the CHECK constraint permits", () => {
    const files = appFiles.filter((f) => /SalesOrder|sales-order|salesOrder/i.test(f));
    const illegal = new Set<string>();
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/status\s*(?:===|!==|:)\s*["']([a-z_]+)["']/g)) {
        const v = m[1];
        if (!SO_STATUSES.includes(v)) illegal.add(`${v} (${f})`);
      }
    }
    expect([...illegal]).toEqual([]);
  });
});
