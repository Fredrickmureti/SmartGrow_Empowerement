/**
 * ADR 0028 — Allocation-first vendor payments (AP mirror of ADR 0027).
 *
 * Pins the architecture rules on the AP side:
 *   1. Vendor statements MUST source from the canonical
 *      `vendor_ledger_entries` view, NOT from a hand-rolled union of
 *      `bills` + `bill_payments` + `vendor_credit_notes`.
 *   2. `useVendorLedger` is the canonical client-side read for vendor
 *      balance and statement context.
 *   3. UI/hook code MUST NOT introduce NEW reads of
 *      `bill_payments.bill_id` from a fetched row. Form payloads,
 *      writer hooks (`recordBillPayment` / reversal / vendor-credit
 *      apply), and the auto-allocate trigger glue are temporarily
 *      allowlisted while the canonical writer (`record_multi_bill_payment`)
 *      rolls out across all callers. Goal: drive the allowlist to zero,
 *      then DROP `bill_payments.bill_id` in a follow-up migration.
 *
 * Mirrors `payment-allocations-first-class.test.ts` exactly.
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

describe("ADR 0028 — vendor statements source from the canonical ledger view", () => {
  const HOOK = readFileSync(
    join(process.cwd(), "src/hooks/useVendorStatements.ts"),
    "utf8",
  );

  it("reads the canonical vendor_ledger_entries view", () => {
    expect(HOOK).toMatch(/vendor_ledger_entries/);
  });

  it("no longer hand-unions bill_payments to build the statement", () => {
    // The pre-ADR-0028 shape walked bill ids and called .from('bill_payments')
    // inside generateStatementData. The new shape MUST not — all transactions
    // come from the ledger view. (We still allow `.from('bills')` for the
    // aging-buckets block; that does not violate the allocation contract.)
    expect(HOOK).not.toMatch(/generateStatementData[\s\S]*?\.from\(["']bill_payments["']\)/);
  });
});

describe("ADR 0028 — useVendorLedger / deriveBillFromAllocations are wired", () => {
  it("useVendorLedger hook exists and reads vendor_ledger_entries", () => {
    const HOOK = readFileSync(
      join(process.cwd(), "src/hooks/useVendorLedger.ts"),
      "utf8",
    );
    expect(HOOK).toMatch(/vendor_ledger_entries/);
    expect(HOOK).toMatch(/running_balance/);
  });

  it("deriveBillFromAllocations helper exists with the canonical display contract", () => {
    const HELPER = readFileSync(
      join(process.cwd(), "src/lib/payments/deriveBillFromAllocations.ts"),
      "utf8",
    );
    expect(HELPER).toMatch(/deriveBillFromAllocations/);
    expect(HELPER).toMatch(/allocation_count/);
    // Display contract: "+N more" suffix for multi-bill payments.
    expect(HELPER).toMatch(/\+\$\{n - 1\} more/);
  });
});

describe("ADR 0028 — bill_payments.bill_id is dropped (ratchet at zero)", () => {
  // The legacy column has been physically dropped (see S3c.2 migration).
  // No UI/hook code may read `bill_payments.bill_id` or join through it,
  // and no new code may add it back. Use payment_allocations + bills,
  // or open the vendor ledger via useVendorLedger.
  const ALLOWED_LEGACY_READS = new Set<string>([
    // Generated types are written by Supabase. The DROP COLUMN flushes
    // bill_id from the BillPayments row type on the next types pull; keep
    // this entry until then so the test does not block unrelated changes.
    "src/integrations/supabase/types.ts",
  ]);

  it("no UI files read bill_payments.bill_id", () => {
    const offenders: string[] = [];
    const files = walk(join(process.cwd(), "src"));
    const colPattern = /\.bill_id\b/;
    const payloadCtx =
      /bill_payment\.bill_id|bill_payments\.bill_id|payment\.bill_id|\.from\(["']bill_payments["']\)/;
    for (const f of files) {
      if (f.includes("/test/") || f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
      const rel = f.split(`${process.cwd()}/`)[1] ?? f;
      const src = readFileSync(f, "utf8");
      if (!colPattern.test(src)) continue;
      if (!payloadCtx.test(src)) continue;
      if (ALLOWED_LEGACY_READS.has(rel)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `Found readers of dropped bill_payments.bill_id column: ${offenders.join(", ")}. ` +
        `Use bill_payment_allocations + bills(...) instead, ` +
        `or open the vendor ledger via useVendorLedger.`,
    ).toEqual([]);
  });
});