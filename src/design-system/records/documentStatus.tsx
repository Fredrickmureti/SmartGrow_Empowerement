/**
 * documentStatus — the single status vocabulary for every business document
 * in the platform.
 *
 * Before this registry, each list page, peek sheet and record page carried
 * its own `STATUS_TONE` / `STATUS_LABEL` / `getStatusBadge()` map, so the
 * same invoice could read "Partial" in one surface and "Partially paid" in
 * another, with a different colour. One document, one word, one tone —
 * everywhere.
 *
 * Adding a status: extend BASE (if it is generic) or the per-kind override.
 * Never re-declare a status map inside a feature module; the architecture
 * test `document-workspace-canonical.test.ts` fails the build if you do.
 */
import type { ReactNode } from "react";
import { StatusBadge } from "@/design-system";

export type DocumentStatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

export type DocumentKind =
  | "invoice"
  | "estimate"
  | "proforma"
  | "sales_order"
  | "delivery_note"
  | "credit_note"
  | "sales_return"
  | "customer_payment"
  | "recurring_invoice"
  | "statement"
  | "customer"
  | "bill"
  | "purchase_order"
  | "vendor_credit_note"
  | "purchase_return"
  | "rfq"
  | "expense"
  | "vendor_statement"
  | "requisition"
  | "contract"
  | "stock_movement"
  | "journal_entry"
  | "stock_adjustment"
  | "stock_transfer"
  | "landed_cost_voucher"
  | "generic";


interface StatusMeta {
  label: string;
  tone: DocumentStatusTone;
}

/** Statuses whose meaning does not change between document types. */
const BASE: Record<string, StatusMeta> = {
  draft: { label: "Draft", tone: "neutral" },
  pending: { label: "Pending", tone: "warning" },
  submitted: { label: "Submitted", tone: "info" },
  confirmed: { label: "Confirmed", tone: "info" },
  approved: { label: "Approved", tone: "info" },
  sent: { label: "Sent", tone: "info" },
  viewed: { label: "Viewed", tone: "accent" },
  partial: { label: "Partially paid", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  overdue: { label: "Overdue", tone: "danger" },
  expired: { label: "Expired", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  converted: { label: "Converted", tone: "success" },
  completed: { label: "Completed", tone: "success" },
  processed: { label: "Processed", tone: "success" },
  refunded: { label: "Refunded", tone: "success" },
  credited: { label: "Credited", tone: "success" },
  applied: { label: "Applied", tone: "success" },
  unreconciled: { label: "Unreconciled", tone: "warning" },
  reconciled: { label: "Reconciled", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  voided: { label: "Voided", tone: "danger" },
  closed: { label: "Closed", tone: "neutral" },
  open: { label: "Open", tone: "info" },
  active: { label: "Active", tone: "success" },
  inactive: { label: "Inactive", tone: "neutral" },
  paused: { label: "Paused", tone: "warning" },
};

/**
 * Per-kind overrides. Only list a status here when the document type gives
 * it a genuinely different meaning or weight from the base reading.
 */
const OVERRIDES: Partial<Record<DocumentKind, Record<string, StatusMeta>>> = {
  estimate: {
    // A sent estimate is awaiting a customer decision, not merely dispatched.
    sent: { label: "Awaiting response", tone: "info" },
  },
  sales_order: {
    partial: { label: "Partially delivered", tone: "warning" },
    completed: { label: "Fulfilled", tone: "success" },
    confirmed: { label: "Confirmed", tone: "info" },
  },
  delivery_note: {
    partial: { label: "Partially delivered", tone: "warning" },
    sent: { label: "Dispatched", tone: "info" },
    completed: { label: "Delivered", tone: "success" },
    returned: { label: "Returned", tone: "warning" },
  },
  credit_note: {
    applied: { label: "Applied", tone: "success" },
    partial: { label: "Partially applied", tone: "warning" },
    issued: { label: "Issued", tone: "info" },
  },
  customer_payment: {
    partial: { label: "Partially allocated", tone: "warning" },
    completed: { label: "Received", tone: "success" },
  },
  recurring_invoice: {
    active: { label: "Active", tone: "success" },
    inactive: { label: "Paused", tone: "warning" },
    paused: { label: "Paused", tone: "warning" },
    cancelled: { label: "Cancelled", tone: "danger" },
    completed: { label: "Completed", tone: "neutral" },
  },
  sales_return: {
    approved: { label: "Approved", tone: "info" },
    cancelled: { label: "Cancelled", tone: "danger" },
  },
  journal_entry: {
    // A posted entry has hit the ledger and can no longer be edited freely.
    posted: { label: "Posted", tone: "success" },
    reversed: { label: "Reversed", tone: "warning" },
  },
  stock_adjustment: {
    pending_approval: { label: "Pending approval", tone: "warning" },
    approved: { label: "Approved", tone: "success" },
  },
  stock_transfer: {
    in_transit: { label: "In transit", tone: "accent" },
    completed: { label: "Received", tone: "success" },
    approved: { label: "Approved", tone: "info" },
  },
  bill: {
    received: { label: "Received", tone: "info" },
    void: { label: "Voided", tone: "danger" },
  },
  purchase_order: {
    ordered: { label: "Ordered", tone: "info" },
    partially_received: { label: "Partially received", tone: "warning" },
    received: { label: "Received", tone: "success" },
    billed: { label: "Billed", tone: "success" },
  },
  vendor_credit_note: {
    issued: { label: "Issued", tone: "info" },
    disputed: { label: "Disputed by supplier", tone: "warning" },
    applied: { label: "Applied", tone: "success" },
    void: { label: "Voided", tone: "danger" },
  },
  purchase_return: {
    shipped: { label: "Shipped", tone: "accent" },
    received: { label: "Received by vendor", tone: "info" },
    credited: { label: "Credited", tone: "success" },
  },
  rfq: {
    sent: { label: "Sent to vendors", tone: "info" },
    responded: { label: "Responses in", tone: "accent" },
    awarded: { label: "Awarded", tone: "success" },
  },
  expense: {
    submitted: { label: "Submitted", tone: "info" },
    approved: { label: "Approved", tone: "success" },
    reimbursed: { label: "Reimbursed", tone: "success" },
  },
  requisition: {
    submitted: { label: "Submitted", tone: "info" },
    approved: { label: "Approved", tone: "success" },
    ordered: { label: "Ordered", tone: "accent" },
  },
  contract: {
    active: { label: "Active", tone: "success" },
    expired: { label: "Expired", tone: "warning" },
  },
  landed_cost_voucher: {
    // The voucher lifecycle is charge capture → allocation → GL posting.
    // "Allocated" means the cost is spread but the ledger has not moved yet.
    pending_approval: { label: "Pending approval", tone: "warning" },
    allocated: { label: "Allocated", tone: "accent" },
    posted: { label: "Posted", tone: "success" },
    reversed: { label: "Reversed", tone: "danger" },
  },
};


/** Title Case fallback for a status the registry has not met yet. */
function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function documentStatusMeta(
  kind: DocumentKind,
  status: string | null | undefined,
): StatusMeta {
  if (!status) return { label: "—", tone: "neutral" };
  const key = String(status).toLowerCase();
  return (
    OVERRIDES[kind]?.[key] ??
    BASE[key] ?? { label: humanize(key), tone: "neutral" }
  );
}

export const documentStatusLabel = (
  kind: DocumentKind,
  status: string | null | undefined,
) => documentStatusMeta(kind, status).label;

export const documentStatusTone = (
  kind: DocumentKind,
  status: string | null | undefined,
) => documentStatusMeta(kind, status).tone;

interface DocumentStatusBadgeProps {
  kind: DocumentKind;
  status: string | null | undefined;
  /** Override the registry label (rare — prefer extending the registry). */
  children?: ReactNode;
}

/**
 * The only way a document status should be rendered. Lists, peeks and object
 * pages all use this so the vocabulary cannot fork again.
 */
export function DocumentStatusBadge({
  kind,
  status,
  children,
}: DocumentStatusBadgeProps) {
  const meta = documentStatusMeta(kind, status);
  return <StatusBadge tone={meta.tone}>{children ?? meta.label}</StatusBadge>;
}
