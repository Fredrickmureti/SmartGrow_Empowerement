/**
 * Architecture guard — `no-client-payment-math`.
 *
 * ADR 0009 · Wave 3 · Phase 4.c-follow.
 *
 * The POS payment dialog must derive `allocated`, `totalTendered`,
 * `totalChange`, `remaining`, and `change` from the server-authoritative
 * `usePaymentSession` hook — NEVER by `.reduce()`-ing a local
 * `useState<PaymentDialogPayment[]>()` list. This test locks the
 * regression so a future edit cannot silently re-introduce the shape
 * that historically produced the "20,000 cash / 19,000 sale / no change
 * recorded" bug.
 *
 * The guard is narrowly scoped: it only fails on the specific
 * client-side money-math patterns, not on unrelated `.reduce` usage.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DIALOG_PATH = resolve(
  process.cwd(),
  "src/components/pos/PaymentDialog.tsx",
);

describe("no-client-payment-math (PaymentDialog)", () => {
  const source = readFileSync(DIALOG_PATH, "utf8");

  it("does not declare a local useState for the tender list", () => {
    // Any variant of `useState<PaymentDialogPayment[]>(` / `useState([]) `
    // that stores the tender list. Server-authoritative rows come from
    // `usePaymentSession().tenders` and are mapped for the parent only.
    expect(source).not.toMatch(/useState<PaymentDialogPayment\[\]>/);
    expect(source).not.toMatch(/setPayments\s*\(/);
  });

  it("uses usePaymentSession as the source of truth", () => {
    expect(source).toMatch(/from\s+"@\/hooks\/pos\/usePaymentSession"/);
    expect(source).toMatch(/usePaymentSession\s*\(/);
  });

  it("does not client-derive totalApplied / totalTendered / totalChange", () => {
    // These identifiers may still exist (bound to session.allocated etc.),
    // but they MUST NOT be defined via `.reduce(...)` in this file.
    const forbiddenReduces = [
      /const\s+totalApplied\s*=\s*[^;]*\.reduce\s*\(/,
      /const\s+totalTendered\s*=\s*[^;]*\.reduce\s*\(/,
      /const\s+totalChange\s*=\s*[^;]*\.reduce\s*\(/,
      // Historic "remaining = effectiveTotal - totalApplied" clamp — the
      // hook now owns this.
      /const\s+remaining\s*=\s*Math\.max\s*\(\s*0\s*,\s*effectiveTotal\s*-\s*totalApplied\s*\)/,
    ];
    for (const rx of forbiddenReduces) {
      expect(source, `PaymentDialog re-derives money math: ${rx}`).not.toMatch(rx);
    }
  });

  it("records every tender through session.recordTender", () => {
    // No add-tender path may bypass the session and append to a local
    // array. The onAttached C2B callback used to do this — the guard
    // makes sure it doesn't come back.
    expect(source).toMatch(/session\.recordTender|recordTenderRow\s*\(/);
  });

  it("removes tenders through session.reverseTender, not by filtering", () => {
    expect(source).toMatch(/session\.reverseTender\s*\(/);
    // Reject the specific "filter out by index" removal pattern.
    expect(source).not.toMatch(/payments\.filter\s*\(\s*\(\s*_?,\s*i\s*\)\s*=>\s*i\s*!==/);
  });
});
