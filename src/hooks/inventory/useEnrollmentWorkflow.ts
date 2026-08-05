/**
 * useEnrollmentWorkflow — pure reducer + thin orchestrator powering the
 * Barcode Enrollment Workspace.
 *
 * The reducer owns:
 *   - the active queue (pending + deferred order)
 *   - the cursor (which product is "current")
 *   - the FSM state: ready | validating | duplicate | invalid
 *   - the 1-deep undo slot
 *   - a per-code single-flight sequence id (stale RPC responses dropped)
 *
 * The orchestrator (returned hook) wires the reducer to:
 *   - the canonical identifier write seam (`writeIdentifierResult`, over
 *     `upsert_product_identifier`) — ADR: one write seam, no legacy RPC
 *   - the `scanFeedbackBus` (ghost-ticker / phone beep mirror)
 *   - the `usePOSSound` envelope (OK pip, duplicate warn, invalid blip)
 *
 * Anti-pattern guard: this hook MUST NOT subscribe to `scanBus` directly.
 * Scans arrive via `submit(code)` from a single `useScanTarget` registered
 * by the page. See ADR 0013.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { writeIdentifierResult } from "@/features/products/identity/writeIdentifier";
import { scanFeedbackBus } from "@/services/scanner";
import { playPOSSound } from "@/lib/pos/sounds";
import type { IdentificationTarget } from "@/hooks/inventory/useIdentificationQueue";

/**
 * A queue entry: a (product, packaging level) pair from
 * `product_identification_queue`. Phase D removed the legacy
 * product-level `AwaitingBarcodeProduct` shape — the level fields stay
 * optional so a base-unit target can omit them.
 */
export type EnrollmentTarget = {
  id: string;
  name: string;
  sku: string | null;
  unit_price?: number;
  image_url?: string | null;
  category_id?: string | null;
} & Partial<
  Pick<IdentificationTarget, "key" | "packagingId" | "levelName" | "qtyInBaseUom" | "ladder">
>;

export type EnrollmentStatus = "ready" | "validating" | "duplicate" | "invalid";

export interface EnrollmentOutcome {
  productId: string;
  productName: string;
  code: string;
  at: number;
}

export interface EnrollmentError {
  kind: "duplicate" | "invalid";
  message: string;
  conflictProductName?: string;
}

interface State {
  queue: EnrollmentTarget[];            // active (un-identified) levels
  doneCount: number;
  status: EnrollmentStatus;
  lastError: EnrollmentError | null;
  lastEnrolled: EnrollmentOutcome | null; // for Undo
  // Increments on every SCAN; the RPC response is ignored unless the seq
  // matches at resolution time. Closes the TOCTOU between SKIP/UNDO and a
  // late-arriving RPC reply.
  seq: number;
}

type Action =
  | { type: "QUEUE_LOADED"; products: EnrollmentTarget[] }
  | { type: "SCAN_START" }
  | { type: "SCAN_OK"; outcome: EnrollmentOutcome; seq: number }
  | { type: "SCAN_DUPLICATE"; err: EnrollmentError; seq: number }
  | { type: "SCAN_INVALID"; err: EnrollmentError; seq: number }
  | { type: "FLAG_FAILED"; err: EnrollmentError }
  | { type: "SKIP" }
  | { type: "UNDO_RESTORE"; product: EnrollmentTarget }
  | { type: "DROP_HEAD" }
  | { type: "ADVANCE_BACK"; productId: string }    // for re-insert after duplicate "reassign"
  | { type: "CLEAR_FEEDBACK" }
  | { type: "JUMP"; delta: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "QUEUE_LOADED":
      // External refetch invalidates the cursor: any in-flight RPC for the
      // previous head must be dropped, so bump `seq`.
      return { ...state, queue: action.products, seq: state.seq + 1 };
    case "SCAN_START":
      return { ...state, status: "validating", lastError: null, seq: state.seq + 1 };
    case "SCAN_OK": {
      if (action.seq !== state.seq) return state; // stale
      const [, ...rest] = state.queue;
      return {
        ...state,
        queue: rest,
        doneCount: state.doneCount + 1,
        status: "ready",
        lastError: null,
        lastEnrolled: action.outcome,
      };
    }
    case "SCAN_DUPLICATE":
      if (action.seq !== state.seq) return state;
      return { ...state, status: "duplicate", lastError: action.err };
    case "SCAN_INVALID":
      if (action.seq !== state.seq) return state;
      return { ...state, status: "invalid", lastError: action.err };
    case "FLAG_FAILED":
      // Cursor stays put — UI / DB must not diverge. Surface via lastError
      // banner (same channel as duplicate/invalid).
      return { ...state, status: "invalid", lastError: action.err };
    case "SKIP": {
      if (state.queue.length === 0) return state;
      const [head, ...rest] = state.queue;
      // Cursor moves → drop any in-flight RPC against the previous head.
      return {
        ...state,
        queue: [...rest, head],
        status: "ready",
        lastError: null,
        seq: state.seq + 1,
      };
    }
    case "UNDO_RESTORE":
      // Cursor moves backwards → drop any in-flight RPC.
      return {
        ...state,
        queue: [action.product, ...state.queue],
        doneCount: Math.max(0, state.doneCount - 1),
        lastEnrolled: null,
        status: "ready",
        lastError: null,
        seq: state.seq + 1,
      };
    case "ADVANCE_BACK": {
      // No-op placeholder reserved for future "reassign" flow.
      return state;
    }
    case "DROP_HEAD": {
      // Level waived / resolved without enrollment — remove it outright.
      if (state.queue.length === 0) return state;
      const [, ...rest] = state.queue;
      return { ...state, queue: rest, status: "ready", lastError: null, seq: state.seq + 1 };
    }
    case "CLEAR_FEEDBACK":
      return { ...state, status: "ready", lastError: null };
    case "JUMP": {
      if (state.queue.length < 2) return state;
      const n = state.queue.length;
      const k = ((action.delta % n) + n) % n;
      if (k === 0) return state;
      // Cursor moves → drop any in-flight RPC.
      return {
        ...state,
        queue: [...state.queue.slice(k), ...state.queue.slice(0, k)],
        status: "ready",
        lastError: null,
        seq: state.seq + 1,
      };
    }
    default:
      return state;
  }
}

const INITIAL: State = {
  queue: [],
  doneCount: 0,
  status: "ready",
  lastError: null,
  lastEnrolled: null,
  seq: 0,
};

export interface UseEnrollmentArgs {
  businessId: string | null | undefined;
  products: EnrollmentTarget[];
  /** Disable sounds (per-user preference). */
  silent?: boolean;
  /** Override the RPC call — test seam. */
  enrollFn?: (args: {
    businessId: string;
    productId: string;
    code: string;
    packagingId?: string | null;
    kind?: "gtin" | "pack";
  }) => Promise<EnrollRpcResult>;
}

export type EnrollRpcResult =
  | { status: "ok"; identifier_id: string; idempotent?: boolean }
  | { status: "duplicate"; conflict_product_id: string; conflict_product_name: string }
  | { status: "invalid"; reason: string };

async function defaultEnroll(args: {
  businessId: string;
  productId: string;
  code: string;
  packagingId?: string | null;
  kind?: "gtin" | "pack";
}): Promise<EnrollRpcResult> {
  const result = await writeIdentifierResult({
    businessId: args.businessId,
    productId: args.productId,
    code: args.code,
    // Above the base unit the code identifies a pack, not the item.
    kind: args.kind ?? (args.packagingId ? "pack" : "gtin"),
    packagingId: args.packagingId ?? null,
    source: "manual",
  });
  if (result.status === "ok") {
    return { status: "ok", identifier_id: result.identifierId, idempotent: result.idempotent };
  }
  if (result.status === "duplicate") {
    return {
      status: "duplicate",
      conflict_product_id: result.conflictProductId ?? "",
      conflict_product_name: result.conflictProductName ?? "another product",
    };
  }
  return { status: "invalid", reason: result.message };
}

export function useEnrollmentWorkflow({
  businessId,
  products,
  silent,
  enrollFn,
}: UseEnrollmentArgs) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const enrollRef = useRef(enrollFn ?? defaultEnroll);
  enrollRef.current = enrollFn ?? defaultEnroll;
  const silentRef = useRef(!!silent);
  silentRef.current = !!silent;

  // Mirror the latest reducer state into a ref so `submit` can read seq/status
  // without re-creating its identity on every reducer tick. Keeps the single
  // top-priority `useScanTarget` registration stable during high-throughput
  // sessions.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Sync external queue → reducer when the underlying list changes.
  // Preserves doneCount but resets cursor to head of the new list.
  useEffect(() => {
    dispatch({ type: "QUEUE_LOADED", products });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  const current = state.queue[0] ?? null;

  const submit = useCallback(
    async (rawCode: string) => {
      const code = (rawCode ?? "").trim();
      const snap = stateRef.current;
      const head = snap.queue[0];
      if (!head || !businessId || code.length === 0) return;
      if (snap.status === "validating") return; // single-flight per code
      dispatch({ type: "SCAN_START" });
      const seq = snap.seq + 1; // matches what the reducer just bumped to
      try {
        const res = await enrollRef.current({
          businessId,
          productId: head.id,
          code,
          packagingId: head.packagingId ?? null,
          kind: head.packagingId ? "pack" : "gtin",
        });
        if (res.status === "ok") {
          dispatch({
            type: "SCAN_OK",
            seq,
            outcome: {
              productId: head.id,
              productName: head.name,
              code,
              at: Date.now(),
            },
          });
          scanFeedbackBus.emit({ kind: "ok", raw: code, source: "field" });
          if (!silentRef.current) playPOSSound("barcode_scan");
        } else if (res.status === "duplicate") {
          dispatch({
            type: "SCAN_DUPLICATE",
            seq,
            err: {
              kind: "duplicate",
              message: `Already used by "${res.conflict_product_name}"`,
              conflictProductName: res.conflict_product_name,
            },
          });
          scanFeedbackBus.emit({
            kind: "unknown",
            raw: code,
            source: "field",
            detail: `Duplicate — ${res.conflict_product_name}`,
          });
          if (!silentRef.current) playPOSSound("low_stock_warning");
        } else {
          dispatch({
            type: "SCAN_INVALID",
            seq,
            err: { kind: "invalid", message: res.reason || "Invalid code" },
          });
          scanFeedbackBus.emit({ kind: "error", raw: code, source: "field" });
          if (!silentRef.current) playPOSSound("error");
        }
      } catch (err: any) {
        dispatch({
          type: "SCAN_INVALID",
          seq,
          err: { kind: "invalid", message: err?.message || "Network error" },
        });
        if (!silentRef.current) playPOSSound("error");
      }
    },
    [businessId],
  );

  const skip = useCallback(() => dispatch({ type: "SKIP" }), []);
  const clearFeedback = useCallback(() => dispatch({ type: "CLEAR_FEEDBACK" }), []);
  const jump = useCallback((delta: number) => dispatch({ type: "JUMP", delta }), []);

  const undo = useCallback(async () => {
    const last = stateRef.current.lastEnrolled;
    if (!last || !businessId) return;
    // Server-side revert via dedicated RPC. The RPC handles primary-promotion
    // (deleting an is_primary identifier promotes the oldest remaining one)
    // so the product is never left with no primary code.
    try {
      const { data, error } = await supabase.rpc("revoke_product_barcode" as any, {
        p_business_id: businessId,
        p_product_id: last.productId,
        p_code: last.code,
      } as any);
      if (error) {
        scanFeedbackBus.emit({
          kind: "error",
          raw: last.code,
          source: "field",
          detail: `Undo failed — ${error.message}`,
        });
        if (!silentRef.current) playPOSSound("error");
        return; // DO NOT mutate UI on server failure.
      }
      const status = (data as any)?.status;
      if (status !== "ok") {
        if (status !== "not_found") {
          scanFeedbackBus.emit({
            kind: "error",
            raw: last.code,
            source: "field",
            detail: `Undo rejected (${status ?? "unknown"})`,
          });
          if (!silentRef.current) playPOSSound("error");
          return;
        }
      }
    } catch (err: any) {
      scanFeedbackBus.emit({
        kind: "error",
        raw: last.code,
        source: "field",
        detail: `Undo failed — ${err?.message ?? "network error"}`,
      });
      if (!silentRef.current) playPOSSound("error");
      return;
    }

    dispatch({
      type: "UNDO_RESTORE",
      product: {
        id: last.productId,
        name: last.productName,
        sku: null,
        unit_price: 0,
        image_url: null,
        category_id: null,
      },
    });
  }, [businessId]);

  /**
   * Record that this packaging level deliberately carries no code. The
   * level leaves the queue only after the server confirms — UI and DB
   * must not diverge (same contract as `flag`).
   */
  const waive = useCallback(
    async (reason?: string) => {
      const head = stateRef.current.queue[0];
      if (!head || !businessId) return;
      try {
        const { data, error } = await supabase.rpc("waive_product_identification" as any, {
          p_business_id: businessId,
          p_product_id: head.id,
          p_packaging_id: head.packagingId ?? null,
          p_reason: reason ?? "No code at this packaging level",
          p_waive: true,
        } as any);
        const status = (data as any)?.status;
        if (error || status !== "ok") {
          const detail = error?.message ?? status ?? "unknown";
          if (!silentRef.current) playPOSSound("error");
          dispatch({
            type: "FLAG_FAILED",
            err: { kind: "invalid", message: `Could not waive — ${detail}` },
          });
          return;
        }
        dispatch({ type: "DROP_HEAD" });
      } catch (err: any) {
        if (!silentRef.current) playPOSSound("error");
        dispatch({
          type: "FLAG_FAILED",
          err: { kind: "invalid", message: `Could not waive — ${err?.message ?? "network error"}` },
        });
      }
    },
    [businessId],
  );

  const flag = useCallback(
    async (reason: string) => {
      const head = stateRef.current.queue[0];
      if (!head || !businessId) return;
      // Persistence flows through the RPC so RLS + audit semantics stay
      // consistent with enroll/revoke. The cursor only advances on a
      // confirmed `status:"ok"` — on any failure we keep the cursor put
      // and surface the error so UI state and DB state cannot diverge.
      try {
        const { data, error } = await supabase.rpc("flag_product_for_review" as any, {
          p_business_id: businessId,
          p_product_id: head.id,
          p_reason: reason || "Flagged in enrollment workspace",
        } as any);
        const status = (data as any)?.status;
        if (error || status !== "ok") {
          const detail = error?.message ?? status ?? "unknown";
          scanFeedbackBus.emit({
            kind: "error",
            raw: "",
            source: "field",
            detail: `Flag failed — ${detail}`,
          });
          if (!silentRef.current) playPOSSound("error");
          dispatch({
            type: "FLAG_FAILED",
            err: { kind: "invalid", message: `Flag failed — ${detail}` },
          });
          return;
        }
        skip();
      } catch (err: any) {
        const detail = err?.message ?? "network error";
        scanFeedbackBus.emit({
          kind: "error",
          raw: "",
          source: "field",
          detail: `Flag failed — ${detail}`,
        });
        if (!silentRef.current) playPOSSound("error");
        dispatch({
          type: "FLAG_FAILED",
          err: { kind: "invalid", message: `Flag failed — ${detail}` },
        });
      }
    },
    [businessId, skip],
  );

  return useMemo(
    () => ({
      current,
      queue: state.queue,
      doneCount: state.doneCount,
      status: state.status,
      lastError: state.lastError,
      lastEnrolled: state.lastEnrolled,
      submit,
      skip,
      undo,
      flag,
      waive,
      jump,
      clearFeedback,
    }),
    [current, state, submit, skip, undo, flag, waive, jump, clearFeedback],
  );
}
