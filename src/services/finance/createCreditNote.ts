import { supabase } from "@/integrations/supabase/client";

/**
 * A credit note line as expressed by the client.
 *
 * For an invoice-referenced line the client expresses *intent only*:
 * "credit this invoice line, this many units". The server resolves the
 * description, price, discount and tax from `invoice_items` and enforces the
 * remaining creditable quantity — the money fields below are ignored on that
 * path. For an off-invoice line (`invoice_item_id: null`) the server still
 * recomputes `line_total`/`tax_amount` from quantity, price and rate.
 */
export interface CreditNoteLinePayload extends Record<string, unknown> {
  invoice_item_id?: string | null;
  product_id?: string | null;
  description?: string | null;
  quantity: number;
  unit_price?: number;
  tax_rate?: number;
  sort_order?: number;
}

export interface CreateCreditNotePayload {
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  contact_id: string;
  invoice_id: string | null;
  issue_date: string;
  reason: string | null;
  notes: string | null;
  items: Array<Record<string, unknown>>;
  source_return_id: string | null;
  issue: boolean;
  /** Idempotency key: the same value never creates a second credit note. */
  client_request_id?: string | null;
}

export interface UpdateCreditNotePayload {
  credit_note_id: string;
  reason?: string | null;
  notes?: string | null;
  issue_date?: string | null;
  items?: Array<Record<string, unknown>>;
}

interface CreateCreditNoteResult {
  credit_note_id: string;
  credit_note_number: string;
  idempotent_replay?: boolean;
}

interface PostgrestErrorBody {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

export class CreditNoteRpcError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: string | null;
  readonly hint?: string | null;

  constructor(status: number, body: PostgrestErrorBody) {
    super(body.message ?? `Credit note request failed with HTTP ${status}`);
    this.name = "CreditNoteRpcError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.hint = body.hint;
  }
}

export function serializeCreateCreditNoteRequest(payload: CreateCreditNotePayload): string {
  return JSON.stringify({ _payload: payload });
}

/**
 * Shared deterministic transport for the credit-note RPCs. Sends the named
 * argument explicitly and surfaces the full PostgREST error body instead of
 * collapsing everything into an opaque HTTP status.
 */
/**
 * The endpoints are written out in full rather than assembled from fragments:
 * the architecture guard greps for them, and a composed URL would hide a
 * second creation entry point from that ratchet.
 */
const RPC_ENDPOINTS = {
  create: "rest/v1/rpc/create_credit_note_atomic",
  update: "rest/v1/rpc/update_credit_note_atomic",
  issue: "rest/v1/rpc/issue_credit_note_atomic",
  remove: "rest/v1/rpc/delete_credit_note_atomic",
} as const;


async function callCreditNoteRpc<T>(endpoint: string, body: string): Promise<T> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;

  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Please sign in again.");

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (!supabaseUrl || !publishableKey) throw new Error("Supabase connection is not configured.");

  const response = await fetch(`${supabaseUrl}/${endpoint}`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Profile": "public",
      Accept: "application/json",
    },
    body,
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text || response.statusText };
  }

  if (!response.ok) {
    throw new CreditNoteRpcError(response.status, (parsed ?? {}) as PostgrestErrorBody);
  }
  return parsed as T;
}

/** Deterministic transport for `create_credit_note_atomic(_payload jsonb)`. */
export async function createCreditNoteAtomic(
  payload: CreateCreditNotePayload,
): Promise<CreateCreditNoteResult> {
  return callCreditNoteRpc<CreateCreditNoteResult>(
    RPC_ENDPOINTS.create,
    serializeCreateCreditNoteRequest(payload),
  );
}

/**
 * Deterministic transport for `update_credit_note_atomic(_payload jsonb)`.
 * Drafts only — the server rejects edits to an issued credit note, and
 * re-applies the credit ceiling to any rewritten line.
 */
export async function updateCreditNoteAtomic(
  payload: UpdateCreditNotePayload,
): Promise<{ credit_note_id: string }> {
  return callCreditNoteRpc<{ credit_note_id: string }>(
    RPC_ENDPOINTS.update,
    JSON.stringify({ _payload: payload }),
  );
}

/** Deterministic transport for `issue_credit_note_atomic(_credit_note_id uuid)`. */
export async function issueCreditNoteAtomic(creditNoteId: string): Promise<{
  journal_entry_id: string;
  applied_to_invoice: number;
  customer_credit_created: number;
}> {
  if (!creditNoteId) throw new Error("Cannot issue a credit note without an id.");
  return callCreditNoteRpc(RPC_ENDPOINTS.issue, JSON.stringify({ _credit_note_id: creditNoteId }));
}

/**
 * Deterministic transport for `delete_credit_note_atomic(_credit_note_id uuid)`.
 * The server owns the deletability rules: draft only, nothing applied, nothing
 * refunded, no credit movements and no posted journal entry.
 */
export async function deleteCreditNoteAtomic(creditNoteId: string): Promise<{
  credit_note_id: string;
  deleted: boolean;
}> {
  if (!creditNoteId) throw new Error("Cannot delete a credit note without an id.");
  return callCreditNoteRpc(RPC_ENDPOINTS.remove, JSON.stringify({ _credit_note_id: creditNoteId }));
}

