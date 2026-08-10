/**
 * AR disputes — a contested-amount overlay on canonical AR.
 *
 * A dispute NEVER reduces receivables. The GL and `finance_ar_net_position`
 * stay untouched; disputed exposure is reported as a separate figure and
 * suppresses dunning escalation (`dunning_assignment.on_hold`) so collectors
 * do not chase a contested balance.
 *
 * Writes go through `raise_ar_dispute` / `resolve_ar_dispute`, which resolve
 * the organization, convert to base currency and de-duplicate on a request key
 * derived from the dispute intent.
 */
import { supabase } from "@/integrations/supabase/client";

export type DisputeStatus = "open" | "resolved" | "rejected";

export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  rejected: "Rejected",
};

export const DISPUTE_TYPES = [
  "pricing",
  "quantity",
  "quality",
  "delivery",
  "billing_error",
  "other",
] as const;

export type DisputeType = (typeof DISPUTE_TYPES)[number];

export const DISPUTE_TYPE_LABELS: Record<DisputeType, string> = {
  pricing: "Pricing",
  quantity: "Quantity",
  quality: "Quality",
  delivery: "Delivery",
  billing_error: "Billing error",
  other: "Other",
};

export interface ArDispute {
  id: string;
  contactId: string;
  contactName: string | null;
  documentId: string | null;
  disputeType: string;
  reason: string | null;
  amountDisputed: number;
  currency: string;
  baseAmountDisputed: number;
  status: DisputeStatus;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Deterministic idempotency key derived from the dispute intent. */
export function disputeRequestKey(input: {
  contactId: string;
  amount: number;
  disputeType: string;
  documentId?: string | null;
}): string {
  return [
    "disp",
    input.contactId,
    input.documentId ?? "none",
    input.disputeType,
    input.amount.toFixed(2),
  ].join(":");
}

interface DisputeRow extends Record<string, unknown> {
  contact?: { name?: string | null } | null;
}

function mapRow(r: DisputeRow): ArDispute {
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    contactName: r.contact?.name ?? null,
    documentId: (r.document_id as string) ?? null,
    disputeType: String(r.dispute_type ?? "other"),
    reason: (r.reason as string) ?? null,
    amountDisputed: Number(r.amount_disputed) || 0,
    currency: String(r.currency ?? "KES"),
    baseAmountDisputed: Number(r.base_amount_disputed) || 0,
    status: (r.status as DisputeStatus) ?? "open",
    resolutionNote: (r.resolution_note as string) ?? null,
    createdAt: String(r.created_at),
    resolvedAt: (r.resolved_at as string) ?? null,
  };
}

export async function fetchDisputes(params: {
  orgId: string;
  businessId?: string | null;
  contactId?: string | null;
  statuses?: DisputeStatus[];
}): Promise<ArDispute[]> {
  let q = supabase
    .from("ar_disputes" as never)
    .select("*, contact:contacts(name)")
    .eq("organization_id", params.orgId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (params.businessId) q = q.eq("business_id", params.businessId);
  if (params.contactId) q = q.eq("contact_id", params.contactId);
  if (params.statuses?.length) q = q.in("status", params.statuses);

  const { data, error } = await q;
  if (error) throw error;
  return ((data as unknown as DisputeRow[]) ?? []).map(mapRow);
}

/** Open disputes aggregated per contact — for the Collections work list. */
export async function fetchOpenDisputesByContact(params: {
  orgId: string;
  businessId?: string | null;
}): Promise<Record<string, { count: number; baseAmount: number; first: ArDispute }>> {
  const rows = await fetchDisputes({ ...params, statuses: ["open"] });
  const out: Record<string, { count: number; baseAmount: number; first: ArDispute }> = {};
  for (const row of rows) {
    const entry = out[row.contactId];
    if (entry) {
      entry.count += 1;
      entry.baseAmount += row.baseAmountDisputed;
    } else {
      out[row.contactId] = {
        count: 1,
        baseAmount: row.baseAmountDisputed,
        first: row,
      };
    }
  }
  return out;
}

export async function raiseArDispute(input: {
  businessId: string;
  contactId: string;
  amountDisputed: number;
  disputeType: string;
  reason?: string | null;
  currency?: string | null;
  documentId?: string | null;
  branchId?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc("raise_ar_dispute" as never, {
    _business_id: input.businessId,
    _contact_id: input.contactId,
    _amount_disputed: input.amountDisputed,
    _dispute_type: input.disputeType,
    _reason: input.reason ?? null,
    _currency: input.currency ?? null,
    _document_id: input.documentId ?? null,
    _branch_id: input.branchId ?? null,
    _client_request_id: disputeRequestKey({
      contactId: input.contactId,
      amount: input.amountDisputed,
      disputeType: input.disputeType,
      documentId: input.documentId ?? null,
    }),
  } as never);
  if (error) throw error;
  return String(data);
}

export async function resolveArDispute(
  disputeId: string,
  status: Exclude<DisputeStatus, "open">,
  note?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("resolve_ar_dispute" as never, {
    _dispute_id: disputeId,
    _status: status,
    _resolution_note: note ?? null,
  } as never);
  if (error) throw error;
}
