/**
 * POS Payment Session Client — Wave 3 · Phase 2
 * -----------------------------------------------------------------------------
 * The five session-lifecycle RPCs are server-owned (SECURITY DEFINER) and
 * every client that touches them MUST go through this wrapper. The
 * architecture guard `src/test/architecture/pos-payment-session-lifecycle.test.ts`
 * fails the build if any other file references the RPCs by name.
 *
 * Responsibilities kept in one place:
 *   1. Typed argument surfaces (no raw `Json` at call sites).
 *   2. Deterministic idempotency-key generation for every mutating call.
 *      The server dedupes on `(business_id, idempotency_key)` for sessions
 *      and `(session_id, idempotency_key)` for tenders — a retried call
 *      with the SAME key MUST be safe, and this wrapper never mints a
 *      fresh key inside a retry loop.
 *   3. Uniform error surface: RPC errors are re-thrown with a stable
 *      `POSPaymentSessionError` shape so callers can pattern-match without
 *      parsing Postgres error strings.
 *   4. Business-event side effects live on the server — this wrapper does
 *      not fire any client-side analytics on success. Consumers subscribe
 *      to the `pos.payment.session.*` outbox topics instead.
 */
import { supabase } from "@/integrations/supabase/client";

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Mint an idempotency key. Prefer providing your own stable key (e.g. the
 * commit key from `useCommitKey`) so retries collapse; use this only when
 * no upstream stable identifier exists.
 */
export function newIdempotencyKey(prefix = "pos.session"): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}:${rand}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PosTenderKind =
  | "cash"
  | "card"
  | "wallet"
  | "voucher"
  | "credit_liability"
  | "bank_transfer"
  | "other";

export type PosTenderAuthState =
  | "pending"
  | "authorized"
  | "approved"
  | "captured"
  | "reversed"
  | "failed";

export interface PosSessionTenderInput {
  tender_kind: PosTenderKind;
  method_key: string;
  provider_key?: string | null;
  /** Amount applied to the invoice. Must be > 0. */
  amount: number;
  /** What the customer presented; defaults to `amount` server-side. */
  tendered_amount?: number;
  /** Cash change due; 0 for non-cash tenders. */
  change_given?: number;
  reference?: string | null;
  auth_state?: PosTenderAuthState;
  auth_id?: string | null;
  vendor_txn_id?: string | null;
  /** Opaque driver payload persisted for audit; never inspected server-side. */
  driver_payload?: Record<string, unknown>;
}

export interface OpenSessionArgs {
  registerId: string;
  grandTotal: number;
  currency: string;
  idempotencyKey: string;
  tipAmount?: number;
  cashierId?: string | null;
  /**
   * ADR 0136 — the FX rate is resolved server-side at session-open and frozen
   * for the life of the session. The till may not supply one.
   */
  settlementCurrency?: string | null;

  tipPolicy?: string | null;
}

export interface RecordTenderArgs {
  sessionId: string;
  tender: PosSessionTenderInput;
  idempotencyKey: string;
}

export interface ReverseTenderArgs {
  sessionId: string;
  tenderId: string;
  reason: string;
  /**
   * Manager approval id returned by `useManagerOverride`. Server calls
   * `assert_manager_override` when the matrix has a row for
   * `pos_payment_session_reverse_tender`; without a valid id above the
   * configured threshold, the RPC raises `override_required` (SQLSTATE
   * 42501). Safe to omit when no matrix row is configured. Stage 3.
   */
  managerOverrideId?: string | null;
  organizationId?: string | null;
  businessId?: string | null;
  shiftId?: string | null;
}


export interface CancelSessionArgs {
  sessionId: string;
  reason: string;
}

/**
 * Transaction envelope forwarded by the commit RPC.
 *
 * The commit RPC has two modes, distinguished only by whether
 * `existing_transaction_id` is set:
 *
 *   - **Retail** (unset): the RPC calls `process_pos_transaction` to
 *     create a new transaction from `items` + the session's tenders.
 *     All cart fields (`items`, `subtotal`, `tax_amount`, `shift_id`, …)
 *     are required.
 *
 *   - **Restaurant / table order** (set): the RPC calls
 *     `finalize_table_order(existing_transaction_id, …)` against a
 *     pre-existing draft transaction. The draft already owns the cart
 *     lines, tax, and shift context, so the cart fields on this envelope
 *     are IGNORED. Only the session's tenders + tip amount are forwarded.
 */
export interface CommitSessionEnvelope {
  /**
   * When set, commit finalises this existing draft transaction (dine-in
   * flow that started a check before payment). When unset, commit creates
   * a new retail transaction from the cart fields below.
   */
  existing_transaction_id?: string | null;

  organization_id?: string | null;
  shift_id?: string;
  items?: unknown; // cart items array — passed through opaquely
  subtotal?: number;
  tax_amount?: number;
  discount_amount?: number;
  /**
   * Phase 7 — cart-level discount intent. `pos_payment_session_commit`
   * re-prices `items` with `pos_quote_cart` and refuses the commit when the
   * re-quoted total disagrees with the session's grand total, so the cart
   * discount must travel with the envelope.
   */
  cart_discount_type?: "percent" | "fixed" | null;
  cart_discount_value?: number;
  transaction_type?: "sale" | "refund" | "return" | "void";
  customer_id?: string | null;
  customer_tin?: string | null;
  customer_name?: string | null;
  notes?: string | null;
  original_transaction_id?: string | null;
  table_session_id?: string | null;
}

export interface CommitSessionArgs {
  sessionId: string;
  envelope: CommitSessionEnvelope;
}

/**
 * Envelope returned by `pos_payment_session_commit`. Mirrors the
 * `process_pos_transaction` response with the originating `session_id`
 * appended. On idempotent replay `idempotent_replay` is `true` and the
 * body is the exact cached envelope of the first successful commit.
 */
export interface CommitSessionResult {
  success: true;
  session_id: string;
  transaction_id: string;
  transaction_number?: string;
  change?: number;
  tendered?: number;
  branch_id?: string;
  business_id?: string;
  idempotent_replay?: boolean;
  server_totals?: {
    subtotal: number;
    tax_amount: number;
    discount_amount: number;
    total: number;
  };
  client_totals?: {
    subtotal: number;
    tax_amount: number;
    discount_amount: number;
    total: number;
  };
  total_matches_server?: boolean;
}


// ---------------------------------------------------------------------------
// Error surface
// ---------------------------------------------------------------------------

export class POSPaymentSessionError extends Error {
  readonly rpc: string;
  readonly code: string | null;
  readonly hint: string | null;
  readonly details: string | null;

  constructor(
    rpc: string,
    message: string,
    opts: { code?: string | null; hint?: string | null; details?: string | null } = {},
  ) {
    super(message);
    this.name = "POSPaymentSessionError";
    this.rpc = rpc;
    this.code = opts.code ?? null;
    this.hint = opts.hint ?? null;
    this.details = opts.details ?? null;
  }
}

function throwRpcError(rpc: string, error: unknown): never {
  const e = error as { message?: string; code?: string; hint?: string; details?: string } | null;
  throw new POSPaymentSessionError(rpc, e?.message ?? `${rpc} failed`, {
    code: e?.code ?? null,
    hint: e?.hint ?? null,
    details: e?.details ?? null,
  });
}

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------

export async function openSession(args: OpenSessionArgs): Promise<string> {
  if (!args.idempotencyKey) {
    throw new POSPaymentSessionError(
      "pos_payment_session_open",
      "idempotencyKey is required — retries must collapse to a single session",
    );
  }
  const { data, error } = await supabase.rpc("pos_payment_session_open", {
    p_register_id: args.registerId,
    p_grand_total: args.grandTotal,
    p_currency: args.currency,
    p_idempotency_key: args.idempotencyKey,
    p_tip_amount: args.tipAmount ?? 0,
    p_cashier_id: args.cashierId ?? undefined,
    p_fx_rate: args.fxRate ?? 1,
    p_settlement_currency: args.settlementCurrency ?? args.currency,
    p_tip_policy: args.tipPolicy ?? "none",
  } as never);
  if (error) throwRpcError("pos_payment_session_open", error);
  return data as string;
}

export async function recordTender(args: RecordTenderArgs): Promise<string> {
  if (!args.idempotencyKey) {
    throw new POSPaymentSessionError(
      "pos_payment_session_record_tender",
      "idempotencyKey is required — retries must not double-append the tender",
    );
  }
  const { data, error } = await supabase.rpc("pos_payment_session_record_tender", {
    p_session_id: args.sessionId,
    p_tender: args.tender as unknown as never, // typed as Json in generated types
    p_idempotency_key: args.idempotencyKey,
  });
  if (error) throwRpcError("pos_payment_session_record_tender", error);
  return data as string;
}

export async function reverseTender(args: ReverseTenderArgs): Promise<void> {
  const { error } = await supabase.rpc("pos_payment_session_reverse_tender", {
    p_session_id:          args.sessionId,
    p_tender_id:           args.tenderId,
    p_reason:              args.reason,
    p_manager_override_id: args.managerOverrideId ?? null,
    p_organization_id:     args.organizationId ?? null,
    p_business_id:         args.businessId ?? null,
    p_shift_id:            args.shiftId ?? null,
  });
  if (error) throwRpcError("pos_payment_session_reverse_tender", error);
}


export async function commitSession(args: CommitSessionArgs): Promise<CommitSessionResult> {
  const { data, error } = await supabase.rpc("pos_payment_session_commit", {
    p_session_id: args.sessionId,
    p_transaction_envelope: args.envelope as unknown as never,
  });
  if (error) throwRpcError("pos_payment_session_commit", error);
  return data as unknown as CommitSessionResult;
}


export async function cancelSession(args: CancelSessionArgs): Promise<void> {
  const { error } = await supabase.rpc("pos_payment_session_cancel", {
    p_session_id: args.sessionId,
    p_reason: args.reason,
  });
  if (error) throwRpcError("pos_payment_session_cancel", error);
}

/**
 * Phase 9 — recovery seam.
 *
 * Lists the payment sessions still `open` on a register so the terminal can
 * offer a "resume / cancel" affordance after a crash, reload, network drop or
 * payment timeout. Read-only, SECURITY DEFINER, branch-access checked by the
 * RPC; the browser never derives allocated/remaining itself.
 */
export interface OpenPaymentSession {
  session_id: string;
  idempotency_key: string;
  grand_total: number;
  tip_amount: number;
  currency: string;
  allocated: number;
  remaining: number;
  tender_count: number;
  cashier_id: string | null;
  opened_at: string | null;
  age_seconds: number;
}

export async function listOpenSessions(registerId: string): Promise<OpenPaymentSession[]> {
  const { data, error } = await supabase.rpc("pos_register_open_payment_sessions", {
    p_register_id: registerId,
  });
  if (error) throwRpcError("pos_register_open_payment_sessions", error);
  return ((data ?? []) as unknown as OpenPaymentSession[]).map((row) => ({
    ...row,
    grand_total: Number(row.grand_total ?? 0),
    tip_amount: Number(row.tip_amount ?? 0),
    allocated: Number(row.allocated ?? 0),
    remaining: Number(row.remaining ?? 0),
    tender_count: Number(row.tender_count ?? 0),
    age_seconds: Number(row.age_seconds ?? 0),
  }));
}

/**
 * Grouped export — some call sites prefer namespaced access
 * (`paymentSessionClient.commit(...)`), others prefer named imports.
 * Both surfaces resolve to the same functions.
 */
export const paymentSessionClient = {
  newIdempotencyKey,
  openSession,
  recordTender,
  reverseTender,
  commitSession,
  cancelSession,
  listOpenSessions,
};
