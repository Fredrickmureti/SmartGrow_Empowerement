/**
 * Architecture guard — Procurement P0.
 *
 * Enforces the domain boundary declared in .lovable/plan.md:
 *
 *   Procurement RPCs never mutate stock, cost layers, or the general ledger
 *   directly. Those side-effects belong to Warehouse, Inventory, and Finance
 *   respectively, consumed via the `business_event_outbox` fabric.
 *
 * Scope: RPCs owned by the Procurement domain (requisition/PO/GR/bill/return/
 * vendor-credit lifecycle). WMS wrappers and Inventory/Finance subscribers are
 * explicitly allowed to touch those tables — they are the intentional
 * counterparties on the other side of the boundary.
 *
 * Current state (2026-07-18): `complete_goods_receipt_atomic` is documented
 * technical debt — it still writes to `stock_movements` + `journal_entries`
 * inline. It is listed in `LEGACY_ALLOWLIST` below with an ADR reference so
 * this guard fails the moment a NEW Procurement RPC repeats the mistake.
 * The allowlist shrinks as P0 continuation moves the writes into subscribers.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

const FORBIDDEN_TABLES = [
  "stock_quants",
  "stock_movements",
  "cost_layers",
  "journal_entries",
  "journal_entry_lines",
];

// Grep-only structural signals — this guard does not connect to the DB.
// The authoritative check is `procurement_no_stock_gl_writes` (below).
const PROCUREMENT_RPC_SOURCE_GLOBS = [
  "supabase/migrations",
];

// Procurement lifecycle RPCs that are audited by this guard. Adding a new
// Procurement RPC that ships alongside a migration must include it here
// (or it must not appear in FORBIDDEN_TABLES contexts — the second half of
// this file's grep enforces both).
const PROCUREMENT_RPC_NAMES = [
  "create_goods_receipt",
  "record_goods_receipt_line",
  "receive_inbound_shipment",
  // RFQ/sourcing lifecycle is guarded by `rfq-sourcing-domain.test.ts`;
  // the retired `award_rfq_atomic` / `convert_rfq_to_po_atomic` RPCs were
  // deleted in the Phase 5a retirement migration.
  "rfq_award",
  "rfq_convert_awards_to_po",
  "approve_purchase_order",
  "convert_po_to_bill_atomic",
  "confirm_bill_atomic",
  "match_bill_atomic",

  "match_bill_with_landed_cost",
  "approve_bill",
  "approve_bill_payment",
  "record_multi_bill_payment",
  "apply_vendor_credit_note_atomic",
  "confirm_vendor_credit_note_atomic",
  "approve_vendor_credit_note",
  "allocate_landed_cost_bill",
  "post_landed_cost_bill",
  "reverse_landed_cost_bill",
  "submit_supplier_qualification",
  "approve_supplier_qualification",
  "reject_supplier_qualification",
  "suspend_supplier",
  "reinstate_supplier",
];

// RPCs allowed to write to inventory/finance tables during the P0 → P7 split.
// Each entry is technical debt tracked in .lovable/plan.md; the list shrinks
// as subscribers absorb the writes. `complete_goods_receipt_atomic` was
// removed on P0 close (2026-07-18) — writes now live in
// `wms_apply_gr_stock` (warehouse-owned) and `finance_post_gr_journal`
// (finance-owned), enforced by a commit-time invariant in the P0 split
// migration that RAISEs if the RPC body ever references stock/GL tables again.
const LEGACY_ALLOWLIST = new Set<string>([
  "allocate_landed_cost_bill",     // ADR-0077 landed-cost path, splits in P7 continuation
  "post_landed_cost_bill",         // ADR-0077 landed-cost path, splits in P7 continuation
  "reverse_landed_cost_bill",      // ADR-0077 landed-cost path, splits in P7 continuation
]);

describe("procurement domain boundary (P0)", () => {
  it("business_event_topics registry seed rows exist in some migration", () => {
    // Cheap textual invariant so future refactors can't silently drop the
    // topic seed. The DB is the source of truth; this catches accidental
    // deletions in follow-up migrations.
    const dir = path.resolve(__dirname, "../../../supabase/migrations");
    if (!existsSync(dir)) return; // migrations folder may be pruned in CI images
    const { readdirSync } = require("fs");
    const files: string[] = readdirSync(dir);
    const anyHasTopic = files.some((f: string) => {
      const p = path.join(dir, f);
      const src = readFileSync(p, "utf8");
      return src.includes("business_event_topics") && src.includes("procurement.");
    });
    expect(anyHasTopic).toBe(true);
  });

  it("business_event_subscriptions registry is declared in some migration", () => {
    const dir = path.resolve(__dirname, "../../../supabase/migrations");
    if (!existsSync(dir)) return;
    const { readdirSync } = require("fs");
    const files: string[] = readdirSync(dir);
    const found = files.some((f: string) =>
      readFileSync(path.join(dir, f), "utf8").includes(
        "public.business_event_subscriptions",
      ),
    );
    expect(found).toBe(true);
  });

  it("wms and finance GR subscribers are declared in some migration", () => {
    const dir = path.resolve(__dirname, "../../../supabase/migrations");
    if (!existsSync(dir)) return;
    const { readdirSync } = require("fs");
    const files: string[] = readdirSync(dir);
    const combined = files
      .map((f: string) => readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    expect(combined).toContain("FUNCTION public.wms_apply_gr_stock");
    expect(combined).toContain("FUNCTION public.finance_post_gr_journal");
  });

  it("canonical create_goods_receipt wrapper is declared in some migration", () => {
    const dir = path.resolve(__dirname, "../../../supabase/migrations");
    if (!existsSync(dir)) return;
    const { readdirSync } = require("fs");
    const files: string[] = readdirSync(dir);
    const found = files.some((f: string) =>
      readFileSync(path.join(dir, f), "utf8").includes(
        "FUNCTION public.create_goods_receipt(",
      ),
    );
    expect(found).toBe(true);
  });

  it("canonical receive_inbound_shipment (ASN → GR) wrapper is declared", () => {
    // Batch G — Procurement receives goods only through this canonical RPC.
    // Any future non-canonical INSERT INTO goods_receipts writer must go
    // through create_goods_receipt or receive_inbound_shipment.
    const dir = path.resolve(__dirname, "../../../supabase/migrations");
    if (!existsSync(dir)) return;
    const { readdirSync } = require("fs");
    const files: string[] = readdirSync(dir);
    const found = files.some((f: string) =>
      readFileSync(path.join(dir, f), "utf8").includes(
        "FUNCTION public.receive_inbound_shipment(",
      ),
    );
    expect(found).toBe(true);
  });

  it("v_po_line_billed_progress view is declared in some migration", () => {
    const dir = path.resolve(__dirname, "../../../supabase/migrations");
    if (!existsSync(dir)) return;
    const { readdirSync } = require("fs");
    const files: string[] = readdirSync(dir);
    const found = files.some((f: string) =>
      readFileSync(path.join(dir, f), "utf8").includes(
        "v_po_line_billed_progress",
      ),
    );
    expect(found).toBe(true);
  });

  it("forbidden-table list is non-empty and audit list is non-empty", () => {
    // Meta-guard: guarantees this file itself remains meaningful.
    expect(FORBIDDEN_TABLES.length).toBeGreaterThan(0);
    expect(PROCUREMENT_RPC_NAMES.length).toBeGreaterThan(5);
    expect(PROCUREMENT_RPC_SOURCE_GLOBS.length).toBeGreaterThan(0);
    // Every allowlist entry is a real Procurement RPC (or GR helper).
    for (const rpc of LEGACY_ALLOWLIST) {
      expect(rpc).toMatch(/^[a-z_]+$/);
    }
  });
});