/**
 * Inventory adjustment GL integrity guards (Phase A + B).
 *
 * The 2026-05-21 audit (docs/audit/2026-05-21-inventory-adjustment-gl.md)
 * confirmed that manual stock adjustments were moving warehouse_stock
 * WITHOUT producing a journal entry whenever the UI omitted unit_cost.
 * These tests lock in the architectural fix:
 *
 *   1. The hardened approve_stock_adjustment_atomic resolves cost
 *      server-side and RAISES when no valuation cost is available.
 *   2. The Inventory adjustment dialog captures unit_cost per line.
 *   3. The mutation hook surfaces gl_posted to the user.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(
  "supabase/migrations/20260521005751_b1e67397-2ccb-40cc-830b-9f1912197109.sql",
  "utf8",
);
const WAVE1 = readFileSync(
  "supabase/migrations/20260521011535_01047e73-3a3b-4cb7-b558-53c2bf091853.sql",
  "utf8",
);
const WAVE2 = readFileSync(
  "supabase/migrations/20260521011736_9387f876-cd18-4a92-a35d-19b7270ee600.sql",
  "utf8",
);
// The adjustment create surface moved from the Inventory dialog to the
// routed page /inventory-app/adjustments/new (RecordFormShell).
const INVENTORY_PAGE = readFileSync(
  "src/pages/inventory/AdjustmentNew.tsx",
  "utf8",
);
const INVENTORY_LIST_PAGE = readFileSync("src/pages/Inventory.tsx", "utf8");
const USE_INVENTORY = readFileSync("src/hooks/useInventory.ts", "utf8");
const RECON_CARD = readFileSync(
  "src/components/finance/InventoryReconciliationCard.tsx",
  "utf8",
);

describe("inventory adjustment ↔ GL integrity", () => {
  it("server provisions a cost resolver and uses it during approval", () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION public\.resolve_adjustment_unit_cost/);
    expect(MIGRATION).toMatch(/v_resolved_cost\s*:=\s*public\.resolve_adjustment_unit_cost/);
  });

  it("server RAISES instead of silently skipping GL when cost is missing", () => {
    expect(MIGRATION).toMatch(/no valuation cost is available for product/i);
  });

  it("server locks per-warehouse stock rows during approval", () => {
    // FOR UPDATE on the warehouse_stock read inside the per-item loop.
    expect(MIGRATION).toMatch(/FROM public\.warehouse_stock[\s\S]{0,200}FOR UPDATE/);
  });

  it("warehouse_stock has a per-warehouse moving-average cost column", () => {
    expect(MIGRATION).toMatch(/ALTER TABLE public\.warehouse_stock[\s\S]{0,120}average_cost/);
  });

  it("AVCO trigger also fires for positive adjustment movements with a cost", () => {
    expect(MIGRATION).toMatch(/movement_type IN \('receipt', 'purchase', 'adjustment'\)/);
  });

  it("Adjustment create page captures unit_cost per line", () => {
    // The line model carries unit_cost, the input is rendered, and the
    // submit handler refuses to submit when it's missing.
    expect(INVENTORY_PAGE).toMatch(/unit_cost:\s*number\s*\|\s*""/);
    expect(INVENTORY_PAGE).toMatch(/Unit cost \*/);
    expect(INVENTORY_PAGE).toMatch(/Enter a unit cost for/);
  });

  it("Adjustment create page uses a reason enum, not free text", () => {
    expect(INVENTORY_PAGE).toMatch(/Select adjustment reason/);
    expect(INVENTORY_PAGE).toMatch(/value="shrinkage"/);
    expect(INVENTORY_PAGE).toMatch(/value="found_stock"/);
  });

  it("createStockAdjustment forwards unit_cost on every line", () => {
    // The mapping must pass unit_cost through; previously it spread `...i`
    // without ever populating that field.
    expect(INVENTORY_PAGE).toMatch(/unit_cost:\s*typeof i\.unit_cost === "number"/);
  });

  it("createStockAdjustment surfaces gl_posted in the success toast", () => {
    expect(USE_INVENTORY).toMatch(/journal entry posted/);
    expect(USE_INVENTORY).toMatch(/NO journal entry was posted/);
  });

  // ===== Wave 2 / Wave 3 closeout guards =====

  it("Wave 1 migration enforces per-warehouse AVCO and idempotency", () => {
    expect(WAVE1).toMatch(/client_request_id/);
    expect(WAVE1).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,200}client_request_id/);
  });

  it("Wave 2 migration ships a first-class reverse_stock_adjustment_atomic RPC", () => {
    expect(WAVE2).toMatch(/CREATE OR REPLACE FUNCTION public\.reverse_stock_adjustment_atomic/);
    expect(WAVE2).toMatch(/reverses_adjustment_id/);
    expect(WAVE2).toMatch(/reversed_by_adjustment_id/);
  });

  it("Wave 2 migration exposes a per-row missing-JE backfill RPC", () => {
    expect(WAVE2).toMatch(/backfill_missing_adjustment_je/);
  });

  it("Wave 3 closeout installs the immutability trigger and missing-JE detector", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const dir = fs.readdirSync("supabase/migrations").sort();
    // The wave3 closeout is whichever migration ships the immutability
    // trigger function. Match by content, not filename, so renaming the
    // generated file does not break the guard.
    const wave3File = dir
      .filter((f) => f.endsWith(".sql"))
      .find((f) =>
        fs
          .readFileSync(`supabase/migrations/${f}`, "utf8")
          .includes("prevent_approved_adjustment_mutation"),
      );
    expect(wave3File, "wave3 closeout migration missing").toBeTruthy();
    const wave3 = fs.readFileSync(`supabase/migrations/${wave3File}`, "utf8");
    expect(wave3).toMatch(/CREATE OR REPLACE FUNCTION public\.prevent_approved_adjustment_mutation/);
    expect(wave3).toMatch(/CREATE TRIGGER trg_prevent_approved_adjustment_mutation/);
    expect(wave3).toMatch(/CREATE OR REPLACE FUNCTION public\.list_adjustments_missing_journals/);
  });

  it("Inventory page renders Reverse action + lifecycle badges", () => {
    expect(INVENTORY_LIST_PAGE).toMatch(/ReverseAdjustmentDialog/);
    expect(INVENTORY_LIST_PAGE).toMatch(/Reverses #/);
    expect(INVENTORY_LIST_PAGE).toMatch(/Reversed by #/);
  });

  it("Reconciliation card surfaces missing-JE backfill", () => {
    expect(RECON_CARD).toMatch(/useMissingAdjustmentJournals/);
    expect(RECON_CARD).toMatch(/useBackfillAdjustmentJE/);
    expect(RECON_CARD).toMatch(/Post JE now/);
  });

  it("Wave 6 — reconciliation card renders per-row backfill history", () => {
    expect(RECON_CARD).toMatch(/useAdjustmentBackfillHistory/);
    expect(RECON_CARD).toMatch(/Backfill history/);
  });

  it("Wave 6 — useInventory exposes useAdjustmentBackfillHistory hook", () => {
    expect(USE_INVENTORY).toMatch(/export function useAdjustmentBackfillHistory/);
    expect(USE_INVENTORY).toMatch(/stock_adjustment_backfill_log/);
  });
});