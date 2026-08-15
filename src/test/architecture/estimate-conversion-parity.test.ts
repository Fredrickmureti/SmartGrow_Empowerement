/**
 * Architecture guard — Estimate conversion & lifecycle invariants (ADR: Estimate
 * lifecycle convergence, Phase 6).
 *
 * A quotation is a commercial offer; converting it to a Sales Order or Invoice is
 * the moment the offer becomes an executable document. Those RPCs are the only
 * bridge between the two worlds, so their invariants are policed here at build
 * time — a future migration that re-writes them without these guarantees fails CI.
 *
 * Invariants:
 *  1. Double conversion is impossible (forward pointer checked before insert).
 *  2. The estimate total must reconcile before anything is written.
 *  3. Additional costs are materialised as document lines (never silently dropped).
 *  4. UoM/packaging provenance is carried line-for-line.
 *  5. The forward pointer is recorded on the estimate.
 *  6. Status is moved through the writer token, and an audit event is written.
 *  7. No reference to the phantom `valid_until` column ever returns.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";

const MIGRATIONS_DIR = "supabase/migrations";

function migrationFilesSorted(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));
}

/** Body of the LAST definition of `fn` across all migrations (= live definition). */
function latestFunctionBody(fn: string): string {
  const head = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`,
    "i",
  );
  let body = "";
  for (const file of migrationFilesSorted()) {
    const sql = readFileSync(file, "utf8");
    const m = head.exec(sql);
    if (!m) continue;
    // Take from the last definition in this file to the end of its dollar-quoted body.
    let from = 0;
    let idx = -1;
    for (;;) {
      const next = sql.slice(from).search(head);
      if (next === -1) break;
      idx = from + next;
      from = idx + 1;
    }
    const rest = sql.slice(idx);
    const tag = /\$(function|)\$/.exec(rest);
    if (!tag) continue;
    const open = rest.indexOf(tag[0]);
    const close = rest.indexOf(tag[0], open + tag[0].length);
    body = close === -1 ? rest : rest.slice(0, close + tag[0].length);
  }
  return body;
}

const UOM_COLUMNS = ["packaging_id", "display_uom_id", "display_quantity", "uom_snapshot"];

describe("estimate conversion parity", () => {
  const invoiceFn = latestFunctionBody("convert_estimate_to_invoice_atomic");
  const soFn = latestFunctionBody("convert_estimate_to_so_atomic");

  it("both conversion RPCs are defined in migrations", () => {
    expect(invoiceFn.length).toBeGreaterThan(500);
    expect(soFn.length).toBeGreaterThan(500);
  });

  it("never converts twice — a repeat replays the existing document", () => {
    // Phase 10: a second conversion must not create a second document. It now
    // returns the one already pointed at by the estimate (idempotent replay)
    // instead of raising, so a double click or retry is harmless.
    expect(invoiceFn).toMatch(/converted_invoice_id\s+IS NOT NULL/i);
    expect(invoiceFn).toMatch(/idempotent_replay/i);
    expect(soFn).toMatch(/converted_sales_order_id\s+IS NOT NULL/i);
    expect(soFn).toMatch(/idempotent_replay/i);
  });

  it("rejects conversion from terminal / illegal statuses", () => {
    for (const fn of [invoiceFn, soFn]) {
      expect(fn).toMatch(/status NOT IN \('draft','sent','viewed','accepted'\)/i);
    }
  });

  it("asserts the estimate total reconciles before writing", () => {
    for (const fn of [invoiceFn, soFn]) {
      expect(fn).toMatch(/totals do not reconcile/i);
      expect(fn).toMatch(/RAISE EXCEPTION/i);
    }
  });

  it("materialises estimate_additional_costs as document lines", () => {
    for (const fn of [invoiceFn, soFn]) {
      const occurrences = fn.match(/estimate_additional_costs/gi) ?? [];
      // once to sum into the subtotal, once to insert the lines
      expect(occurrences.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("carries UoM / packaging provenance line-for-line", () => {
    for (const fn of [invoiceFn, soFn]) {
      for (const col of UOM_COLUMNS) {
        expect(fn, `missing ${col}`).toContain(col);
      }
    }
  });

  it("records the forward pointer on the estimate", () => {
    expect(invoiceFn).toMatch(/converted_invoice_id\s*=\s*v_inv_id/i);
    expect(soFn).toMatch(/converted_sales_order_id\s*=\s*v_so_id/i);
    expect(invoiceFn).toMatch(/source_estimate_id/i);
    expect(soFn).toMatch(/source_estimate_id/i);
  });

  it("moves status through the writer token and writes an audit event", () => {
    for (const fn of [invoiceFn, soFn]) {
      expect(fn).toMatch(/app\.estimate_status_writer/);
      expect(fn).toMatch(/INSERT INTO public\.estimate_status_events/i);
    }
  });

  it("never references the phantom valid_until column", () => {
    for (const fn of [invoiceFn, soFn]) {
      expect(fn).not.toMatch(/\bvalid_until\b/);
    }
  });
});

describe("estimate state machine", () => {
  const fn = latestFunctionBody("set_estimate_status_atomic");
  const guard = latestFunctionBody("_estimate_status_write_guard");
  const expire = latestFunctionBody("expire_stale_estimates");

  it("is the single writer, protected by a trigger guard", () => {
    expect(guard).toMatch(/app\.estimate_status_writer/);
    expect(guard).toMatch(/RAISE EXCEPTION/i);
    expect(fn).toMatch(/app\.estimate_status_writer/);
  });

  it("encodes the legal transition table", () => {
    for (const to of ["sent", "viewed", "accepted", "rejected", "expired", "converted"]) {
      expect(fn, `transition to ${to} missing`).toContain(to);
    }
    expect(fn).toMatch(/RAISE EXCEPTION/i);
  });

  it("stamps lifecycle timestamps", () => {
    for (const ts of ["sent_at", "viewed_at", "accepted_at", "rejected_at"]) {
      expect(fn, `missing ${ts}`).toContain(ts);
    }
  });

  it("writes an audit row for every transition", () => {
    expect(fn).toMatch(/INSERT INTO public\.estimate_status_events/i);
  });

  it("expiry runs through the same state machine, only for live offers", () => {
    expect(expire).toMatch(/expiry_date/);
    expect(expire).toMatch(/'sent'|'viewed'/);
    expect(expire).toMatch(/set_estimate_status_atomic|estimate_status_writer/);
  });
});

describe("single conversion engine", () => {
  const files = globSync("src/**/*.{ts,tsx}", {
    ignore: ["src/test/**", "src/integrations/supabase/types.ts"],
  });

  it("no client code builds an invoice or sales order from an estimate itself", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const re =
        /\.from\(\s*["'`](invoices|sales_orders|invoice_items|sales_order_items)["'`]\s*\)[\s\S]{0,400}?\.insert\(([\s\S]{0,800}?)\)\s*\n?\s*[.;]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/source_estimate_id|estimate_id/.test(m[2])) offenders.push(`${file} -> ${m[1]}`);
      }
    }
    expect(
      offenders,
      `Estimate conversion must go through the atomic RPCs. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("conversion is invoked only from the estimates hook", () => {
    const callers = files.filter((f) =>
      /convert_estimate_to_(invoice|so)_atomic/.test(readFileSync(f, "utf8")),
    );
    expect(callers).toEqual(["src/hooks/useEstimates.ts"]);
  });
});
