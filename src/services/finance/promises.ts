/**
 * Promise to Pay — a collections COMMITMENT overlay on canonical AR.
 *
 * A promise never moves money and never changes an invoice. It records that a
 * counterparty committed to pay `promised_amount` by `expected_payment_date`.
 * Whether the promise was KEPT is decided server-side by comparing the
 * customer's current canonical net position (`finance_ar_net_position`) with
 * the baseline captured when the promise was made — never by the browser and
 * never by reading `invoices.status`.
 *
 * Writes go exclusively through `record_promise_to_pay`, which resolves the
 * organization, converts to base currency and de-duplicates on an explicit
 * request key (per the money-in idempotency rule: the key is derived from the
 * promise intent, never a random per-render identifier).
 */
import { supabase } from "@/integrations/supabase/client";

export type PromiseStatus = "open" | "kept" | "broken" | "cancelled";

export const PROMISE_STATUS_LABELS: Record<PromiseStatus, string> = {
  open: "Open",
  kept: "Kept",
  broken: "Broken",
  cancelled: "Cancelled",
};

export interface PromiseToPay {
  id: string;
  contactId: string;
  contactName: string | null;
  documentId: string | null;
  promisedAmount: number;
  currency: string;
  basePromisedAmount: number;
  expectedPaymentDate: string;
  status: PromiseStatus;
  notes: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Deterministic idempotency key derived from the promise intent. */
export function promiseRequestKey(input: {
  contactId: string;
  amount: number;
  expectedPaymentDate: string;
}): string {
  return [
    "ptp",
    input.contactId,
    input.expectedPaymentDate,
    input.amount.toFixed(2),
  ].join(":");
}

interface PromiseRow extends Record<string, unknown> {
  contact?: { name?: string | null } | null;
}

function mapRow(r: PromiseRow): PromiseToPay {
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    contactName: r.contact?.name ?? null,
    documentId: (r.document_id as string) ?? null,
    promisedAmount: Number(r.promised_amount) || 0,
    currency: String(r.currency ?? "KES"),
    basePromisedAmount: Number(r.base_promised_amount) || 0,
    expectedPaymentDate: String(r.expected_payment_date),
    status: (r.status as PromiseStatus) ?? "open",
    notes: (r.notes as string) ?? null,
    createdAt: String(r.created_at),
    resolvedAt: (r.resolved_at as string) ?? null,
  };
}

export async function fetchPromises(params: {
  orgId: string;
  businessId?: string | null;
  contactId?: string | null;
  statuses?: PromiseStatus[];
}): Promise<PromiseToPay[]> {
  let q = supabase
    .from("ar_promises_to_pay" as never)
    .select("*, contact:contacts(name)")
    .eq("organization_id", params.orgId)
    .order("expected_payment_date", { ascending: true })
    .limit(500);

  if (params.businessId) q = q.eq("business_id", params.businessId);
  if (params.contactId) q = q.eq("contact_id", params.contactId);
  if (params.statuses?.length) q = q.in("status", params.statuses);

  const { data, error } = await q;
  if (error) throw error;
  return ((data as unknown as PromiseRow[]) ?? []).map(mapRow);
}

/** Open promises keyed by contact — for the Collections work list. */
export async function fetchOpenPromisesByContact(params: {
  orgId: string;
  businessId?: string | null;
}): Promise<Record<string, PromiseToPay>> {
  const rows = await fetchPromises({ ...params, statuses: ["open"] });
  const out: Record<string, PromiseToPay> = {};
  for (const row of rows) {
    // Earliest outstanding commitment wins — that is the one being chased.
    if (!out[row.contactId]) out[row.contactId] = row;
  }
  return out;
}

export async function recordPromiseToPay(input: {
  businessId: string;
  contactId: string;
  promisedAmount: number;
  expectedPaymentDate: string;
  currency?: string | null;
  documentId?: string | null;
  branchId?: string | null;
  notes?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc("record_promise_to_pay" as never, {
    _business_id: input.businessId,
    _contact_id: input.contactId,
    _promised_amount: input.promisedAmount,
    _expected_payment_date: input.expectedPaymentDate,
    _currency: input.currency ?? null,
    _document_id: input.documentId ?? null,
    _branch_id: input.branchId ?? null,
    _notes: input.notes ?? null,
    _client_request_id: promiseRequestKey({
      contactId: input.contactId,
      amount: input.promisedAmount,
      expectedPaymentDate: input.expectedPaymentDate,
    }),
  } as never);
  if (error) throw error;
  return String(data);
}

export async function cancelPromiseToPay(id: string): Promise<void> {
  const { error } = await supabase
    .from("ar_promises_to_pay" as never)
    .update({ status: "cancelled", resolved_at: new Date().toISOString() } as never)
    .eq("id", id);
  if (error) throw error;
}

/** Ask the server to re-evaluate open promises against the canonical position. */
export async function evaluatePromiseStatus(businessId?: string | null): Promise<number> {
  const { data, error } = await supabase.rpc("evaluate_promise_status" as never, {
    _business_id: businessId ?? null,
  } as never);
  if (error) throw error;
  return Number(data) || 0;
}
