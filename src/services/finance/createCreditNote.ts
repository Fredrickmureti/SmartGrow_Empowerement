import { supabase } from "@/integrations/supabase/client";

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
}

interface CreateCreditNoteResult {
  credit_note_id: string;
  credit_note_number: string;
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
    super(body.message ?? `Credit note creation failed with HTTP ${status}`);
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

/** Deterministic transport for `create_credit_note_atomic(_payload jsonb)`. */
export async function createCreditNoteAtomic(
  payload: CreateCreditNotePayload,
): Promise<CreateCreditNoteResult> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;

  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Please sign in again.");

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (!supabaseUrl || !publishableKey) throw new Error("Supabase connection is not configured.");

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/create_credit_note_atomic`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Profile": "public",
      Accept: "application/json",
    },
    body: serializeCreateCreditNoteRequest(payload),
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text || response.statusText };
  }

  if (!response.ok) {
    throw new CreditNoteRpcError(response.status, (body ?? {}) as PostgrestErrorBody);
  }
  return body as CreateCreditNoteResult;
}
/**
 * Deterministic transport for `issue_credit_note_atomic(_credit_note_id uuid)`.
 * Sends the named argument explicitly and surfaces the full PostgREST error
 * body instead of collapsing everything into an opaque HTTP 404.
 */
export async function issueCreditNoteAtomic(creditNoteId: string): Promise<{
  journal_entry_id: string;
  applied_to_invoice: number;
  customer_credit_created: number;
}> {
  if (!creditNoteId) throw new Error("Cannot issue a credit note without an id.");

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Please sign in again.");

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (!supabaseUrl || !publishableKey) throw new Error("Supabase connection is not configured.");

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/issue_credit_note_atomic`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ _credit_note_id: creditNoteId }),
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text || response.statusText };
  }
  if (!response.ok) throw new CreditNoteRpcError(response.status, (body ?? {}) as PostgrestErrorBody);
  return body as { journal_entry_id: string; applied_to_invoice: number; customer_credit_created: number };
}
