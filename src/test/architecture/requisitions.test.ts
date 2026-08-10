/**
 * Architecture guard — Purchase Requisition demand engine.
 *
 * The requisition domain is demand-origin: the database owns every
 * lifecycle column (`status`, `quantity_ordered`, `quantity_received`,
 * `quantity_cancelled`, `version`, approval stamps) through the
 * `create_purchase_requisition` / `submit_requisition` / `approve_requisition`
 * / `requisition_amend` / `requisition_close*` RPC family and `_pr_recalc`.
 *
 * This guard fails if UI or service code:
 *   1. writes those columns straight into `purchase_requisitions` /
 *      `purchase_requisition_items` via PostgREST, or
 *   2. re-derives procurement/fulfilment progress from purchase orders or
 *      goods receipts instead of the line rollup columns, or
 *   3. calls a requisition RPC outside the single wrapper module.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { globSync } from "glob";
import path from "path";

const ROOT = process.cwd();
const WRAPPER = "src/features/purchases/requisitions/requisitionRpcs.ts";

const SOURCES = globSync("src/**/*.{ts,tsx}", { cwd: ROOT }).filter(
  (f) => !f.includes("__tests__") && !f.includes("/test/"),
);

function read(f: string) {
  return readFileSync(path.join(ROOT, f), "utf8");
}

const LIFECYCLE_COLUMNS = [
  "quantity_ordered",
  "quantity_received",
  "quantity_cancelled",
  "approved_at",
  "submitted_at",
  "closed_at",
];

describe("purchase requisitions — demand engine boundary", () => {
  it("never writes requisition tables directly through PostgREST", () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const src = read(f);
      if (!src.includes("purchase_requisition")) continue;
      const writes = /\.from\(\s*["'`]purchase_requisitions?(_items)?["'`]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/g;
      if (writes.test(src)) offenders.push(f);
    }
    expect(offenders, "requisition writes must go through the lifecycle RPCs").toEqual([]);
  });

  it("only the wrapper module calls requisition_* RPCs", () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      if (f === WRAPPER) continue;
      const src = read(f);
      if (
        /\.rpc\(\s*["'`](requisition_[a-z_]+|create_purchase_requisition|submit_requisition|approve_requisition|reject_requisition|cancel_requisition)["'`]/.test(
          src,
        )
      ) {
        offenders.push(f);
      }
    }
    expect(offenders, `requisition RPCs must be called from ${WRAPPER}`).toEqual([]);
  });

  it("exposes short-close wrappers for outstanding demand", () => {
    const src = read(WRAPPER);
    expect(src).toContain("requisition_close_line");
    expect(src).toContain("requisition_close");
  });

  it("delegates purchasing self-action decisions to canonical governance", () => {
    const sql = globSync("supabase/migrations/*.sql", { cwd: ROOT })
      .map((f) => read(f))
      .join("\n");
    for (const action of ["requisition.approve", "rfq.approve", "rfq.award", "purchase_order.approve", "bill.approve"]) {
      expect(sql).toMatch(
        new RegExp(`governance_assert_not_self[\\s\\S]{0,500}?["']${action.replace(".", "\\.")}["']`, "i"),
      );
    }
    const latest = read(
      globSync("supabase/migrations/*.sql", { cwd: ROOT })
        .sort()
        .at(-1) ?? "",
    );
    expect(latest).not.toMatch(/Segregation of duties:|requester cannot approve|cannot approve.*you submitted/i);
  });

  it("reads progress from the line rollup columns, not re-summed POs", () => {
    const src = read("src/features/purchases/requisitions/useRequisitions.ts");
    for (const col of ["quantity_ordered", "quantity_received", "quantity_cancelled"]) {
      expect(src, `rollup must select ${col}`).toContain(col);
    }
    // Reading PO/RFQ headers for the traceability panel is fine; deriving the
    // ordered/received rollup from `purchase_order_items` is not — `_pr_recalc`
    // owns that arithmetic (it also excludes cancelled POs, which the browser
    // has no way of knowing).
    const poSelect = src.match(
      /\.from\(\s*["'`]purchase_order_items["'`]\s*\)[\s\S]{0,200}?\.select\(([\s\S]{0,200}?)\)/,
    );
    if (poSelect) {
      expect(
        /quantity_ordered|quantity_received|received_quantity/.test(poSelect[1]),
        "requisition progress must not be re-summed from purchase order lines",
      ).toBe(false);
    }
  });


  it("does not hand-roll lifecycle column mutations anywhere in the UI", () => {
    const offenders: string[] = [];
    for (const f of SOURCES.filter((f) => f.includes("features/purchases/requisitions"))) {
      const src = read(f);
      for (const col of LIFECYCLE_COLUMNS) {
        if (new RegExp(`${col}\\s*:\\s*[^,}\\n]+`).test(src) && /\.update\(|\.insert\(/.test(src)) {
          offenders.push(`${f} (${col})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
