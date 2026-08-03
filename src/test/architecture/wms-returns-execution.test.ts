/**
 * Returns audit, Phase 7.3 — functional guards for the returns execution RPCs.
 *
 * These assert the *contract* of the two functions that move stock and money,
 * read from the migration that owns each definition. They are the regression
 * net for behaviour that is invisible from the UI:
 *
 *  `wms_post_return_dispositions`
 *    - concurrency: row_version guard, `FOR UPDATE` on header and lines
 *    - state gate: only `received` / `inspecting` may post
 *    - movement balance: restock in, quarantine transfer, scrap out — every
 *      quantity lands in `stock_movements` referencing the return order
 *    - quarantine handling: an active `lot_quarantine` hold, created once
 *    - task spawning: putaway for restock, disposal for scrap, return task for
 *      `return_to_vendor`
 *    - exceptions: uncaptured / undispositioned lines block and raise
 *
 *  `wms_create_return_finance_doc`
 *    - idempotency: a linked finance document returns `created: false`
 *    - unposted rejection: every line must be posted first
 *    - kind routing: customer -> sales_return, vendor -> purchase_return,
 *      internal/transfer -> rejected
 *
 *  `wms_close_return`
 *    - close guard: unposted or undispositioned lines refuse closure
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");

/** Latest migration body that defines the given function. */
function latestDefinition(fn: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const re = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`,
    "i",
  );
  let body = "";
  for (const name of files) {
    const src = readFileSync(path.join(MIGRATIONS, name), "utf8");
    const m = re.exec(src);
    if (!m) continue;
    const start = m.index;
    // Take from the definition to the end of its dollar-quoted body.
    const rest = src.slice(start);
    const end = rest.indexOf("$function$", rest.indexOf("AS $"));
    body = end === -1 ? rest : rest.slice(0, end + 10);
    const alt = rest.indexOf("$$;", rest.indexOf("AS $$"));
    if (end === -1 && alt !== -1) body = rest.slice(0, alt + 3);
  }
  return body;
}

const POST = latestDefinition("wms_post_return_dispositions");
const FINANCE = latestDefinition("wms_create_return_finance_doc");
const CLOSE = latestDefinition("wms_close_return");

describe("wms_post_return_dispositions — execution contract", () => {
  it("is defined in a migration", () => {
    expect(POST.length).toBeGreaterThan(500);
  });

  it("is SECURITY DEFINER with a pinned search_path and an access check", () => {
    expect(POST).toMatch(/SECURITY DEFINER/i);
    expect(POST).toMatch(/SET search_path/i);
    expect(POST).toMatch(/user_can_access_business/);
  });

  it("guards concurrency with row_version and row locks", () => {
    expect(POST).toMatch(/row_version\s*<>\s*p_row_version/);
    expect(POST).toMatch(/40001/);
    expect((POST.match(/FOR UPDATE/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("only posts from received or inspecting", () => {
    expect(POST).toMatch(/state NOT IN \('received','inspecting'\)/);
  });

  it("balances every disposition quantity into stock_movements", () => {
    for (const type of ["return_in", "quarantine_hold", "scrap"]) {
      expect(POST, `${type} movement missing`).toContain(`'${type}'`);
    }
    expect((POST.match(/INSERT INTO public\.stock_movements/g) ?? []).length).toBe(3);
    // Inventory is the stock authority: movements are always tied back to the RMA.
    expect((POST.match(/'wms_return_order'/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("places quarantined lots on a single active hold", () => {
    expect(POST).toMatch(/INSERT INTO public\.lot_quarantine/);
    expect(POST).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.lot_quarantine/);
    expect(POST).toMatch(/q\.status = 'active'/);
  });

  it("spawns follow-up tasks for putaway, disposal and vendor return", () => {
    expect((POST.match(/INSERT INTO public\.wms_tasks/g) ?? []).length).toBe(3);
    expect(POST).toMatch(/'putaway'/);
    expect(POST).toMatch(/disposition = 'return_to_vendor'/);
    expect(POST).toMatch(/'return', 'available'/);
  });

  it("blocks and raises an exception instead of silently skipping a line", () => {
    expect(POST).toMatch(/wms_raise_exception/);
    expect(POST).toMatch(/blocked_reason\s*=\s*CASE WHEN/);
    expect(POST).toMatch(/warehouse\.return\.blocked/);
  });

  it("never marks the header posted while lines are blocked", () => {
    expect(POST).toMatch(/posted_at\s*=\s*CASE WHEN v_blocked = 0 THEN now\(\) ELSE posted_at END/);
  });

  it("emits the dispositions_posted event with an idempotency key", () => {
    expect(POST).toMatch(/warehouse\.return\.dispositions_posted/);
    expect(POST).toMatch(/'wms\.return:' \|\| v_ord\.id::text \|\| ':dispositions_posted:'/);
  });
});

describe("wms_create_return_finance_doc — handoff contract", () => {
  it("is defined, SECURITY DEFINER and access checked", () => {
    expect(FINANCE.length).toBeGreaterThan(500);
    expect(FINANCE).toMatch(/SECURITY DEFINER/i);
    expect(FINANCE).toMatch(/user_can_access_business/);
    expect(FINANCE).toMatch(/row_version\s*<>\s*p_row_version/);
  });

  it("is idempotent — an already linked return creates nothing", () => {
    expect(FINANCE).toMatch(/IF v_ord\.finance_doc_id IS NOT NULL THEN/);
    expect(FINANCE).toMatch(/'created', false/);
  });

  it("rejects unposted or empty returns", () => {
    expect(FINANCE).toMatch(/count\(\*\) FILTER \(WHERE posted_at IS NULL\)/);
    expect(FINANCE).toMatch(/post all dispositions before raising the finance document/);
    expect(FINANCE).toMatch(/return has no lines/);
  });

  it("routes by return kind and refuses kinds with no finance counterpart", () => {
    expect(FINANCE).toMatch(/return_kind = 'customer'/);
    expect(FINANCE).toMatch(/INSERT INTO public\.sales_returns/);
    expect(FINANCE).toMatch(/return_kind = 'vendor'/);
    expect(FINANCE).toMatch(/INSERT INTO public\.purchase_returns/);
    expect(FINANCE).toMatch(/internal and transfer returns have no finance counterpart/);
  });

  it("warehouse links value but never computes it — lines are raised at zero", () => {
    expect(FINANCE).toMatch(/subtotal, tax_amount, total/);
    expect(FINANCE).toMatch(/v_currency, 0, 0, 0/);
  });

  it("bumps row_version and emits finance_linked", () => {
    expect(FINANCE).toMatch(/v_new_version := v_ord\.row_version \+ 1/);
    expect(FINANCE).toMatch(/warehouse\.return\.finance_linked/);
  });
});

describe("wms_close_return — close guard", () => {
  it("refuses to close over undispositioned or unposted lines", () => {
    expect(CLOSE).toMatch(/disposition IS NULL OR l\.posted_at IS NULL/);
    expect(CLOSE).toMatch(/are not dispositioned and posted/);
    expect(CLOSE).toMatch(/wms_transition_return\(p_return_id, 'closed'/);
  });
});
