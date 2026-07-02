/**
 * ADR 0027 — Allocation-first customer payments.
 *
 * Pins the architecture rules:
 *   1. `PaymentDetailDialog` MUST consume `usePaymentAllocations`.
 *   2. UI/hook code MUST NOT read `payments.invoice_id` from a
 *      fetched payment row. Form input shapes that happen to carry
 *      `invoice_id` (e.g. the `recordPayment` argument) are exempt
 *      because they describe what the operator wants to do, not
 *      what the DB has already linked.
 *   3. `useCustomerLedger` is the canonical read for customer
 *      balance / statements / aging.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "test") continue;
      walk(full, out);
    } else if (/\.(t|j)sx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const DIALOG = readFileSync(
  join(process.cwd(), "src/components/payments/PaymentDetailDialog.tsx"),
  "utf8",
);

describe("ADR 0027 — PaymentDetailDialog uses the allocation read model", () => {
  it("imports and uses usePaymentAllocations", () => {
    expect(DIALOG).toMatch(/usePaymentAllocations/);
  });

  it("does not gate the 'Applied to' row solely on the legacy invoice_id FK", () => {
    // The pre-ADR rendering was:
    //   invoiceNumber && payment.invoice_id ? <link/> : "Unlinked"
    // This pattern is forbidden — the dialog must consult allocations.
    expect(DIALOG).not.toMatch(
      /payment\.invoice_id\s*\?\s*<\s*ClickableEntity[\s\S]{0,80}>\s*\{invoiceNumber\}\s*<\/ClickableEntity>\s*\)\s*:\s*["']Unlinked["']/,
    );
  });
});

describe("ADR 0027 — useCustomerLedger exists and is allocation-aware", () => {
  const HOOK = readFileSync(
    join(process.cwd(), "src/hooks/useCustomerLedger.ts"),
    "utf8",
  );
  it("reads the canonical customer_ledger_entries view", () => {
    expect(HOOK).toMatch(/customer_ledger_entries/);
  });
  it("computes a running balance for the caller", () => {
    expect(HOOK).toMatch(/running_balance/);
  });
});

describe("ADR 0027 — payments.invoice_id deprecation", () => {
  // Files that currently consume the legacy column. Each entry MUST
  // include a reason. Adding new entries requires reviewer sign-off.
  // The goal is to drive this list to zero before the column is
  // dropped one release after ADR 0027 acceptance.
  // Allowlist is intentionally empty — ADR 0027 deprecation is complete in
  // app code. Adding a new entry requires reviewer sign-off and a tracked
  // migration plan back to zero. The column is scheduled for DROP one
  // release after this list has been green.
  const ALLOWED_LEGACY_READS = new Set<string>([]);


  it("no NEW UI files read payments.invoice_id", () => {
    const offenders: string[] = [];
    const files = walk(join(process.cwd(), "src"));
    const pattern = /\.invoice_id\b/;
    const payloadCtx = /payment\.invoice_id|payments\.invoice_id/;
    for (const f of files) {
      if (f.includes("/test/") || f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
      if (f.endsWith("useCustomerLedger.ts")) continue;
      if (f.endsWith("usePaymentAllocations.ts")) continue;
      const rel = f.split(`${process.cwd()}/`)[1] ?? f;
      const src = readFileSync(f, "utf8");
      if (!pattern.test(src)) continue;
      if (!payloadCtx.test(src)) continue;
      if (ALLOWED_LEGACY_READS.has(rel)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `Found new readers of payments.invoice_id (deprecated by ADR 0027): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

describe("ADR 0027 — POS payment surface honours the allocation contract", () => {
  // Ratchet: the POS surface was the last place where invoices could be
  // born "paid" without a payments row + payment_allocations row, which
  // recreated the original "Unlinked" defect. These guards prevent the
  // regression from ever sneaking back in.
  const POS_INVOICE_REQUEST = readFileSync(
    join(process.cwd(), "src/hooks/pos/usePOSInvoiceRequest.ts"),
    "utf8",
  );
  const POS_CREDIT_SALE = readFileSync(
    join(process.cwd(), "src/hooks/pos/usePOSCreditSale.ts"),
    "utf8",
  );

  it("usePOSInvoiceRequest settles via record_payment_atomic", () => {
    expect(POS_INVOICE_REQUEST).toMatch(/record_payment_atomic/);
  });

  it("usePOSInvoiceRequest never inserts an invoice with status='paid'", () => {
    // Forbidden shape: insert into invoices with status set directly to 'paid'
    // (bypasses the allocation contract — invoice must be 'confirmed' and
    // then settled through the RPC).
    expect(POS_INVOICE_REQUEST).not.toMatch(/status:\s*["']paid["']/);
  });

  it("usePOSCreditSale does not insert into the payments table", () => {
    // Credit sale by definition IS the receivable. Inserting a payments row
    // here would create phantom cash and break customer balance.
    expect(POS_CREDIT_SALE).not.toMatch(/\.from\(["']payments["']\)[\s\S]{0,80}\.insert\(/);
  });
});

describe("ADR 0027 closure — payments table no longer joined by FK", () => {
  // The legacy `payments.invoice_id` column is dropped. Any new UI code
  // that does `supabase.from('payments').select('..., invoice:invoices(...)')`
  // is implicitly depending on a FK that no longer exists and will fail
  // at runtime. The canonical read is
  // `payment_allocations(amount, invoice:invoices(...))`, projected to
  // the display shape via `deriveInvoiceFromAllocations`.
  it("no UI file joins invoice:invoices(...) directly off a payments select", () => {
    const offenders: string[] = [];
    const files = walk(join(process.cwd(), "src"));
    // Strategy: for each occurrence of `.from("payments")`, look at the
    // ~600-char window after it. If that window contains `invoice:invoices(`
    // BUT NOT preceded by `payment_allocations(` on the same select chain,
    // flag the file. This avoids false positives on the canonical pattern
    // `payment_allocations(amount, invoice:invoices(...))`.
    for (const f of files) {
      if (f.includes("/test/") || f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
      const src = readFileSync(f, "utf8");
      // Find each `.from("payments")` and inspect the following window.
      const fromMatches = [...src.matchAll(/\.from\(["']payments["']\)/g)];
      let isOffender = false;
      for (const m of fromMatches) {
        const start = m.index ?? 0;
        const window = src.slice(start, start + 600);
        const invoiceJoinIdx = window.search(/invoice:invoices\(/);
        if (invoiceJoinIdx < 0) continue;
        // Is there a payment_allocations( BEFORE the invoice:invoices( in
        // this same window? If yes, the join is nested under allocations
        // and is OK.
        const allocIdx = window.search(/payment_allocations\(/);
        if (allocIdx >= 0 && allocIdx < invoiceJoinIdx) continue;
        isOffender = true;
        break;
      }
      if (isOffender) offenders.push(f.split(`${process.cwd()}/`)[1] ?? f);
    }
    expect(
      offenders,
      `Found legacy FK joins on payments (ADR 0027 closure): ${offenders.join(", ")}. ` +
        `Use payment_allocations(amount, invoice:invoices(...)) and deriveInvoiceFromAllocations instead.`,
    ).toEqual([]);
  });
});

