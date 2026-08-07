/**
 * Architecture guard — ADR 0131 (commercial compensation).
 *
 * Compensation accounting belongs to the database. The browser may not build
 * journal lines for credit notes or refunds, may not resolve compensation
 * accounts, and may not reach a retired second refund engine. Credit-note
 * numbering must always carry business scope.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../");
const SRC = join(ROOT, "src");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

const appFiles = walk(SRC).filter(
  (f) => !f.includes("/test/") && !f.includes("__tests__") && !f.endsWith("types.ts"),
);

const rel = (f: string) => f.replace(`${ROOT}/`, "");

describe("commercial compensation writer monopoly", () => {
  it("no client-side credit note or refund journal-line builders", () => {
    const offenders = appFiles.filter((f) =>
      /buildCreditNoteJELines|buildRefundJELines/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map(rel), "compensation JE lines must be built in the database").toEqual([]);
  });

  it("the retired second refund engine is gone", () => {
    const offenders = appFiles.filter((f) => readFileSync(f, "utf8").includes("process_refund_atomic"));
    expect(
      offenders.map(rel),
      "process_refund_atomic was retired by ADR 0131; use refund_customer_atomic",
    ).toEqual([]);
  });

  it("no client-supplied journal lines are passed to credit note writers", () => {
    const offenders = appFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return src.includes("confirm_credit_note_atomic") && src.includes("p_main_lines");
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("credit note numbering always passes business scope", () => {
    for (const file of appFiles) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("get_next_credit_note_number") && !src.includes("get_next_vendor_credit_note_number")) {
        continue;
      }
      expect(
        /_business_id|p_business_id/.test(src),
        `${rel(file)} calls credit-note numbering without business scope`,
      ).toBe(true);
    }
  });

  it("customer credit availability is read from the credit balance, not derived", () => {
    const src = readFileSync(join(SRC, "hooks/useCustomerCredits.ts"), "utf8");
    expect(src).toContain("customer_credit_balances");
  });

  it("no caller hands compensation account ids to apply_credit_to_invoice_atomic", () => {
    const offenders = appFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return (
        src.includes("apply_credit_to_invoice_atomic") &&
        /_customer_deposits_account_id|_receivable_account_id/.test(src)
      );
    });
    expect(
      offenders.map(rel),
      "the database resolves compensation accounts; clients must not pass them",
    ).toEqual([]);
  });

  it("customer credit has its own GL account role, separate from customer deposits", () => {
    const dir = join(ROOT, "supabase/migrations");
    const seeded = readdirSync(dir).some((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return (
        /system_account_roles/.test(sql) &&
        /'customer_credit'/.test(sql) &&
        /customer_credit_account/.test(sql)
      );
    });
    expect(seeded, "ADR 0131 Phase B: customer_credit account role migration is missing").toBe(true);
  });

  it("returns and payment conversions use business-scoped numbering with no fallback", () => {
    const dir = join(ROOT, "supabase/migrations");
    const files = readdirSync(dir)
      .sort()
      .map((f) => readFileSync(join(dir, f), "utf8"));

    const latestDefinition = (fnName: string): string | null => {
      for (let i = files.length - 1; i >= 0; i -= 1) {
        const idx = files[i].indexOf(`FUNCTION public.${fnName}(`);
        if (idx !== -1) return files[i].slice(idx);
      }
      return null;
    };

    for (const fn of ["approve_sales_return_atomic", "issue_credit_note_for_payment_atomic"]) {
      const sql = latestDefinition(fn);
      expect(sql, `${fn} definition not found in migrations`).not.toBeNull();
      expect(
        /get_next_credit_note_number\(\s*\n?\s*[a-z_.]*organization_id,/.test(sql as string),
        `${fn} must call business-scoped credit-note numbering`,
      ).toBe(true);
      expect(
        /CN-'\s*,\s*extract\(epoch/.test(sql as string),
        `${fn} must not invent fallback document numbers`,
      ).toBe(false);
    }
  });

  it("approved sales returns reverse COGS in the general ledger", () => {
    const dir = join(ROOT, "supabase/migrations");
    const posted = readdirSync(dir).some((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return (
        sql.includes("approve_sales_return_atomic") &&
        /cost_of_goods_sold/.test(sql) &&
        /'sales_return'/.test(sql)
      );
    });
    expect(posted, "ADR 0131 Phase C: sales return inventory/COGS reversal is missing").toBe(true);
  });
});