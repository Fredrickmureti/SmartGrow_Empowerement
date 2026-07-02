/**
 * Architecture guard — Payroll Payment Batch lifecycle.
 *
 * Pins the UI ↔ DB contract for the payment-batch state machine introduced
 * in Phase A of the Payroll Payments hardening. Every status transition
 * must go through a SECURITY DEFINER RPC so that:
 *   (a) sod_payroll_payment_batches_guard fires,
 *   (b) the lifecycle-validation trigger enforces legal transitions,
 *   (c) business_event_outbox emits a `payroll_payment_batch.*` event.
 *
 * If a future refactor swaps an RPC for a direct table update, the trigger
 * still runs, but the audit + outbox emission paths drift; this test fails
 * fast so that drift cannot land silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const HOOK_PATH = resolve(__dirname, "../../hooks/payroll/usePayrollPayments.ts");
const SECTIONS_PATH = resolve(__dirname, "../../pages/hr/payroll/sections.tsx");
const CATALOGUE_PATH = resolve(__dirname, "../../lib/governance/selfActionCatalogue.ts");

const LIFECYCLE_RPCS = [
  "payroll_payment_batch_approve",
  "payroll_payment_batch_lock",
  "payroll_payment_batch_mark_exported",
  "payroll_payment_batch_mark_transmitted",
  "payroll_payment_batch_cancel",
  "payroll_payment_batch_reverse",
] as const;

const SOD_ACTION_KEYS = [
  "payroll_payment_batch.approve",
  "payroll_payment_batch.lock",
  "payroll_payment_batch.transmit",
  "payroll_payment_batch.pay",
  "payroll_payment_batch.cancel",
  "payroll_payment_batch.reverse",
] as const;

function readMigrations(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  return readdirSync(dir).filter(f => f.endsWith(".sql"))
    .map(f => readFileSync(join(dir, f), "utf8")).join("\n");
}

describe("payroll payment batch lifecycle (Phase A)", () => {
  const hook = readFileSync(HOOK_PATH, "utf8");
  const sections = readFileSync(SECTIONS_PATH, "utf8");
  const catalogue = readFileSync(CATALOGUE_PATH, "utf8");

  for (const rpc of LIFECYCLE_RPCS) {
    it(`hook invokes ${rpc} via supabase.rpc()`, () => {
      const re = new RegExp(`supabase\\.rpc\\(\\s*["']${rpc}["']`);
      expect(re.test(hook)).toBe(true);
    });
  }

  it("hook never updates payroll_payment_batches.status directly", () => {
    expect(
      /from\(["']payroll_payment_batches["']\)[\s\S]{0,400}\.update\(/.test(hook),
    ).toBe(false);
  });

  it("Payments page exposes the lifecycle action bar", () => {
    expect(sections).toMatch(/approveBatch\.mutate/);
    expect(sections).toMatch(/lockBatch\.mutate/);
    expect(sections).toMatch(/markBatchTransmitted\.mutate/);
    expect(sections).toMatch(/cancelBatch\.mutate/);
    expect(sections).toMatch(/reverseBatch\.mutate/);
  });

  it("SoD guard trigger is registered against payroll_payment_batches", () => {
    const sql = readMigrations();
    expect(/CREATE TRIGGER sod_payroll_payment_batches_guard\b/.test(sql)).toBe(true);
    expect(/CREATE OR REPLACE FUNCTION public\.sod_payroll_payment_batches_guard\b/.test(sql)).toBe(true);
  });

  it("Self-action catalogue registers every payment-batch SoD key", () => {
    for (const key of SOD_ACTION_KEYS) {
      expect(catalogue.includes(`"${key}"`), `missing catalogue entry for ${key}`).toBe(true);
    }
  });

  it("bank export files table + lifecycle trigger exist", () => {
    const sql = readMigrations();
    expect(/CREATE TABLE IF NOT EXISTS public\.payroll_bank_export_files\b/.test(sql)).toBe(true);
    expect(/CREATE TRIGGER trg_validate_payroll_bank_export_file_lifecycle\b/.test(sql)).toBe(true);
  });

  it("v_payroll_payment_reconciliation view is defined", () => {
    const sql = readMigrations();
    expect(/CREATE OR REPLACE VIEW public\.v_payroll_payment_reconciliation\b/.test(sql)).toBe(true);
  });

  it("per-item lifecycle RPCs are wired through the hook (no direct updates)", () => {
    const itemRpcs = [
      "payroll_payment_item_hold",
      "payroll_payment_item_release",
      "payroll_payment_item_retry",
      "payroll_payment_item_mark_failed",
      "payroll_payment_item_cancel",
      "payroll_payment_item_mark_paid",
    ];
    for (const rpc of itemRpcs) {
      const re = new RegExp(`supabase\\.rpc\\(\\s*["']${rpc}["']`);
      expect(re.test(hook), `hook missing rpc call to ${rpc}`).toBe(true);
    }
    expect(
      /from\(["']payroll_payment_batch_items["']\)[\s\S]{0,400}\.update\(/.test(hook),
    ).toBe(false);
  });

  it("Failed-items page exposes per-item action buttons", () => {
    const failedPage = readFileSync(
      resolve(__dirname, "../../pages/hr/payroll/PayrollPaymentsSubViews.tsx"),
      "utf8",
    );
    expect(failedPage).toMatch(/retryItem\.mutate/);
    expect(failedPage).toMatch(/cancelItem\.mutate/);
    expect(failedPage).toMatch(/markItemPaid\.mutate/);
    expect(failedPage).toMatch(/holdItem\.mutate/);
    expect(failedPage).toMatch(/releaseItem\.mutate/);
  });
});
