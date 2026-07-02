/**
 * Sales → Inventory integrity guards.
 *
 * These tests protect the approved invoice-stock release architecture:
 * invoice confirmation may release stock in one user action, but only by
 * completing a Delivery Note and writing stock_movements. It must never fall
 * back to direct product quantity edits or stale journal_entries columns.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const MIGRATION = readFileSync(
  "supabase/migrations/20260429192604_8c62bcaa-8534-4b95-a83b-c5c6ffab7654.sql",
  "utf8",
);

const CONFIRM_GL = readFileSync("src/hooks/invoices/confirmInvoiceGL.ts", "utf8");
const USE_INVOICES = readFileSync("src/hooks/useInvoices.ts", "utf8");
const USE_INVOICES_PAGINATED = readFileSync("src/hooks/useInvoicesPaginated.ts", "utf8");
const INVOICE_LIST = readFileSync("src/components/invoices/InvoiceListTable.tsx", "utf8");

function functionBody(name: string): string {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} should be defined`).toBeGreaterThanOrEqual(0);
  const end = MIGRATION.indexOf("GRANT EXECUTE", start);
  expect(end, `${name} should be followed by GRANT EXECUTE`).toBeGreaterThan(start);
  return MIGRATION.slice(start, end);
}

describe("sales invoice stock release architecture", () => {
  it("completes deliveries through stock movements and canonical COGS posting", () => {
    const body = functionBody("complete_delivery_atomic");

    expect(body).toContain("INSERT INTO public.stock_movements");
    expect(body).toContain("'delivery_note', p_dn_id");
    expect(body).toContain("-ABS(v_item.quantity_delivered)");
    expect(body).toContain("public.post_journal_entry_atomic");
    expect(body).toContain("_source_type := 'delivery_note'");
    expect(body).toContain("_source_subtype := 'cogs'");
    expect(body).not.toMatch(/INSERT\s+INTO\s+public\.journal_entries/i);
    expect(body).not.toMatch(/\bmemo\b/i);
  });

  it("keeps invoice confirmation one-action while preserving delivery traceability", () => {
    const body = functionBody("confirm_invoice_and_release_stock_atomic");

    expect(body).toContain("p_release_stock boolean DEFAULT true");
    expect(body).toContain("public.confirm_invoice_atomic");
    expect(body).toContain("public.complete_delivery_atomic");
    expect(body).toContain("'stock_released'");
    expect(body).toContain("'delivery_note_id'");
  });

  it("fires low/out-of-stock alerts from warehouse_stock changes, not product aggregate checks", () => {
    const alertBody = functionBody("check_warehouse_stock_alerts");

    expect(alertBody).toContain("FROM public.warehouse_stock ws");
    expect(alertBody).toContain("v_ws.quantity <= 0");
    expect(alertBody).toContain("v_ws.quantity <= v_threshold");
    expect(MIGRATION).toContain("CREATE TRIGGER trg_warehouse_stock_alerts");
    expect(MIGRATION).toContain("AFTER INSERT OR UPDATE OF quantity ON public.warehouse_stock");
  });

  it("uses the release-stock RPC by default from both invoice hooks", () => {
    expect(CONFIRM_GL).toContain("confirm_invoice_and_release_stock_atomic");
    expect(CONFIRM_GL).toContain("const releaseStock = deps.releaseStock !== false");
    expect(CONFIRM_GL).toContain("p_release_stock: true");
    expect(USE_INVOICES).toContain("releaseStock: true");
    expect(USE_INVOICES_PAGINATED).toContain("releaseStock: true");
  });

  it("surfaces the stock-releasing action in invoice list UI", () => {
    expect(INVOICE_LIST).toContain("Confirm &amp; Release Stock");
    expect(INVOICE_LIST).toContain("Confirm, Release Stock &amp; Send");
    expect(INVOICE_LIST).not.toContain("Confirm &amp; Post");
  });
});