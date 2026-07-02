import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveReceiptTitle } from "./resolveReceiptTitle.ts";

Deno.test("cash sale fully paid → SALES RECEIPT", () => {
  const r = resolveReceiptTitle({
    total: 100, amount_paid: 100,
    payments: [{ payment_method: "cash", amount: 100 }],
  });
  assertEquals(r.kind, "sales_receipt");
  assertEquals(r.title, "SALES RECEIPT");
});

Deno.test("split tender card+cash fully paid → SALES RECEIPT (not INVOICE)", () => {
  const r = resolveReceiptTitle({
    total: 100, amount_paid: 100,
    payments: [
      { payment_method: "credit_card", amount: 60 },
      { payment_method: "cash", amount: 40 },
    ],
  });
  assertEquals(r.kind, "sales_receipt");
});

Deno.test("on-account: credit tender with shortfall → INVOICE", () => {
  const r = resolveReceiptTitle({
    total: 100, amount_paid: 30,
    payments: [
      { payment_method: "cash", amount: 30 },
      { payment_method: "credit", amount: 70 },
    ],
  });
  assertEquals(r.kind, "invoice");
  assertEquals(r.title, "INVOICE");
});

Deno.test("positive balance due with no credit tender → INVOICE", () => {
  const r = resolveReceiptTitle({
    total: 100, amount_paid: 60,
    payments: [{ payment_method: "cash", amount: 60 }],
  });
  assertEquals(r.kind, "invoice");
});

Deno.test("fiscalized cash sale with tax → TAX INVOICE", () => {
  const r = resolveReceiptTitle({
    total: 116, amount_paid: 116, tax_amount: 16,
    etims_cu_number: "KRACU0100123456",
    payments: [{ payment_method: "cash", amount: 116 }],
  });
  assertEquals(r.kind, "tax_invoice");
  assertEquals(r.title, "TAX INVOICE");
});

Deno.test("fiscalized but zero tax → SALES RECEIPT (not TAX INVOICE)", () => {
  const r = resolveReceiptTitle({
    total: 100, amount_paid: 100, tax_amount: 0,
    etims_cu_number: "KRACU0100123456",
    payments: [{ payment_method: "cash", amount: 100 }],
  });
  assertEquals(r.kind, "sales_receipt");
});

Deno.test("refund / negative total → CREDIT NOTE", () => {
  const r = resolveReceiptTitle({
    total: -50, amount_paid: -50, is_refund: true,
    payments: [{ payment_method: "cash", amount: -50 }],
  });
  assertEquals(r.kind, "credit_note");
});

Deno.test("voided sale → VOID prefix", () => {
  const r = resolveReceiptTitle({
    total: 100, amount_paid: 100, is_voided: true,
    payments: [{ payment_method: "cash", amount: 100 }],
  });
  assertEquals(r.kind, "void");
  assertEquals(r.title, "VOID — SALES RECEIPT");
});

Deno.test("reprint of cash receipt → REPRINT suffix", () => {
  const r = resolveReceiptTitle({
    total: 100, amount_paid: 100, is_reprint: true,
    payments: [{ payment_method: "cash", amount: 100 }],
  });
  assertEquals(r.title, "SALES RECEIPT (REPRINT)");
});

Deno.test("empty payments + total > 0 → INVOICE (unpaid balance)", () => {
  const r = resolveReceiptTitle({
    total: 100, amount_paid: 0, payments: [],
  });
  assertEquals(r.kind, "invoice");
});



Deno.test("Phase-F: legacy_title_mode flips TAX INVOICE → SALES RECEIPT", () => {
  const input = {
    total: 1160,
    amount_paid: 1160,
    payments: [{ payment_method: "cash", amount: 1160 }],
    tax_amount: 160,
    etims_cu_number: "KRACU0123456789",
  };
  const without = resolveReceiptTitle({ ...input, legacy_title_mode: false });
  const withLegacy = resolveReceiptTitle({ ...input, legacy_title_mode: true });
  assertEquals(without.kind, "tax_invoice");
  assertEquals(without.title, "TAX INVOICE");
  assertEquals(withLegacy.kind, "sales_receipt");
  assertEquals(withLegacy.title, "SALES RECEIPT");
});

Deno.test("Phase-F: legacy_title_mode does NOT downgrade INVOICE (on-account)", () => {
  // A/R sale must always be INVOICE — the legal A/R term is non-negotiable.
  const r = resolveReceiptTitle({
    total: 1000,
    amount_paid: 0,
    payments: [{ payment_method: "credit", amount: 1000 }],
    legacy_title_mode: true,
  });
  assertEquals(r.kind, "invoice");
  assertEquals(r.title, "INVOICE");
});
