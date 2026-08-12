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

  it("there is exactly one credit note creation entry point", () => {
    const adapters = appFiles.filter((f) =>
      /create_credit_note_request_atomic/.test(readFileSync(f, "utf8")),
    );
    expect(
      adapters.map(rel),
      "create_credit_note_request_atomic was a duplicate adapter; call create_credit_note_atomic",
    ).toEqual([]);

    const callers = appFiles.filter((f) => {
      const source = readFileSync(f, "utf8");
      return /rpc\([^)]*["']create_credit_note_atomic["']/.test(source)
        || /rest\/v1\/rpc\/create_credit_note_atomic/.test(source);
    });
    expect(callers.map(rel)).toEqual([
      "src/services/finance/createCreditNote.ts",
    ]);

    // The single entry point is the named jsonb envelope; positional/named
    // column arguments reintroduce PostgREST signature drift.
    const transport = readFileSync(join(SRC, "services/finance/createCreditNote.ts"), "utf8");
    expect(
      transport.includes("JSON.stringify({ _payload: payload })"),
      "creation must serialize exactly the _payload envelope",
    ).toBe(true);

  });

  it("the newest function-defining migration is followed by a schema-cache reload", () => {
    // Root cause of the credit-note HTTP 404: the writer existed, but the
    // migration that created it never issued NOTIFY pgrst, so the API kept
    // answering PGRST202 for a function with a matching signature.
    // The invariant is about ORDER, not about every file: the cache must be
    // reloaded at or after the last migration that touched a public function.
    // Applied migrations are immutable, so a later NOTIFY migration is the
    // supported remedy.
    const MIGRATIONS = join(ROOT, "supabase/migrations");
    const CUTOFF = "20260807170000"; // forward-looking: applies to new work only
    const recent = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && f.slice(0, 14) >= CUTOFF)
      .sort();
    const sqlOf = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
    const lastFunctionMigration = [...recent]
      .reverse()
      .find((f) => /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\./i.test(sqlOf(f)));
    if (!lastFunctionMigration) return;
    const reloadedAtOrAfter = recent
      .filter((f) => f >= lastFunctionMigration)
      .some((f) => /NOTIFY\s+pgrst/i.test(sqlOf(f)));
    expect(
      reloadedAtOrAfter,
      `no NOTIFY pgrst, 'reload schema' at or after ${lastFunctionMigration}`,
    ).toBe(true);
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
    // Canonical view over customer_credit_balances (Wave 6) — never a derived
    // `total - amount_applied` over credit notes.
    expect(src).toContain("finance_ar_customer_credit");
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

  // ---- ADR 0132: AP parity -------------------------------------------------

  it("the retired vendor compensation writers are gone", () => {
    const offenders = appFiles.filter((f) =>
      /confirm_vendor_credit_note_atomic|apply_vendor_credit_note_atomic/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(
      offenders.map(rel),
      "ADR 0132 retired these; use issue_vendor_credit_note_atomic / apply_vendor_credit_to_bill_atomic",
    ).toEqual([]);
  });

  it("no client inserts vendor credit note headers directly", () => {
    const offenders = appFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /from\("vendor_credit_notes"\)\s*\n?\s*\.insert/.test(src);
    });
    expect(
      offenders.map(rel),
      "vendor credit notes are created only by create_vendor_credit_note_atomic",
    ).toEqual([]);
  });

  it("no client mutates vendor credit note headers or lines directly", () => {
    const offenders = appFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /from\("vendor_credit_notes?(?:_items)?"\)\s*\n?\s*\.(?:update|delete|upsert|insert)/.test(
        src,
      );
    });
    expect(
      offenders.map(rel),
      "vendor credit note money is server-authoritative: use update_vendor_credit_note_atomic / delete_vendor_credit_note_atomic",
    ).toEqual([]);
  });

  it("vendor credit note creation carries an idempotency key", () => {
    const hook = readFileSync(join(SRC, "hooks/useVendorCreditNotes.ts"), "utf8");
    expect(
      hook.includes("_client_request_id"),
      "creation must pass a client request id so retries replay instead of duplicating",
    ).toBe(true);
    const createPage = readFileSync(
      join(SRC, "features/purchases/credit-notes/VendorCreditNoteCreatePage.tsx"),
      "utf8",
    );
    expect(
      /requestIdRef/.test(createPage),
      "the create form must hold one deterministic request id per attempt",
    ).toBe(true);
  });


  it("no client-side purchase-return journal lines", () => {
    const offenders = appFiles.filter((f) => readFileSync(f, "utf8").includes("postPurchaseReturnGL"));
    expect(
      offenders.map(rel),
      "purchase-return GL is posted by the vendor credit writer, not the browser",
    ).toEqual([]);
  });

  it("vendor credit has its own GL account role and ledger", () => {
    const dir = join(ROOT, "supabase/migrations");
    const files = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8"));
    expect(
      files.some((sql) => /system_account_roles/.test(sql) && /'vendor_credit'/.test(sql)),
      "ADR 0132: vendor_credit account role migration is missing",
    ).toBe(true);
    expect(
      files.some((sql) => /vendor_credit_movements/.test(sql) && /vendor_credit_balances/.test(sql)),
      "ADR 0132: vendor credit subledger is missing",
    ).toBe(true);
    expect(
      files.some((sql) => /vendor_credit_tieout/.test(sql)),
      "ADR 0132: vendor credit tie-out view is missing",
    ).toBe(true);
  });
});
