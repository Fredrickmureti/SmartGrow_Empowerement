/**
 * S5 architecture guard — POS statement-centric GL posting.
 *
 * Pins the S5 migration so no downstream change can:
 *   1. Re-introduce a direct INSERT INTO journal_entries from the per-sale
 *      poster (`post_pos_sale_gl`) — it must remain shadow-only.
 *   2. Skip the outbox: statement close MUST enqueue
 *      `pos.statement.posting.requested`. Synchronous coupling of cashier
 *      commit to finance write is the exact drift S5 removes.
 *   3. Remove the idempotency log — a statement re-posted after retry must
 *      collapse to a single journal entry.
 *   4. Delete the drift view before finance sign-off.
 *   5. Delete the outbox handler wiring in the dispatcher (would silently
 *      leave every statement `pending` forever).
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function latestMigrationWith(pattern: string): string {
  const out = execSync(
    `rg -l ${JSON.stringify(pattern)} supabase/migrations`,
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  const last = out[out.length - 1];
  if (!last) throw new Error(`no migration contains ${pattern}`);
  return last;
}

describe("POS statement-centric GL posting — S5 architectural surface", () => {
  const sql = readFileSync(
    latestMigrationWith("CREATE OR REPLACE FUNCTION public.post_pos_statement_gl"),
    "utf8",
  );

  it("post_pos_statement_gl is SECURITY DEFINER with public search_path", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.post_pos_statement_gl/);
    expect(sql).toMatch(/SECURITY DEFINER[\s\S]{0,120}SET search_path = public/);
  });

  it("post_pos_statement_gl calls resolve_pos_tender_gl_account (single tender resolver)", () => {
    expect(sql).toMatch(/resolve_pos_tender_gl_account\(/);
  });

  it("post_pos_statement_gl enforces a balance check before insert", () => {
    expect(sql).toMatch(/unbalanced entry for statement/);
  });

  it("per-sale poster is demoted to shadow — no direct journal_entries insert", () => {
    // Extract post_pos_sale_gl body and assert it never inserts into JE.
    const body = sql.split(/CREATE OR REPLACE FUNCTION public\.post_pos_sale_gl/)[1] ?? "";
    const end = body.indexOf("$fn$;");
    const scoped = end >= 0 ? body.slice(0, end) : body;
    expect(scoped).not.toMatch(/INSERT\s+INTO\s+public\.journal_entries/i);
    expect(scoped).toMatch(/INSERT INTO public\.pos_gl_shadow_postings/);
  });

  it("statement close enqueues pos.statement.posting.requested on the outbox", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\._pos_stmt_enqueue_gl_post/);
    expect(sql).toMatch(/'pos\.statement\.posting\.requested'/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OF closed_at, posting_status ON public\.pos_statements/);
  });

  it("historical backfills are excluded from the outbox enqueue", () => {
    expect(sql).toMatch(/close_kind\s*<>\s*'historical_backfill'::pos_statement_close_kind/);
  });

  it("idempotency log prevents double-posting the same statement", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.pos_statement_gl_apply_log/);
    expect(sql).toMatch(/UNIQUE\s*\(statement_id,\s*idempotency_key\)/);
  });

  it("drift reconciliation view is created and readable by authenticated", () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.v_pos_gl_posting_drift/);
    expect(sql).toMatch(/GRANT SELECT ON public\.v_pos_gl_posting_drift TO authenticated/);
  });

  it("outbox topic pos.statement.posting.requested is registered with server scope", () => {
    expect(sql).toMatch(/'pos\.statement\.posting\.requested'[\s\S]{0,300}'server'/);
  });

  it("outbox dispatcher routes POS statement posting through the single Accounting Posting Engine (B6)", () => {
    const dispatcher = readFileSync(
      "supabase/functions/outbox-dispatcher/index.ts",
      "utf8",
    );
    expect(dispatcher).toMatch(/handlePosStatementPostingRequested/);
    expect(dispatcher).toMatch(/"pos\.statement\.posting\.requested"/);
    // B6: dispatcher must NOT call producer-specific writers; only the
    // engine + typed AccountingPostingResult.
    expect(dispatcher).toMatch(/accounting_post_event/);
    expect(dispatcher).not.toMatch(/post_pos_statement_gl/);
  });
});
