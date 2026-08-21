/**
 * usePaymentSession — Wave 3 · Phase 4.c
 *
 * Centralises every piece of "payment in progress" state that used to
 * live as 11 scattered `useState` hooks inside `PaymentDialog`. The
 * server-owned aggregate (`pos_payment_sessions` + `pos_payment_session_tenders`)
 * is the source of truth for `allocated`, `remaining`, and `change` —
 * this hook is a thin cache of that state.
 *
 * Key properties:
 *   1. **Refresh-safe.** On mount, the hook rehydrates any `open`
 *      session belonging to the current register whose idempotency key
 *      matches the current cart. Cashiers who reload the tab mid-payment
 *      pick up exactly where they left off; nothing is stashed in
 *      `localStorage`.
 *   2. **Lazy open.** No RPC is fired until the first tender is
 *      recorded. Browsing the payment dialog without confirming any
 *      tender opens nothing.
 *   3. **Idempotent.** The session key is derived from
 *      `${registerId}:${shiftId}:${cartHash}` — the same cart under the
 *      same shift reuses the same session across retries, and the
 *      per-tender key is `${sessionKey}:tender:${index}`.
 *   4. **No client math.** `allocated` / `remaining` / `change` come
 *      straight from the server RPC responses. The hook exposes no
 *      helpers to compute them locally.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  openSession as openSessionRpc,
  recordTender as recordTenderRpc,
  reverseTender as reverseTenderRpc,
  commitSession as commitSessionRpc,
  cancelSession as cancelSessionRpc,
  type PosSessionTenderInput,
  type CommitSessionEnvelope,
  type CommitSessionResult,
} from "@/lib/pos/paymentSessionClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentSessionStatus =
  | "idle"
  | "opening"
  | "open"
  | "recording"
  | "committing"
  | "committed"
  | "cancelling"
  | "cancelled"
  | "error";

export interface PaymentSessionCartTotals {
  grandTotal: number;
  currency: string;
  tipAmount?: number;
  /** Settlement currency snapshot; the FX rate is resolved server-side (ADR 0136). */
  settlementCurrency?: string | null;
  tipPolicy?: string | null;
}

export interface PaymentSessionParams {
  registerId: string;
  shiftId: string;
  cashierId?: string | null;
  /**
   * Stable digest of the cart contents. Ignored when `idempotencyKey`
   * is provided — that path is preferred whenever the caller already
   * owns a stable key.
   */
  cartHash?: string;
  /**
   * Explicit idempotency key. Use this when the caller already owns a
   * stable key (e.g. `useCommitKey.get(register, shift)` for retail,
   * `cart.transactionId` for restaurant draft finalisation). Takes
   * precedence over the `cartHash`-derived key so the dialog's session
   * collapses with the downstream commit path on retry.
   */
  idempotencyKey?: string;
  totals: PaymentSessionCartTotals;
  /** When false, the hook does not query for rehydration on mount. */
  autoRehydrate?: boolean;
}

export interface PaymentSessionTenderRow {
  id: string;
  tender_kind: string;
  method_key: string | null;
  amount: number;
  tendered_amount: number | null;
  change_given: number | null;
  reference: string | null;
  auth_state: string | null;
  auth_id: string | null;
  vendor_txn_id: string | null;
  driver_payload: Record<string, unknown> | null;
  /**
   * `reversed_at IS NULL` means the tender is still applied. There is
   * no `status` column on `pos_payment_session_tenders` — reversal
   * timestamp is the source of truth.
   */
  reversed_at: string | null;
  reversal_reason: string | null;
  created_at: string;
}

export interface UsePaymentSession {
  sessionId: string | null;
  status: PaymentSessionStatus;
  tenders: PaymentSessionTenderRow[];
  /** Sum of active tender amounts as reported by the server. */
  allocated: number;
  /** Sum of active tender `tendered_amount` (defaults to `amount`) — server-derived. */
  totalTendered: number;
  /** Sum of active tender `change_given` — server-derived. */
  totalChange: number;
  /** grandTotal - allocated, clamped >= 0. Derived from server values only. */
  remaining: number;
  /** Change due for display: totalChange when >0 else max(totalTendered - grandTotal, 0). */
  change: number;
  error: Error | null;
  /**
   * Record a tender through the session RPC. Opens the session lazily
   * if this is the first tender.
   */
  recordTender: (tender: PosSessionTenderInput) => Promise<PaymentSessionTenderRow>;
  reverseTender: (
    tenderId: string,
    reason: string,
    /**
     * Optional override + envelope forwarded to
     * `pos_payment_session_reverse_tender`. Required whenever the
     * `pos_override_matrix` has a row for
     * `pos_payment_session_reverse_tender` — the server calls
     * `assert_manager_override` unconditionally. Stage 3.
     */
    approval?: {
      managerOverrideId?: string | null;
      organizationId?: string | null;
      businessId?: string | null;
      shiftId?: string | null;
    },
  ) => Promise<void>;
  commit: (envelope: CommitSessionEnvelope) => Promise<CommitSessionResult>;
  cancel: (reason: string) => Promise<void>;
  /** Force a re-fetch of the tender list from the server. */
  refresh: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveSessionKey(p: PaymentSessionParams): string {
  if (p.idempotencyKey) return p.idempotencyKey;
  return `pos.session:${p.registerId}:${p.shiftId}:${p.cartHash ?? "no-cart-hash"}`;
}

async function fetchTenders(sessionId: string): Promise<PaymentSessionTenderRow[]> {
  const { data, error } = await supabase
    .from("pos_payment_session_tenders")
    .select(
      "id, tender_kind, method_key, amount, tendered_amount, change_given, reference, auth_state, auth_id, vendor_txn_id, driver_payload, reversed_at, reversal_reason, created_at",
    )
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PaymentSessionTenderRow[];
}

async function rehydrateOpen(
  registerId: string,
  idempotencyKey: string,
): Promise<{ id: string; status: string } | null> {
  // RLS already scopes by branch; we filter by register + status + key.
  const { data, error } = await supabase
    .from("pos_payment_sessions")
    .select("id, status")
    .eq("register_id", registerId)
    .eq("idempotency_key", idempotencyKey)
    .in("status", ["open", "balanced"])
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePaymentSession(params: PaymentSessionParams): UsePaymentSession {
  const idempotencyKey = useMemo(() => deriveSessionKey(params), [params]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<PaymentSessionStatus>("idle");
  const [tenders, setTenders] = useState<PaymentSessionTenderRow[]>([]);
  const [change, setChange] = useState<number>(0);
  const [error, setError] = useState<Error | null>(null);
  const sessionKeyRef = useRef<string | null>(null);

  // Guard against setting state on unmounted component (a hard refresh
  // can race with the rehydration query).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const rows = await fetchTenders(sessionId);
      if (!alive.current) return;
      setTenders(rows);
    } catch (e) {
      if (!alive.current) return;
      setError(e as Error);
    }
  }, [sessionId]);

  useEffect(() => {
    sessionKeyRef.current = null;
    setSessionId(null);
    setTenders([]);
    setChange(0);
    setError(null);
    setStatus("idle");
  }, [params.registerId, idempotencyKey]);

  // 1. Rehydrate any open session on mount / when the cart identity changes.
  useEffect(() => {
    if (params.autoRehydrate === false) return;
    let cancelled = false;
    (async () => {
      try {
        const existing = await rehydrateOpen(params.registerId, idempotencyKey);
        if (cancelled || !alive.current) return;
        if (existing) {
          sessionKeyRef.current = idempotencyKey;
          setSessionId(existing.id);
          setStatus("open");
          const rows = await fetchTenders(existing.id);
          if (!cancelled && alive.current) setTenders(rows);
        } else {
          sessionKeyRef.current = null;
          setSessionId(null);
          setTenders([]);
          setChange(0);
          setStatus("idle");
        }
      } catch (e) {
        if (!cancelled && alive.current) setError(e as Error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.registerId, idempotencyKey, params.autoRehydrate]);

  // 2. Lazy open on first tender.
  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId && sessionKeyRef.current === idempotencyKey) return sessionId;
    setStatus("opening");
    const id = await openSessionRpc({
      registerId: params.registerId,
      grandTotal: params.totals.grandTotal,
      currency: params.totals.currency,
      idempotencyKey,
      tipAmount: params.totals.tipAmount ?? 0,
      cashierId: params.cashierId ?? undefined,
      settlementCurrency: params.totals.settlementCurrency,
      tipPolicy: params.totals.tipPolicy,
    });
    if (alive.current) {
      sessionKeyRef.current = idempotencyKey;
      setSessionId(id);
      setStatus("open");
    }
    return id;
  }, [sessionId, params, idempotencyKey]);

  const recordTender = useCallback(
    async (tender: PosSessionTenderInput): Promise<PaymentSessionTenderRow> => {
      setError(null);
      setStatus("recording");
      try {
        const nextIndex = sessionKeyRef.current === idempotencyKey ? tenders.length : 0;
        const id = await ensureSession();
        const tenderId = await recordTenderRpc({
          sessionId: id,
          idempotencyKey: `${idempotencyKey}:tender:${nextIndex}`,
          tender,
        });
        const rows = await fetchTenders(id);
        if (alive.current) {
          setTenders(rows);
          setStatus("open");
        }
        return rows.find((r) => r.id === tenderId) ?? rows[rows.length - 1];
      } catch (e) {
        if (alive.current) {
          setError(e as Error);
          setStatus("error");
        }
        throw e;
      }
    },
    [ensureSession, tenders.length, idempotencyKey],
  );

  const reverseTender = useCallback(
    async (
      tenderId: string,
      reason: string,
      approval?: {
        managerOverrideId?: string | null;
        organizationId?: string | null;
        businessId?: string | null;
        shiftId?: string | null;
      },
    ): Promise<void> => {
      if (!sessionId) return;
      setError(null);
      try {
        await reverseTenderRpc({
          sessionId,
          tenderId,
          reason,
          managerOverrideId: approval?.managerOverrideId ?? null,
          organizationId:    approval?.organizationId ?? null,
          businessId:        approval?.businessId ?? null,
          shiftId:           approval?.shiftId ?? null,
        });
        await refresh();
      } catch (e) {
        if (alive.current) setError(e as Error);
        throw e;
      }
    },
    [sessionId, refresh],
  );


  const commit = useCallback(
    async (envelope: CommitSessionEnvelope): Promise<CommitSessionResult> => {
      const id = await ensureSession();
      setStatus("committing");
      try {
        const result = await commitSessionRpc({ sessionId: id, envelope });
        if (alive.current) {
          setStatus("committed");
          if (typeof result.change === "number") setChange(result.change);
        }
        return result;
      } catch (e) {
        if (alive.current) {
          setError(e as Error);
          setStatus("error");
        }
        throw e;
      }
    },
    [ensureSession],
  );

  const cancel = useCallback(
    async (reason: string): Promise<void> => {
      if (!sessionId) return;
      setStatus("cancelling");
      try {
        await cancelSessionRpc({ sessionId, reason });
        if (alive.current) {
          setStatus("cancelled");
          sessionKeyRef.current = null;
          setSessionId(null);
          setTenders([]);
        }
      } catch (e) {
        if (alive.current) {
          setError(e as Error);
          setStatus("error");
        }
        throw e;
      }
    },
    [sessionId],
  );

  // Derived, from server-authoritative rows only. Consumers must not
  // re-derive these client-side; `no-client-payment-math` fails the
  // build if PaymentDialog.tsx introduces `.reduce` over payments/tenders.
  // Active = not reversed. There is no `status` column on the tenders
  // table; `reversed_at IS NULL` is the source of truth.
  const activeTenders = useMemo(
    () => tenders.filter((t) => t.reversed_at == null),
    [tenders],
  );
  const allocated = useMemo(
    () => activeTenders.reduce((s, t) => s + Number(t.amount || 0), 0),
    [activeTenders],
  );
  const totalTendered = useMemo(
    () => activeTenders.reduce((s, t) => s + Number(t.tendered_amount ?? t.amount ?? 0), 0),
    [activeTenders],
  );
  const totalChange = useMemo(
    () => activeTenders.reduce((s, t) => s + Number(t.change_given ?? 0), 0),
    [activeTenders],
  );
  const remaining = useMemo(
    () => Math.max(0, Number(params.totals.grandTotal || 0) - allocated),
    [params.totals.grandTotal, allocated],
  );
  const displayChange = useMemo(() => {
    if (totalChange > 0) return totalChange;
    return Math.max(0, totalTendered - Number(params.totals.grandTotal || 0));
  }, [totalChange, totalTendered, params.totals.grandTotal]);
  const effectiveChange = change > 0 ? change : displayChange;

  return {
    sessionId,
    status,
    tenders,
    allocated,
    totalTendered,
    totalChange,
    remaining,
    change: effectiveChange,
    error,
    recordTender,
    reverseTender,
    commit,
    cancel,
    refresh,
  };
}
