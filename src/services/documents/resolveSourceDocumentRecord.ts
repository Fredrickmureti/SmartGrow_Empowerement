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

import { fetchAndBuildFinanceJournalEntrySnapshot } from "@/services/documents/snapshots/financeJournalEntry";
import {
  fetchAndBuildLoanAgreementSnapshot,
  fetchAndBuildRepaymentScheduleSnapshot,
  fetchAndBuildLoanStatementSnapshot,
  fetchAndBuildLoanPaymentReceiptSnapshot,
  fetchAndBuildClientStatementSnapshot,
  fetchAndBuildClientChargeReceiptSnapshot,
  fetchAndBuildFeeCollectionReceiptSnapshot,
} from "@/services/documents/snapshots/lending";

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
   * Lending paperwork. The counterparty is an `mf_clients` row, not a
   * contact, so `partyKind` is null — the client is carried inside the
   * frozen snapshot. Each kind pins a dedicated sheet-only layout.
   */
  loan_agreement: {
    kindCode: "lending.loan_agreement",
    sourceModule: "lending",
    sourceDocType: "loan_agreement",
    partyKind: null,
    build: wrap(fetchAndBuildLoanAgreementSnapshot),
  },
  repayment_schedule: {
    kindCode: "lending.repayment_schedule",
    sourceModule: "lending",
    sourceDocType: "repayment_schedule",
    partyKind: null,
    build: wrap(fetchAndBuildRepaymentScheduleSnapshot),
  },
  loan_statement: {
    kindCode: "lending.loan_statement",
    sourceModule: "lending",
    sourceDocType: "loan_statement",
    partyKind: null,
    build: wrap(fetchAndBuildLoanStatementSnapshot),
  },
  loan_payment_receipt: {
    kindCode: "lending.payment_receipt",
    sourceModule: "lending",
    sourceDocType: "loan_payment_receipt",
    partyKind: null,
    build: wrap(fetchAndBuildLoanPaymentReceiptSnapshot),
  },
  client_statement: {
    kindCode: "lending.client_statement",
    sourceModule: "lending",
    sourceDocType: "client_statement",
    partyKind: null,
    build: wrap(fetchAndBuildClientStatementSnapshot),
  },
  client_charge_receipt: {
    kindCode: "lending.payment_receipt",
    sourceModule: "lending",
    sourceDocType: "client_charge_receipt",
    partyKind: null,
    build: wrap(fetchAndBuildClientChargeReceiptSnapshot),
  },
  fee_collection_receipt: {
    kindCode: "lending.payment_receipt",
    sourceModule: "lending",
    sourceDocType: "fee_collection_receipt",
    partyKind: null,
    build: wrap(fetchAndBuildFeeCollectionReceiptSnapshot),
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
