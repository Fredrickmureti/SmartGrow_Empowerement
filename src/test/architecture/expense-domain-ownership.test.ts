/**
 * Ratchet — the expense domain owns no engine of its own.
 *
 * Phases 1-6 of the expense convergence established that:
 *
 *  1. Lifecycle state is server-owned — no client writes `status`,
 *     `journal_entry_id`, `approved_*`, `reimbursed_*` or `voided_*`
 *     on `expenses`; transitions go through the canonical RPCs.
 *  2. Posting is the Finance monopoly — no client code posts an
 *     expense journal itself; `post_expense_gl` is the only path and it
 *     runs through `post_journal_entry_atomic`.
 *  3. Approval routes through the governance engine, not a local
 *     approver table or a bespoke SoD check.
 *  4. Money-moving amounts (base_amount, exchange_rate, tax_amount) are
 *     derived server-side, never authored by the browser.
 *  5. Receipts live on `expense_attachments`, and the client never
 *     mutates that row set outside the canonical hook.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC).filter(
  (f) => !f.includes(join("src", "test")) && !f.includes("__tests__"),
);

/** Text of every `.from("expenses")` chain, capped at the following 400 chars. */
function expenseWrites(src: string): string[] {
  const re = /from\(\s*["'`]expenses["'`]\s*\)([\s\S]{0,400})/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

const SERVER_OWNED_COLUMNS = [
  "status",
  "journal_entry_id",
  "approval_request_id",
  "approved_by",
  "approved_at",
  "submitted_by",
  "submitted_at",
  "reimbursed_at",
  "reimbursed_by",
  "voided_at",
  "voided_by",
  "base_amount",
  "exchange_rate",
];

describe("expense domain — no local engine", () => {
  it("no client code authors server-owned expense columns", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const chain of expenseWrites(src)) {
        if (!/\.(insert|update|upsert)\s*\(/.test(chain)) continue;
        for (const column of SERVER_OWNED_COLUMNS) {
          if (new RegExp(`\\b${column}\\s*:`).test(chain)) {
            offenders.push(`${file} → ${column}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("expense lifecycle transitions use the canonical RPCs", () => {
    const RETIRED = [
      "approve_expense(",
      "reject_expense(",
      "void_expense(",
      "expense_post_gl(",
    ];
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const symbol of RETIRED) {
        if (src.includes(symbol)) offenders.push(`${file} → ${symbol}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no client code posts expense journals directly", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      if (!/expense/i.test(src)) continue;
      if (/from\(\s*["'`]journal_entry_lines["'`]\s*\)[\s\S]{0,200}\.insert\s*\(/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the expense module defines no separate approval or SoD engine", () => {
    const BANNED = [
      "expense_approvers",
      "expense_approval_rules",
      "expense_sod",
    ];
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const token of BANNED) {
        if (src.includes(token)) offenders.push(`${file} → ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("expense receipts are only mutated through the canonical hook", () => {
    const allowed = join("src", "hooks", "useExpenseAttachments.ts");
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file.includes(allowed)) continue;
      const src = readFileSync(file, "utf8");
      const re = /from\(\s*["'`]expense_attachments["'`]\s*\)([\s\S]{0,200})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/\.(insert|update|upsert|delete)\s*\(/.test(m[1])) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
