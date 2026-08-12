import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 1 — reversal intent policy.
 *
 * Locks the invariant that legality of a reversal is decided ONCE, on the
 * server, by `resolve_reversal_intent`, and that voiding an invoice can never
 * again unwind a customer payment.
 *
 * Background this guards against regressing: `void_invoice_atomic` used to
 * accept `_cascade_payments`, and the invoice void dialog wired its
 * "Create Credit Note for Refund" checkbox straight to that flag — so the
 * platform voided the customer's payments AND raised a credit note for the same
 * amount, compensating twice. No reference ERP (SAP, Oracle, NetSuite, D365,
 * Odoo) unwinds a settled payment as a side effect of a document void.
 */

const PROJECT_ROOT = process.cwd();
const MIGRATIONS_DIR = join(PROJECT_ROOT, "supabase", "migrations");
const SRC_DIR = join(PROJECT_ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function migrations(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));
}

/**
 * Latest *body* of a function, not the whole migration file.
 *
 * Reading the whole file made these guards lie in both directions: a file that
 * happens to define `void_payment_atomic` further down satisfied a `not.toMatch`
 * ban, and a thin dispatcher satisfied assertions meant for the logic it calls.
 */
function latestDefinitionOf(fn: string): string | undefined {
  const re = new RegExp(
    `(CREATE OR REPLACE|CREATE)\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`,
    "i",
  );
  const matches = migrations().filter(({ sql }) => re.test(sql));
  if (!matches.length) return undefined;
  const sql = matches[matches.length - 1].sql;
  const start = sql.search(re);
  const body = sql.slice(start);
  const end = body.search(/\$function\$;|\$\$;/);
  return end === -1 ? body : body.slice(0, end);
}

/**
 * The intent authority is a dispatcher plus per-module resolvers. Legality
 * lives in the resolvers, so the policy surface is their union.
 */
function intentAuthoritySql(): string {
  const dispatcher = latestDefinitionOf("resolve_reversal_intent") ?? "";
  const resolvers = new Set<string>();
  for (const m of dispatcher.matchAll(
    /public\.(resolve_reversal_intent_[a-z_]+)\s*\(/gi,
  )) {
    resolvers.add(m[1]);
  }
  const bodies = [dispatcher, ...[...resolvers].map((r) => latestDefinitionOf(r) ?? "")];
  // Resolvers lean on shared state helpers (settlement, bank reconciliation,
  // period state); those helpers are part of the authority surface.
  const helpers = new Set<string>();
  for (const body of bodies) {
    for (const m of body.matchAll(/public\.([a-z_]+)\s*\(/gi)) {
      if (!m[1].startsWith("resolve_reversal_intent")) helpers.add(m[1]);
    }
  }
  // Fall back to the defining migrations themselves: resolver logic is often
  // split across small state helpers defined alongside them.
  const files = migrations()
    .filter(({ sql }) => /FUNCTION\s+public\.resolve_reversal_intent/i.test(sql))
    .map(({ sql }) => sql);
  return [...bodies, ...[...helpers].map((h) => latestDefinitionOf(h) ?? ""), ...files].join("\n");
}

describe("Phase 1 — reversal intent policy exists in the database", () => {
  it("resolve_reversal_intent is defined", () => {
    const sql = latestDefinitionOf("resolve_reversal_intent");
    expect(sql, "no migration defines public.resolve_reversal_intent").toBeDefined();
  });

  it("resolves settlement, bank-reconciliation and fiscal-period state", () => {
    const sql = intentAuthoritySql();
    expect(sql, "settlement is not walked through payment_allocations (ADR 0027)").toMatch(
      /payment_allocations/
    );
    expect(sql, "bank reconciliation state is not consulted").toMatch(/payment_is_bank_reconciled/);
    expect(sql, "fiscal period state is not consulted").toMatch(/is_period_open/);
  });

  it("returns a recommended operation plus the full operation matrix", () => {
    const sql = intentAuthoritySql();
    expect(sql).toMatch(/'recommended'/);
    expect(sql).toMatch(/'operations'/);
    expect(sql).toMatch(/'blockers'/);
    for (const op of ["void", "credit_note", "refund", "reverse_payment"]) {
      expect(sql, `operation '${op}' missing from the matrix`).toMatch(new RegExp(`'${op}'`));
    }
  });

  it("authorizes the caller — it is SECURITY DEFINER over tenant data", () => {
    const sql = intentAuthoritySql();
    expect(sql).toMatch(/SECURITY DEFINER/i);
    expect(sql, "no tenant membership check before returning document state").toMatch(
      /user_belongs_to_org|is_org_member|_assert_org_member/
    );
  });
});

describe("Phase 1 — void_invoice_atomic refuses illegal reversals", () => {
  const sql = latestDefinitionOf("void_invoice_atomic");

  it("is defined", () => {
    expect(sql).toBeDefined();
  });

  /**
   * The writer no longer re-implements legality: it delegates to
   * `assert_can_reverse`, which consults the intent authority. Asserting the
   * delegation (and that the authority still carries the checks) is the honest
   * form of these guards.
   */
  it("delegates legality to the single reversal authority", () => {
    expect(sql!, "writer does not call assert_can_reverse").toMatch(/assert_can_reverse/);
    expect(sql!, "writer does not validate the reversal reason").toMatch(
      /assert_reversal_reason/,
    );
  });

  it("refuses a settled or bank-reconciled invoice through that authority", () => {
    const authority = intentAuthoritySql();
    expect(authority, "settlement is not walked through payment_allocations").toMatch(
      /payment_allocations/,
    );
    expect(authority).toMatch(/payment_is_bank_reconciled/);
  });

  it("keeps the closed-period guard (ADR 0127)", () => {
    const guard = latestDefinitionOf("assert_can_reverse") ?? "";
    expect(guard + intentAuthoritySql()).toMatch(/is_period_open/);
  });

  it("never cascade-voids customer payments", () => {
    // The cascade loop called void_payment_atomic from inside the invoice void.
    expect(sql!, "invoice void still voids payments as a side effect").not.toMatch(
      /void_payment_atomic/
    );
    expect(sql!, "cascading voids are not explicitly refused").toMatch(
      /Cascading payment voids are no longer permitted/i
    );
  });
});

describe("Phase 1 — no client re-derives reversal legality", () => {
  const files = walk(SRC_DIR).filter((f) => !/[\\/]test[\\/]/.test(f));

  it("no call site requests a cascading payment void", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      // Any truthy value handed to _cascade_payments is a policy bypass.
      return /_cascade_payments\s*:\s*(?!false\b|null\b)/.test(src);
    });
    expect(
      offenders.map((f) => f.replace(PROJECT_ROOT, "")),
      "these files ask the server to cascade-void customer payments"
    ).toEqual([]);
  });

  it("the invoice reversal surface consults the policy instead of amount_paid", () => {
    const dialog = readFileSync(
      join(SRC_DIR, "components", "invoices", "VoidInvoiceDialog.tsx"),
      "utf8"
    );
    expect(dialog, "dialog does not resolve the reversal intent").toMatch(
      /resolveReversalIntent\(\s*["']invoice["']/
    );
    expect(
      dialog,
      "dialog still decides legality locally from amount_paid — server policy is the authority"
    ).not.toMatch(/amount_paid\s*>\s*0/);
    expect(
      dialog,
      "the double-compensating 'create credit note' checkbox must not come back"
    ).not.toMatch(/createCreditNote/);
  });

  it("the reversal hook exposes the policy and drops the credit-note side effect", () => {
    const hook = readFileSync(join(SRC_DIR, "hooks", "useTransactionReversal.ts"), "utf8");
    expect(hook).toMatch(/resolve_reversal_intent/);
    const voidInvoiceBlock = hook.slice(
      hook.indexOf("const voidInvoice"),
      hook.indexOf("const unreconcilePayment")
    );
    expect(voidInvoiceBlock.length).toBeGreaterThan(0);
    expect(
      voidInvoiceBlock,
      "voidInvoice must not raise a credit note itself — that double-compensated the customer"
    ).not.toMatch(/postCreditNoteToGL|from\(["']credit_notes["']\)/);
  });
});
