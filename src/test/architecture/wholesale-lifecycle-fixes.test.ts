/**
 * Wholesale lifecycle governance audit — fix guards.
 *
 * Pins the Critical + High fixes shipped on 2026-06-17:
 *   1. invoice.confirmed outbox trigger
 *   2. delivery_note.completed outbox trigger + repaired dispatched trigger
 *   3. stock_transfer.dispatched fires on `approved` (the status actually set)
 *   4. SO→Invoice locks delivery_notes to prevent duplicate-invoice race
 *   5. complete_stock_transfer_atomic tags in-transit OUT with to_branch_id
 *   6. record_multi_invoice_payment requires _exchange_rate for foreign FX
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(
  "supabase/migrations/20260617231653_00106d73-c944-4211-b785-36ce85c65e63.sql",
  "utf8",
);

function section(marker: string): string {
  const start = MIGRATION.indexOf(marker);
  expect(start, `migration should contain ${marker}`).toBeGreaterThanOrEqual(0);
  return MIGRATION.slice(start);
}

describe("wholesale lifecycle — outbox event coverage", () => {
  it("publishes invoice.confirmed on status transition", () => {
    const body = section("tg_invoice_emit_confirmed");
    expect(body).toMatch(/NEW\.status\s*=\s*'confirmed'/);
    expect(body).toMatch(/OLD\.status IS DISTINCT FROM NEW\.status/);
    expect(body).toMatch(/'invoice\.confirmed'/);
    expect(MIGRATION).toMatch(/CREATE TRIGGER invoices_emit_confirmed/);
  });

  it("publishes delivery_note.completed on delivered/partial/returned", () => {
    const body = section("tg_delivery_note_emit_completed");
    expect(body).toMatch(/'delivered'.*'partial'.*'returned'/s);
    expect(body).toMatch(/'delivery_note\.completed'/);
    expect(MIGRATION).toMatch(/CREATE TRIGGER delivery_notes_emit_completed/);
  });

  it("repairs the dispatched trigger to use real columns only", () => {
    const body = section("tg_delivery_note_emit_dispatched");
    // bug fix: must NOT reference NEW.warehouse_id or NEW.invoice_id (don't exist)
    expect(body).not.toMatch(/NEW\.warehouse_id/);
    expect(body).not.toMatch(/NEW\.invoice_id\b/);
    expect(body).toMatch(/NEW\.source_invoice_id/);
  });

  it("stock_transfer.dispatched fires on approved (the status the RPC sets)", () => {
    const body = section("tg_stock_transfer_emit");
    expect(body).toMatch(/NEW\.status IN \('approved','in_transit'\)/);
    expect(body).toMatch(/'stock_transfer\.dispatched'/);
  });
});

describe("wholesale lifecycle — concurrency guards", () => {
  it("convert_so_to_invoice_atomic locks related delivery_notes before duplicate check", () => {
    const body = section("CREATE OR REPLACE FUNCTION public.convert_so_to_invoice_atomic");
    // Must lock DNs before counting spawned_invoice_id
    const lockIdx = body.search(/PERFORM 1 FROM public\.delivery_notes[\s\S]*?FOR UPDATE/);
    const countIdx = body.search(/SELECT count\(\*\) INTO v_spawned_count/);
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(countIdx).toBeGreaterThan(lockIdx);
  });
});

describe("wholesale lifecycle — multi-branch inventory accuracy", () => {
  it("receive-side in-transit OUT movement is tagged with to_branch_id, not from_branch_id", () => {
    const body = section("CREATE OR REPLACE FUNCTION public.complete_stock_transfer_atomic");
    // The in-transit OUT row must use to_branch_id; from_branch_id on the
    // receive leg would double-count the source branch's outflow.
    expect(body).not.toMatch(/v_transfer\.from_branch_id,\s*\n[\s\S]*?v_in_transit_wh/);
    // Sanity: to_branch_id appears multiple times on receive movements
    const occurrences = (body.match(/v_transfer\.to_branch_id/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(4); // 2 paths × (OUT + IN)
  });
});

describe("wholesale lifecycle — multi-currency FX safety", () => {
  it("record_multi_invoice_payment requires _exchange_rate for foreign-currency invoice", () => {
    const body = section("CREATE OR REPLACE FUNCTION public.record_multi_invoice_payment");
    expect(body).toMatch(/_exchange_rate numeric DEFAULT NULL/);
    expect(body).toMatch(/v_currency <> v_base_currency AND _exchange_rate IS NULL/);
    expect(body).toMatch(/Foreign-currency invoice/);
    // FX rate must flow into the JE call
    expect(body).toMatch(/v_lines, v_currency,\s*\n\s*_exchange_rate/);
  });
});
