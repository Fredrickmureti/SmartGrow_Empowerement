/**
 * resolveSourceDocumentRecord — the bridge that retires the legacy
 * `generate-document` render path.
 *
 * Historically two rendering backends existed side by side:
 *
 *   • document-model records → `render-document` (snapshot is the record,
 *     artifact is archived, reprints are byte-identical — ADR-0084)
 *   • bare `(documentType, documentId)` pairs → `generate-document`
 *     (live re-read at render time, nothing archived, no audit trail)
 *
 * Every surface that still speaks the legacy pair — preview dialogs, POS
 * PDF actions, recovered ledger rows written before the migration — now
 * resolves through here first. The pair is mapped to its snapshot builder,
 * frozen into a `document_records` row via `ensure_document_record`, and
 * rendered through the ONE renderer. `ensure_document_record` is an
 * idempotent upsert keyed on (module, doc type, doc id), so resolving the
 * same pair twice returns the same record rather than duplicating history.
 *
 * Adding a document kind means adding a registry row here — never a second
 * render call path.
 */
import { supabase } from "@/integrations/supabase/client";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";

import { fetchAndBuildSalesInvoiceSnapshot } from "@/services/documents/snapshots/salesInvoice";
import { fetchAndBuildSalesEstimateSnapshot } from "@/services/documents/snapshots/salesEstimate";
import { fetchAndBuildSalesOrderSnapshot } from "@/services/documents/snapshots/salesOrder";
import { fetchAndBuildSalesProformaSnapshot } from "@/services/documents/snapshots/salesProforma";
import { fetchAndBuildSalesCreditNoteSnapshot } from "@/services/documents/snapshots/salesCreditNote";
import { fetchAndBuildSalesReturnSnapshot } from "@/services/documents/snapshots/salesReturn";
import { fetchAndBuildSalesDeliveryNoteSnapshot } from "@/services/documents/snapshots/salesDeliveryNote";
import { fetchAndBuildCustomerStatementSnapshot } from "@/services/documents/snapshots/salesCustomerStatement";
import {
  fetchAndBuildPaymentReceiptSnapshot,
  resolveAndBuildReceiptSnapshot,
} from "@/services/documents/snapshots/salesPaymentReceipt";
import { fetchAndBuildPurchasesBillSnapshot } from "@/services/documents/snapshots/purchasesBill";
import { fetchAndBuildPurchasesPoSnapshot } from "@/services/documents/snapshots/purchasesPo";
import { fetchAndBuildPurchasesRfqSnapshot } from "@/services/documents/snapshots/purchasesRfq";
import { fetchAndBuildPurchasesRequisitionSnapshot } from "@/services/documents/snapshots/purchasesRequisition";
import { fetchAndBuildPurchasesReturnSnapshot } from "@/services/documents/snapshots/purchasesReturn";
import { fetchAndBuildVendorCreditNoteSnapshot } from "@/services/documents/snapshots/purchasesVendorCreditNote";
import { fetchAndBuildPurchasesGrnSnapshot } from "@/services/documents/snapshots/purchasesGrn";
import { fetchAndBuildVendorStatementSnapshot } from "@/services/documents/snapshots/purchasesVendorStatement";
import { fetchAndBuildFinanceJournalEntrySnapshot } from "@/services/documents/snapshots/financeJournalEntry";
import { fetchAndBuildLandedCostVoucherSnapshot } from "@/services/documents/snapshots/purchasesLandedCostVoucher";
import {
  fetchFrozenPosReceipt,
} from "@/features/pos/receipts/dispatchPosReceipt";
import { buildPosReceiptSnapshot } from "@/services/documents/snapshots/posReceipt";
import {
  fetchAndBuildHrLetterSnapshot,
  HR_LETTER_KIND_CODES,
} from "@/services/documents/snapshots/hrLetter";

/** Tenancy fallbacks used only when the snapshot cannot resolve them. */
export interface SourceDocumentContext {
  organizationId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
}

/** Normalised builder output — every snapshot builder maps onto this. */
interface BuiltSnapshot {
  snapshot: Record<string, unknown>;
  documentNumber: string | null;
  documentDate: string | null;
  organizationId: string | null;
  businessId: string | null;
  branchId: string | null;
  currency: string | null;
  partyId: string | null;
  /**
   * Optional identity override. Used when one legacy document type can be
   * anchored on more than one row (a receipt viewed from a payment vs from
   * an invoice), so each anchor freezes its own record instead of colliding.
   */
  sourceDocType?: string;
  sourceDocId?: string;
}

interface RegistryEntry {
  kindCode: string;
  sourceModule: string;
  sourceDocType: string;
  partyKind: "customer" | "supplier" | "employee" | null;
  build: (documentId: string) => Promise<BuiltSnapshot>;
}


/** Builders expose party ids under domain-specific names; normalise them. */
function normalise(built: Record<string, unknown>): BuiltSnapshot {
  return {
    snapshot: (built.snapshot ?? {}) as Record<string, unknown>,
    documentNumber: (built.documentNumber as string | null) ?? null,
    documentDate: (built.documentDate as string | null) ?? null,
    organizationId: (built.organizationId as string | null) ?? null,
    businessId: (built.businessId as string | null) ?? null,
    branchId: (built.branchId as string | null) ?? null,
    currency: (built.currency as string | null) ?? null,
    partyId:
      (built.partyId as string | null) ??
      (built.contactId as string | null) ??
      (built.customerId as string | null) ??
      (built.vendorId as string | null) ??
      null,
  };
}

const wrap =
  (fn: (client: typeof supabase, id: string) => Promise<unknown>) =>
  async (id: string): Promise<BuiltSnapshot> =>
    normalise((await fn(supabase, id)) as Record<string, unknown>);

/**
 * Legacy `documentType` → document-model identity. Keys are the exact
 * strings the pre-document-model surfaces pass around.
 */
const REGISTRY: Record<string, RegistryEntry> = {
  // HR letters. Registered here so preview / download / email surfaces can
  // speak the legacy `(documentType, documentId)` pair and still land on the
  // ONE renderer with a frozen snapshot — exactly like `dispatchHrLetter`
  // does for the print path.
  contract_letter: {
    kindCode: HR_LETTER_KIND_CODES.contract_letter,
    sourceModule: "hr",
    sourceDocType: "employee_contract",
    partyKind: "employee",
    build: async (id: string) =>
      normalise(
        (await fetchAndBuildHrLetterSnapshot(
          supabase,
          "contract_letter",
          id,
        )) as unknown as Record<string, unknown>,
      ),
  },


  invoice: {
    kindCode: "sales.invoice",
    sourceModule: "sales",
    sourceDocType: "invoice",
    partyKind: "customer",
    build: wrap(fetchAndBuildSalesInvoiceSnapshot),
  },
  estimate: {
    kindCode: "sales.estimate",
    sourceModule: "sales",
    sourceDocType: "estimate",
    partyKind: "customer",
    build: wrap(fetchAndBuildSalesEstimateSnapshot),
  },
  sales_order: {
    kindCode: "sales.order",
    sourceModule: "sales",
    sourceDocType: "sales_order",
    partyKind: "customer",
    build: wrap(fetchAndBuildSalesOrderSnapshot),
  },
  proforma: {
    kindCode: "sales.proforma",
    sourceModule: "sales",
    sourceDocType: "proforma",
    partyKind: "customer",
    build: wrap(fetchAndBuildSalesProformaSnapshot),
  },
  credit_note: {
    kindCode: "sales.credit_note",
    sourceModule: "sales",
    sourceDocType: "credit_note",
    partyKind: "customer",
    build: wrap(fetchAndBuildSalesCreditNoteSnapshot),
  },
  sales_return: {
    kindCode: "sales.return",
    sourceModule: "sales",
    sourceDocType: "sales_return",
    partyKind: "customer",
    build: wrap(fetchAndBuildSalesReturnSnapshot),
  },
  delivery_note: {
    kindCode: "sales.delivery_note",
    sourceModule: "sales",
    sourceDocType: "delivery_note",
    partyKind: "customer",
    build: wrap(fetchAndBuildSalesDeliveryNoteSnapshot),
  },
  customer_statement: {
    kindCode: "sales.statement",
    sourceModule: "sales",
    sourceDocType: "customer_statement",
    partyKind: "customer",
    build: wrap(fetchAndBuildCustomerStatementSnapshot),
  },
  payment_receipt: {
    kindCode: "sales.payment_receipt",
    sourceModule: "sales",
    sourceDocType: "payment_receipt",
    partyKind: "customer",
    build: wrap(fetchAndBuildPaymentReceiptSnapshot),
  },
  /**
   * The legacy `receipt` type is anchor-agnostic: Sales → Payments passes a
   * payment id, the invoice row action passes an invoice id. Both freeze a
   * receipt snapshot; the invoice anchor restricts it to that invoice and
   * keys its own record so the two never overwrite each other.
   */
  receipt: {
    kindCode: "sales.payment_receipt",
    sourceModule: "sales",
    sourceDocType: "payment_receipt",
    partyKind: "customer",
    build: async (id: string) => {
      const built = await resolveAndBuildReceiptSnapshot(supabase, id);
      return {
        ...normalise(built as unknown as Record<string, unknown>),
        sourceDocType:
          built.anchor === "invoice"
            ? "payment_receipt_invoice"
            : "payment_receipt",
        sourceDocId: built.anchor === "invoice" ? built.anchorId : built.sourceDocId,
      };
    },
  },
  bill: {
    kindCode: "purchases.bill",
    sourceModule: "purchases",
    sourceDocType: "bill",
    partyKind: "supplier",
    build: wrap(fetchAndBuildPurchasesBillSnapshot),
  },
  purchase_order: {
    kindCode: "purchases.po",
    sourceModule: "purchases",
    sourceDocType: "purchase_order",
    partyKind: "supplier",
    build: wrap(fetchAndBuildPurchasesPoSnapshot),
  },
  rfq: {
    kindCode: "purchases.rfq",
    sourceModule: "purchases",
    sourceDocType: "rfq",
    // Supplier-neutral: one RFQ document is issued to every invited bidder.
    partyKind: null,
    build: async (id: string) => {
      const built = await fetchAndBuildPurchasesRfqSnapshot(supabase, id);
      return {
        ...normalise(built as unknown as Record<string, unknown>),
        sourceDocType: `rfq:r${built.revision}:buyer`,
        sourceDocId: built.sourceDocId,
      };
    },
  },
  purchase_requisition: {
    kindCode: "purchases.requisition",
    sourceModule: "purchases",
    sourceDocType: "purchase_requisition",
    // Internal demand record — there is no counterparty to address, and
    // the kind carries no `email` intent.
    partyKind: null,
    build: wrap(fetchAndBuildPurchasesRequisitionSnapshot),
  },
  purchase_return: {
    kindCode: "purchases.return",
    sourceModule: "purchases",
    sourceDocType: "purchase_return",
    partyKind: "supplier",
    build: wrap(fetchAndBuildPurchasesReturnSnapshot),
  },
  vendor_credit_note: {
    kindCode: "purchases.credit_note",
    sourceModule: "purchases",
    sourceDocType: "vendor_credit_note",
    partyKind: "supplier",
    build: wrap(fetchAndBuildVendorCreditNoteSnapshot),
  },

  goods_receipt: {
    kindCode: "purchases.grn",
    sourceModule: "purchases",
    sourceDocType: "goods_receipt",
    partyKind: "supplier",
    build: wrap(fetchAndBuildPurchasesGrnSnapshot),
  },
  vendor_statement: {
    kindCode: "purchases.statement",
    sourceModule: "purchases",
    sourceDocType: "vendor_statement",
    partyKind: "supplier",
    build: wrap(fetchAndBuildVendorStatementSnapshot),
  },
  /**
   * Journal voucher — internal accounting evidence. No counterparty, so
   * `partyKind` is null (same rationale as a purchase requisition); the
   * kind carries no `email` intent.
   */
  journal_entry: {
    kindCode: "finance.journal_entry",
    sourceModule: "finance",
    sourceDocType: "journal_entry",
    partyKind: null,
    build: wrap(fetchAndBuildFinanceJournalEntrySnapshot),
  },
  /**
   * Landed cost voucher — internal costing evidence. The supplier who
   * invoiced the freight is not the audience, so `partyKind` is null and
   * the kind carries no `email` intent.
   */
  landed_cost_voucher: {
    kindCode: "purchases.landed_cost_voucher",
    sourceModule: "purchases",
    sourceDocType: "landed_cost_voucher",
    partyKind: null,
    build: wrap(fetchAndBuildLandedCostVoucherSnapshot),
  },
  pos_receipt: {
    kindCode: "pos.receipt_customer",
    sourceModule: "pos",
    sourceDocType: "receipt",
    partyKind: null,
    // POS always replays the frozen `pos_receipt_snapshots.payload` written
    // at sale time — never a live re-read of the transaction.
    build: async (id: string) => {
      const frozen = await fetchFrozenPosReceipt(id);
      const built = buildPosReceiptSnapshot({ frozen, copy: "customer" });
      return {
        ...normalise(built as unknown as Record<string, unknown>),
        organizationId:
          ((frozen as { organization?: { id?: string } }).organization?.id ??
            null) as string | null,
      };
    },
  },
};

/** Document types that can be resolved to a document-model record. */
export function canResolveSourceDocument(documentType: string): boolean {
  return documentType in REGISTRY;
}

export const RESOLVABLE_SOURCE_DOCUMENT_TYPES = Object.freeze(
  Object.keys(REGISTRY),
);

/**
 * Freeze a legacy `(documentType, documentId)` pair into a
 * `document_records` row and return its id. Idempotent per pair.
 */
export async function resolveSourceDocumentRecordId(
  documentType: string,
  documentId: string,
  ctx: SourceDocumentContext = {},
): Promise<string> {
  const entry = REGISTRY[documentType];
  if (!entry) {
    throw new Error(
      `unsupported_document_type: ${documentType} has no snapshot builder — ` +
        `register one in resolveSourceDocumentRecord.ts instead of adding a render path`,
    );
  }
  if (!documentId) throw new Error(`missing_document_id for ${documentType}`);

  const built = await entry.build(documentId);
  const organizationId = built.organizationId ?? ctx.organizationId ?? null;
  if (!organizationId) {
    throw new Error(
      `cannot_resolve_organization for ${documentType}:${documentId}`,
    );
  }

  return ensureDocumentRecord({
    kindCode: entry.kindCode,
    organizationId,
    sourceModule: entry.sourceModule,
    sourceDocType: built.sourceDocType ?? entry.sourceDocType,
    sourceDocId: built.sourceDocId ?? documentId,
    businessId: built.businessId ?? ctx.businessId ?? null,
    branchId: built.branchId ?? ctx.branchId ?? null,
    partyKind: entry.partyKind,
    partyId: built.partyId,
    currency: built.currency,
    documentNumber: built.documentNumber,
    documentDate: built.documentDate,
    snapshot: built.snapshot,
  });
}
