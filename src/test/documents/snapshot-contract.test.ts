/**
 * Wave 7.2 — snapshot builder contract test.
 *
 * Every builder under `src/services/documents/snapshots/` must:
 *   1. Return a `snapshot` blob shaped as a plain JSON object.
 *   2. Return a `documentDate` in ISO YYYY-MM-DD form (or null when the
 *      source has no date semantics).
 *   3. Include `document_type` and `document_type_label` on the snapshot
 *      so the renderer can pick a template variant.
 *
 * This guards against drift as new builders land in Wave 7.2. Adding a
 * builder here without also adding it to the SUITE below is caught by
 * the "every builder is covered" meta-check.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildPosReceiptSnapshot } from "@/services/documents/snapshots/posReceipt";
import { buildKitchenTicketSnapshot } from "@/services/documents/snapshots/posKitchenTicket";
import { buildSalesInvoiceSnapshot } from "@/services/documents/snapshots/salesInvoice";
import { buildSalesCreditNoteSnapshot } from "@/services/documents/snapshots/salesCreditNote";
import { buildSalesEstimateSnapshot } from "@/services/documents/snapshots/salesEstimate";
import { buildSalesProformaSnapshot } from "@/services/documents/snapshots/salesProforma";
import { buildSalesDeliveryNoteSnapshot } from "@/services/documents/snapshots/salesDeliveryNote";
import { buildSalesOrderSnapshot } from "@/services/documents/snapshots/salesOrder";
import { buildSalesReturnSnapshot } from "@/services/documents/snapshots/salesReturn";
import { buildPaymentReceiptSnapshot } from "@/services/documents/snapshots/salesPaymentReceipt";
import { buildCustomerStatementSnapshot } from "@/services/documents/snapshots/salesCustomerStatement";
import { buildStatementDataset } from "@/services/finance/customerStatementDataset";

import { buildPurchasesBillSnapshot } from "@/services/documents/snapshots/purchasesBill";
import { buildPurchasesPoSnapshot } from "@/services/documents/snapshots/purchasesPo";
import { buildPurchasesReturnSnapshot } from "@/services/documents/snapshots/purchasesReturn";
import { buildVendorStatementSnapshot } from "@/services/documents/snapshots/purchasesVendorStatement";
import { buildPurchasesGrnSnapshot } from "@/services/documents/snapshots/purchasesGrn";
import { buildHrLetterSnapshot } from "@/services/documents/snapshots/hrLetter";
import { buildReturnDocumentSnapshot } from "@/services/documents/snapshots/wmsReturn";



const SNAPSHOTS_DIR = path.join(process.cwd(), "src/services/documents/snapshots");

// Every fixture below produces a valid input for its builder.
const SUITE: Array<{ file: string; run: () => { snapshot: Record<string, unknown>; documentDate: string | null } }> = [
  {
    file: "posReceipt.ts",
    run: () =>
      buildPosReceiptSnapshot({
        frozen: {
          schema_version: 1,
          transaction: {
            id: "t",
            receipt_number: "R-1",
            transacted_at: "2026-07-27T10:00:00Z",
            total_amount: 100,
          },
          items: [],
          payments: [],
          business: { id: "b" },
          branch: { id: "br" },
          organization: { id: "o" },
          customer: null,
          cashier: null,
          register: null,
        } as never,
      }),
  },
  {
    file: "posKitchenTicket.ts",
    run: () =>
      buildKitchenTicketSnapshot({
        orders: [
          {
            id: "k1",
            transaction_id: "t1",
            printer_category: "kitchen",
            created_at: "2026-07-27T10:00:00Z",
            organization_id: "o",
          },
        ],
        station: "kitchen",
      }),
  },
  {
    file: "salesInvoice.ts",
    run: () =>
      buildSalesInvoiceSnapshot({
        id: "inv-1",
        invoice_number: "INV-2026-0001",
        status: "sent",
        issue_date: "2026-07-27",
        due_date: "2026-08-27",
        subtotal: 100,
        tax_amount: 16,
        discount_amount: 0,
        total: 116,
        amount_paid: 0,
        currency: "KES",
        notes: null,
        terms: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        contact: { name: "Acme Ltd" },
        business: { id: "b", name: "Widget Co" },
        invoice_items: [],
      }),
  },
  {
    file: "salesCreditNote.ts",
    run: () =>
      buildSalesCreditNoteSnapshot({
        id: "cn-1",
        credit_note_number: "CN-2026-0001",
        status: "issued",
        issue_date: "2026-07-27",
        subtotal: 100,
        tax_amount: 16,
        total: 116,
        currency: "KES",
        notes: null,
        reason: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        contact_id: "c-1",
        contact: { name: "Acme Ltd" },
        business: { id: "b", name: "Widget Co" },
        credit_note_items: [],
      }),
  },
  {

    file: "salesEstimate.ts",
    run: () =>
      buildSalesEstimateSnapshot({
        id: "est-1",
        estimate_number: "EST-2026-0001",
        status: "sent",
        issue_date: "2026-07-27",
        expiry_date: "2026-08-10",
        subtotal: 100,
        tax_amount: 16,
        discount_amount: 0,
        total: 116,
        currency: "KES",
        notes: null,
        terms: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        contact: { name: "Acme Ltd" },
        business: { id: "b", name: "Widget Co" },
        estimate_items: [],
      }),
  },
  {
    file: "salesProforma.ts",
    run: () =>
      buildSalesProformaSnapshot({
        id: "pf-1",
        proforma_number: "PF-2026-0001",
        status: "sent",
        issue_date: "2026-07-27",
        expiry_date: "2026-08-10",
        subtotal: 100,
        tax_amount: 16,
        discount_amount: 0,
        total: 116,
        currency: "KES",
        notes: null,
        terms: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        contact: { name: "Acme Ltd" },
        business: { id: "b", name: "Widget Co" },
        proforma_invoice_items: [],
      }),
  },
  {
    file: "salesDeliveryNote.ts",
    run: () =>
      buildSalesDeliveryNoteSnapshot({
        id: "dn-1",
        delivery_number: "DN-2026-0001",
        status: "dispatched",
        delivery_date: "2026-07-27",
        notes: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        shipping_address: null,
        driver_name: null,
        vehicle_number: null,
        shipping_method: null,
        tracking_number: null,
        dispatch_route: null,
        dispatched_at: null,
        delivered_at: null,
        ready_at: null,
        freight_cost: null,
        freight_currency: null,
        is_backorder: false,
        contact: { name: "Acme Ltd" },
        business: { id: "b", name: "Widget Co", base_currency: "KES" },
        items: [],
      }),
  },
  {
    file: "salesOrder.ts",
    run: () =>
      buildSalesOrderSnapshot({
        id: "so-1",
        so_number: "SO-2026-0001",
        status: "confirmed",
        order_date: "2026-07-27",
        expected_date: null,
        subtotal: 100,
        tax_amount: 16,
        discount_amount: 0,
        shipping_amount: 0,
        total: 116,
        currency: "KES",
        notes: null,
        shipping_address: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        contact: { name: "Acme Ltd" },
        business: { id: "b", name: "Widget Co" },
        items: [],
      }),
  },
  {
    file: "salesReturn.ts",
    run: () =>
      buildSalesReturnSnapshot({
        id: "sr-1",
        return_number: "SR-2026-0001",
        status: "approved",
        return_date: "2026-07-27",
        subtotal: 100,
        tax_amount: 16,
        total: 116,
        currency: "KES",
        reason: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        contact: { name: "Acme Ltd" },
        business: { id: "b", name: "Widget Co" },
        items: [],
      }),
  },
  {
    file: "salesPaymentReceipt.ts",
    run: () =>
      buildPaymentReceiptSnapshot(
        {
          id: "pay-1",
          receipt_number: "RCP-2026-0001",
          payment_date: "2026-07-27",
          amount: 100,
          status: "completed",
          currency: "KES",
          notes: null,
          payment_method: "cash",
          reference: null,
          organization_id: "o",
          business_id: "b",
          branch_id: null,
          contact: { name: "Acme Ltd" },
          business: { id: "b", name: "Widget Co", base_currency: "KES" },
        },
        [],
      ),
  },
  {
    file: "salesCustomerStatement.ts",
    run: () =>
      buildCustomerStatementSnapshot({
        statement: {
          id: "stmt-1",
          contact_id: "c-1",
          organization_id: "o",
          business_id: "b",
          branch_id: null,
          period_start: "2026-06-01",
          period_end: "2026-06-30",
          statement_date: "2026-07-01",
          created_at: "2026-07-01T00:00:00Z",
          opening_balance: 0,
          closing_balance: 0,
          total_invoiced: 0,
          total_payments: 0,
          sent_at: null,
          contact: { name: "Acme Ltd" },
          business: { id: "b", name: "Widget Co", base_currency: "KES" },
        },
        dataset: buildStatementDataset({
          rows: [],
          periodStart: "2026-06-01",
          periodEnd: "2026-06-30",
          currency: "KES",
        }),

      }),
  },
  {
    file: "purchasesBill.ts",
    run: () =>
      buildPurchasesBillSnapshot({
        id: "bill-1",
        bill_number: "BILL-2026-0001",
        status: "received",
        bill_date: "2026-07-27",
        due_date: "2026-08-27",
        subtotal: 100,
        tax_amount: 16,
        discount_amount: 0,
        total: 116,
        amount_paid: 0,
        currency: "KES",
        notes: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        vendor_id: "v-1",
        vendor: { name: "Widgets Supplier Ltd" },
        business: { id: "b", name: "Acme Buyer" },
        items: [],
      }),
  },
  {
    file: "purchasesPo.ts",
    run: () =>
      buildPurchasesPoSnapshot({
        id: "po-1",
        po_number: "PO-2026-0001",
        status: "sent",
        order_date: "2026-07-27",
        expected_date: null,
        subtotal: 100,
        tax_amount: 16,
        discount_amount: 0,
        total: 116,
        currency: "KES",
        notes: null,
        shipping_address: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        vendor_id: "v-1",
        vendor: { name: "Widgets Supplier Ltd" },
        business: { id: "b", name: "Acme Buyer" },
        items: [],
      }),
  },
  {
    file: "purchasesReturn.ts",
    run: () =>
      buildPurchasesReturnSnapshot({
        id: "pr-1",
        return_number: "PR-2026-0001",
        status: "approved",
        return_date: "2026-07-27",
        subtotal: 100,
        tax_amount: 16,
        total: 116,
        currency: "KES",
        notes: null,
        reason: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        vendor_id: "v-1",
        contact: { name: "Widgets Supplier Ltd" },
        business: { id: "b", name: "Acme Buyer", base_currency: "KES" },
        items: [],
      }),
  },
  {
    file: "purchasesVendorStatement.ts",
    run: () =>
      buildVendorStatementSnapshot({
        statement: {
          id: "vs-1",
          contact_id: "v-1",
          organization_id: "o",
          business_id: "b",
          branch_id: null,
          period_start: "2026-06-01",
          period_end: "2026-06-30",
          statement_date: "2026-06-30",
          created_at: "2026-06-30T00:00:00Z",
          opening_balance: 0,
          closing_balance: null,
          total_billed: 0,
          total_payments: 0,
          sent_at: null,
          contact: { name: "Widgets Supplier Ltd" },
          business: { id: "b", name: "Acme", base_currency: "KES" },
        },
        dataset: buildVendorStatementDataset({
          rows: [],
          periodStart: "2026-06-01",
          periodEnd: "2026-06-30",
        }),
      }),
  },
  {
    file: "purchasesGrn.ts",
    run: () =>
      buildPurchasesGrnSnapshot({
        id: "grn-1",
        receipt_number: "GRN-1",
        status: "received",
        receipt_date: "2026-07-27",
        notes: null,
        organization_id: "o",
        business_id: "b",
        branch_id: null,
        purchase_order_id: "po-1",
        purchase_order: { po_number: "PO-1", currency: "KES", vendor_id: "v-1", vendor: null },
        items: [],
      }),
  },
  {
    file: "hrLetter.ts",
    run: () =>
      buildHrLetterSnapshot("contract_letter", {
        id: "ctr-1",
        contract_reference: "CTR-1",
        organization_id: "o",
        business_id: "b",
        employee_id: "e-1",
        start_date: "2026-07-01",
        approved_at: "2026-07-27T00:00:00Z",
        wage: 1000,
        working_schedule: "Full time",
        organization: { id: "o", name: "Acme" },
        employee: { id: "e-1", first_name: "A", last_name: "B" },
      }),
  },
  {
    file: "wmsReturn.ts",
    run: () =>
      buildReturnDocumentSnapshot(
        {
          id: "ro-1",
          code: "RMA-1",
          rma_reference: null,
          return_kind: "customer",
          state: "received",
          organization_id: "o",
          business_id: "b",
          branch_id: null,
          warehouse_id: "w-1",
          customer_id: "c-1",
          vendor_id: null,
          tracking_reference: null,
          notes: null,
          expected_at: "2026-07-27",
          received_at: "2026-07-28",
          created_at: "2026-07-27T00:00:00Z",
          customer: { name: "Acme Retail" },
          vendor: null,
          lines: [],
        },
        "wms.return_receipt",
      ),
  },
];



describe("snapshot builder contract", () => {
  for (const entry of SUITE) {
    it(`${entry.file} emits document_type/label and a well-formed documentDate`, () => {
      const { snapshot, documentDate } = entry.run();
      expect(snapshot).toBeTypeOf("object");
      expect(snapshot).toHaveProperty("document_type");
      expect(snapshot).toHaveProperty("document_type_label");
      expect(typeof snapshot.document_type).toBe("string");
      expect(typeof snapshot.document_type_label).toBe("string");
      if (documentDate !== null) {
        expect(documentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  }

  it("every builder file under snapshots/ is covered by SUITE", () => {
    // Non-builder modules: barrel + shared projection helpers.
    const NON_BUILDERS = new Set([
      "index.ts",
      "lineItemUom.ts",
      "partyAddress.ts",
      "paymentTerm.ts",
    ]);
    const files = fs
      .readdirSync(SNAPSHOTS_DIR)
      .filter((f) => f.endsWith(".ts") && !NON_BUILDERS.has(f));
    const covered = new Set(SUITE.map((s) => s.file));
    const missing = files.filter((f) => !covered.has(f));
    expect(
      missing,
      `snapshot builders missing from snapshot-contract.test.ts SUITE: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
