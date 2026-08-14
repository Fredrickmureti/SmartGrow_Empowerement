/**
 * Return line data access — capture, inspection, disposition, posting.
 *
 * Every mutation is an RPC with an optimistic `row_version`; the client never
 * updates quantities, dispositions or inspection state with a direct table
 * write. Disposition is persisted on the line, not only in the outbox.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RETURN_ORDERS_KEY } from "./useReturnOrders";
import type {
  ReturnCondition,
  ReturnDisposition,
  ReturnInspectionState,
  ReturnLine,
} from "./returnsModel";

export const RETURN_LINES_KEY = "wms-return-lines";

const LINE_COLUMNS =
  "id, return_order_id, product_id, lpn_id, lpn_out_id, lot_number, serial_number, uom, expected_qty, received_qty, entered_qty, packaging_id, condition_code, inspection_state, qc_inspection_id, disposition, destination_location_id, restock_qty, quarantine_qty, scrap_qty, photo_count, blocked_reason, captured_at, inspected_at, dispositioned_at, posted_at, notes, row_version, created_at, products(name, sku), packaging:product_packaging(name)";

export function useReturnLines(returnId: string | null | undefined) {
  return useQuery({
    queryKey: [RETURN_LINES_KEY, returnId],
    enabled: !!returnId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_return_lines" as any)
        .select(LINE_COLUMNS)
        .eq("return_order_id", returnId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as ReturnLine[];
    },
  });
}

/** Lines across many returns, for tower lane derivation without N+1. */
export function useReturnLinesForOrders(returnIds: string[]) {
  const key = returnIds.slice().sort().join(",");
  return useQuery({
    queryKey: [RETURN_LINES_KEY, "bulk", key],
    enabled: returnIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_return_lines" as any)
        .select(LINE_COLUMNS)
        .in("return_order_id", returnIds);
      if (error) throw error;
      const rows = (data ?? []) as unknown as ReturnLine[];
      const map = new Map<string, ReturnLine[]>();
      for (const row of rows) {
        const list = map.get(row.return_order_id) ?? [];
        list.push(row);
        map.set(row.return_order_id, list);
      }
      return map;
    },
  });
}

function useInvalidateLines() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: [RETURN_LINES_KEY] });
    qc.invalidateQueries({ queryKey: [RETURN_ORDERS_KEY] });
  };
}

export interface CaptureReturnLineInput {
  returnId: string;
  productId: string;
  /**
   * What the operator captured. With `packagingId` set this is expressed in
   * that packaging level and `wms_capture_return_line` converts it through
   * `wms_to_base_qty`; otherwise it is already in base ledger units. The
   * browser never multiplies a packaging factor into a ledger quantity.
   */
  receivedQty: number;
  /** `product_packaging.id` the quantity was captured in, null for base. */
  packagingId?: string | null;
  expectedQty?: number | null;
  lpnId?: string | null;
  lotNumber?: string | null;
  serialNumber?: string | null;
  uom?: string | null;
  conditionCode?: ReturnCondition | null;
  notes?: string | null;
  clientScanId?: string | null;
  deviceId?: string | null;
}

export function useCaptureReturnLine() {
  const invalidate = useInvalidateLines();
  return useMutation({
    mutationFn: async (input: CaptureReturnLineInput) => {
      const { data, error } = await supabase.rpc("wms_capture_return_line" as any, {
        p_return_id: input.returnId,
        p_product_id: input.productId,
        p_received_qty: input.receivedQty,
        p_entered_qty: input.receivedQty,
        p_packaging_id: input.packagingId ?? null,
        p_expected_qty: input.expectedQty ?? null,
        p_lpn_id: input.lpnId ?? null,
        p_lot_number: input.lotNumber ?? null,
        p_serial_number: input.serialNumber ?? null,
        p_uom: input.uom ?? null,
        p_condition_code: input.conditionCode ?? null,
        p_notes: input.notes ?? null,
        p_client_scan_id: input.clientScanId ?? null,
        p_device_id: input.deviceId ?? null,
      });
      if (error) throw error;
      return data as { line_id: string; unexpected: boolean; replayed: boolean };
    },
    onSuccess: invalidate,
  });
}


export interface InspectionCheckInput {
  check_code: string;
  check_label: string;
  expected?: string | null;
  actual?: string | null;
  pass?: boolean | null;
  severity?: "minor" | "major" | "critical" | null;
  photo_url?: string | null;
}

export function useInspectReturnLine() {
  const invalidate = useInvalidateLines();
  return useMutation({
    mutationFn: async (input: {
      lineId: string;
      rowVersion: number;
      inspectionState: ReturnInspectionState;
      conditionCode?: ReturnCondition | null;
      checks?: InspectionCheckInput[];
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("wms_inspect_return_line" as any, {
        p_line_id: input.lineId,
        p_row_version: input.rowVersion,
        p_inspection_state: input.inspectionState,
        p_condition_code: input.conditionCode ?? null,
        p_checks: input.checks ?? [],
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data as { line_id: string; inspection_id: string; row_version: number };
    },
    onSuccess: invalidate,
  });
}

export function useDispositionReturnLine() {
  const invalidate = useInvalidateLines();
  return useMutation({
    mutationFn: async (input: {
      lineId: string;
      rowVersion: number;
      /** Omit to let the server apply the matching disposition rule. */
      disposition?: ReturnDisposition | null;
      restockQty?: number | null;
      quarantineQty?: number | null;
      scrapQty?: number | null;
      destinationLocationId?: string | null;
      notes?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("wms_disposition_return_line" as any, {
        p_line_id: input.lineId,
        p_row_version: input.rowVersion,
        p_disposition: input.disposition ?? null,
        p_restock_qty: input.restockQty ?? null,
        p_quarantine_qty: input.quarantineQty ?? 0,
        p_scrap_qty: input.scrapQty ?? 0,
        p_destination_location_id: input.destinationLocationId ?? null,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data as {
        line_id: string;
        row_version: number;
        disposition: ReturnDisposition;
        restock_qty: number;
        quarantine_qty: number;
        scrap_qty: number;
      };
    },
    onSuccess: invalidate,
  });
}

/** The single inventory-effect path: stock movements + tasks + exceptions. */
export function usePostReturnDispositions() {
  const invalidate = useInvalidateLines();
  return useMutation({
    mutationFn: async (input: { returnId: string; rowVersion: number }) => {
      const { data, error } = await supabase.rpc("wms_post_return_dispositions" as any, {
        p_return_id: input.returnId,
        p_row_version: input.rowVersion,
      });
      if (error) throw error;
      return data as {
        posted_lines: number;
        blocked_lines: number;
        tasks_created: number;
        restock_qty: number;
        quarantine_qty: number;
        scrap_qty: number;
      };
    },
    onSuccess: invalidate,
  });
}
