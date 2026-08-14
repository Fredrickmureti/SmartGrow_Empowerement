/**
 * Receiving line-grain data access (Receiving audit, Phase 2–4).
 *
 * The receiving *session* is the unit of work; the receiving *line* is the unit
 * of record. Every quantity, lot, serial, expiry, damage and hold decision
 * lands on `wms_receiving_lines` through `wms_capture_receiving_line` — never
 * in a toast, never as a session-level state flip.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { dispatchGoodsReceipt } from "@/features/purchases/goods-receipt/dispatchGoodsReceipt";

export interface ReceivingLine {
  id: string;
  session_id: string;
  product_id: string | null;
  purchase_order_item_id: string | null;
  inbound_shipment_item_id: string | null;
  lot_number: string | null;
  serial_number: string | null;
  expiry_date: string | null;
  expected_qty: number | null;
  received_qty: number | null;
  /** What the operator typed, in `packaging_id`'s level (audit truth). */
  entered_qty: number | null;
  packaging_id: string | null;
  damaged_qty: number | null;
  qc_hold: boolean;
  uom: string | null;
  line_state: "expected" | "captured" | "unexpected";
  staging_location_id: string | null;
  notes: string | null;
  captured_at: string | null;
  products?: { name: string | null; sku: string | null } | null;
}

export interface ReceivingProgress {
  session_id: string;
  line_count: number;
  captured_lines: number;
  expected_qty: number;
  received_qty: number;
  damaged_qty: number;
  unexpected_lines: number;
  short_lines: number;
  over_lines: number;
  hold_lines: number;
  damaged_lines: number;
}

export const RECEIVING_LINES_KEY = "wms-receiving-lines";
export const RECEIVING_PROGRESS_KEY = "wms-receiving-progress";

export function useReceivingLines(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: [RECEIVING_LINES_KEY, sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_receiving_lines" as any)
        .select(
          "id, session_id, product_id, purchase_order_item_id, inbound_shipment_item_id, lot_number, serial_number, expiry_date, expected_qty, received_qty, entered_qty, packaging_id, damaged_qty, qc_hold, uom, line_state, staging_location_id, notes, captured_at, products(name, sku), packaging:product_packaging(name)",
        )
        .eq("session_id", sessionId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as ReceivingLine[];
    },
  });
}

/** Per-session rollup used by the session list to show variance without N+1. */
export function useReceivingProgress(businessId: string | undefined) {
  return useQuery({
    queryKey: [RECEIVING_PROGRESS_KEY, businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_receiving_session_progress" as any)
        .select("*")
        .eq("business_id", businessId!);
      if (error) throw error;
      const rows = (data ?? []) as unknown as ReceivingProgress[];
      return new Map(rows.map((r) => [r.session_id, r]));
    },
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: [RECEIVING_LINES_KEY] });
    qc.invalidateQueries({ queryKey: [RECEIVING_PROGRESS_KEY] });
    qc.invalidateQueries({ queryKey: ["wms-receiving-sessions"] });
  };
}

/** Expand the bound PO / ASN into expected lines. Idempotent server-side. */
export function useMaterializeExpectedLines() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const { data, error } = await supabase.rpc("wms_materialize_expected_lines" as any, {
        p_session_id: sessionId,
      });
      if (error) throw error;
      return data as { created: number; reason?: string };
    },
    onSuccess: invalidate,
  });
}

export interface CaptureInput {
  sessionId: string;
  /**
   * The quantity the operator captured. When `packagingId` is supplied this is
   * expressed in that packaging level and `wms_capture_receiving_line`
   * converts it through `wms_to_base_qty`; otherwise it is already in base
   * ledger units. The browser never multiplies.
   */
  receivedQty: number;
  productId: string;
  /** `product_packaging.id` the quantity was captured in, if not base units. */
  packagingId?: string | null;
  expectedQty?: number | null;
  lotNumber?: string | null;
  serialNumber?: string | null;
  expiryDate?: string | null;
  uom?: string | null;
  damagedQty?: number | null;
  qcHold?: boolean;
  lpnId?: string | null;
  stagingLocationId?: string | null;
  notes?: string | null;
  clientScanId?: string | null;
  deviceId?: string | null;
}

export function useCaptureReceivingLine() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: CaptureInput) => {
      const { data, error } = await supabase.rpc("wms_capture_receiving_line" as any, {
        p_session_id: input.sessionId,
        p_product_id: input.productId,
        p_received_qty: input.receivedQty,
        p_entered_qty: input.receivedQty,
        p_packaging_id: input.packagingId ?? null,
        p_expected_qty: input.expectedQty ?? null,
        p_lpn_id: input.lpnId ?? null,
        p_lot_number: input.lotNumber ?? null,
        p_serial_number: input.serialNumber ?? null,
        p_uom: input.uom ?? null,
        p_staging_location_id: input.stagingLocationId ?? null,
        p_notes: input.notes ?? null,
        p_client_scan_id: input.clientScanId ?? null,
        p_device_id: input.deviceId ?? null,
        p_expiry_date: input.expiryDate ?? null,
        p_damaged_qty: input.damagedQty ?? 0,
        p_entered_damaged_qty: input.damagedQty ?? 0,
        p_qc_hold: input.qcHold ?? false,
      });
      if (error) throw error;
      return data as { line_id: string; unexpected: boolean; replayed: boolean };
    },
    onSuccess: invalidate,
  });
}


/** Raise a warehouse exception per variant line (shortage/overage/damage/hold). */
export function useFlagVariances() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const { data, error } = await supabase.rpc("wms_flag_receiving_variances" as any, {
        p_session_id: sessionId,
      });
      if (error) throw error;
      return data as { raised: number };
    },
    onSuccess: invalidate,
  });
}

/**
 * The single posting path: captured lines → goods receipt (which writes the
 * ledger) → WMS staging for put-away → session `posted`.
 */
export function usePostReceivingSession() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { sessionId: string; rowVersion: number; stagingLocationId?: string | null }) => {
      const { data, error } = await supabase.rpc("wms_post_receiving_session" as any, {
        p_session_id: input.sessionId,
        p_row_version: input.rowVersion,
        p_staging_location_id: input.stagingLocationId ?? null,
      });
      if (error) throw error;
      const result = data as { goods_receipt_id: string; receipt_number: string };
      // GRN convergence: the receiving session is the only capture path, so it
      // is also the only producer of the GRN paper. Archiving the document is
      // best-effort — a failed print must never invalidate a posted receipt.
      if (result?.goods_receipt_id) {
        void dispatchGoodsReceipt({ goodsReceiptId: result.goods_receipt_id }).catch(() => undefined);
      }
      return result;
    },
    onSuccess: invalidate,
  });
}
