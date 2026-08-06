/**
 * DocumentRecordView — the canonical description of a business document.
 *
 * Every transactional document in the platform is expressed as this one
 * shape. The full-page object view (`RecordScaffold`) and the drawer peek
 * (`PeekScaffold`) are two *projections* of the same descriptor, so they
 * cannot drift: there is nothing to keep in sync, because there is only one
 * declaration.
 *
 * A feature module's job is to map its database row to this descriptor.
 * It must not decide layout, spacing, status colour, totals ordering or
 * action placement — those live in the projections.
 */
import type { ReactNode } from "react";
import type { DocumentKind } from "./documentStatus";
import type { DocumentMoney } from "./money";
import type { DocumentActivityEntry, DocumentTotalsRow } from "./panels";
import type { LineItemColumn, LineItemRow } from "./LineItemsGrid";
import type { DetailField } from "./RecordBody";
import type { LifecycleDocType } from "./DocumentLifecycleStrip";

export interface DocumentRecordView {
  // ---- Identity -----------------------------------------------------
  /** Drives the status vocabulary and lifecycle traversal. */
  kind: DocumentKind;
  /** Small label above the title, e.g. "Sales Invoice". */
  eyebrow: string;
  /** Route back to the owning list, e.g. "/sales/invoices". */
  listPath: string;
  /** Primary heading — the counterparty, not the document number. */
  title: ReactNode;
  /** Row id. Supplying it wires the audit-backed activity feed automatically. */
  documentId?: string;
  /** The document's own identifier, e.g. "INV-2026-0148". */
  docNumber?: ReactNode;
  /** Raw status value; rendered through the status registry. */
  status?: string | null;
  /** Optional override when a document's state is not a single column. */
  statusSlot?: ReactNode;
  /** Supporting header facts (dates, owner, terms). */
  meta?: ReactNode;

  // ---- State --------------------------------------------------------
  loading?: boolean;
  error?: string | null;
  notFound?: boolean;

  // ---- Money --------------------------------------------------------
  /** Raw amounts; the totals ladder is derived from these. */
  money?: DocumentMoney;
  /** Escape hatch for documents whose summary is not a totals ladder. */
  totalsRows?: DocumentTotalsRow[];
  totalsFooter?: ReactNode;
  /** Label for the settlement remainder ("Balance due", "Refund due"). */
  balanceLabel?: string;

  // ---- Body ---------------------------------------------------------
  detailFields?: DetailField[];
  detailsTitle?: string;
  lineColumns?: LineItemColumn[];
  lineRows?: LineItemRow[];
  lineEmpty?: ReactNode;
  /** Extra sections appended after the line items. */
  extraSections?: ReactNode;

  // ---- Context ------------------------------------------------------
  /**
   * Escape hatch only. Leave undefined and set `documentId`: the activity
   * feed is then sourced from `audit_logs` + `document_emails` rather than
   * synthesised from the row's own columns.
   */
  activity?: DocumentActivityEntry[];
  /**
   * Document milestones that are not audited mutations (a customer
   * e-signature, a conversion timestamp). Merged into the audit feed.
   */
  activityExtra?: DocumentActivityEntry[];
  /** Order-to-cash traversal anchor. Omit for non-lifecycle documents. */
  lifecycle?: { docType: LifecycleDocType; docId: string };
  /** Additional right-rail panels. */
  extraAside?: ReactNode;
}
