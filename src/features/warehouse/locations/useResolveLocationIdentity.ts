/**
 * useResolveLocationIdentity — the ONE client seam for turning a scanned or
 * typed code into a warehouse location.
 *
 * Mirrors `useResolveProductIdentity` (see
 * mem://features/product-identification): a single tenant-gated SQL
 * resolver, ambiguity is surfaced rather than guessed, and no surface may
 * query `stock_locations` by barcode directly.
 */
import { useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type LocationResolveStatus = "idle" | "resolving" | "ok" | "not_found" | "ambiguous" | "error";

export interface ResolvedLocation {
  location_id: string;
  warehouse_id: string;
  code: string;
  name: string;
  structure_level: string | null;
  location_type: string;
  usage: string;
  is_active: boolean;
  match_count: number;
  matched_on: string;
}

export interface LocationResolution {
  status: LocationResolveStatus;
  location: ResolvedLocation | null;
  message: string | null;
  raw: string | null;
}

const IDLE: LocationResolution = { status: "idle", location: null, message: null, raw: null };

export function useResolveLocationIdentity(warehouseId?: string | null) {
  const [resolution, setResolution] = useState<LocationResolution>(IDLE);

  const resolve = useCallback(
    async (code: string): Promise<LocationResolution> => {
      const trimmed = (code ?? "").trim();
      if (!trimmed) return IDLE;
      setResolution({ status: "resolving", location: null, message: null, raw: trimmed });
      try {
        const { data, error } = await supabase.rpc(
          "resolve_location_identity" as never,
          { p_code: trimmed, p_warehouse_id: warehouseId ?? null } as never,
        );
        if (error) throw error;
        const rows = (data ?? []) as unknown as ResolvedLocation[];
        let next: LocationResolution;
        if (rows.length === 0) {
          next = {
            status: "not_found",
            location: null,
            message: `No location matches “${trimmed}” in this warehouse.`,
            raw: trimmed,
          };
        } else if (rows.length > 1 || rows[0].match_count > 1) {
          next = {
            status: "ambiguous",
            location: null,
            message: `“${trimmed}” matches ${rows.length || rows[0].match_count} locations. Scan the bin label instead.`,
            raw: trimmed,
          };
        } else {
          next = { status: "ok", location: rows[0], message: null, raw: trimmed };
        }
        setResolution(next);
        return next;
      } catch (err) {
        const next: LocationResolution = {
          status: "error",
          location: null,
          message: err instanceof Error ? err.message : "Location lookup failed",
          raw: trimmed,
        };
        setResolution(next);
        return next;
      }
    },
    [warehouseId],
  );

  const reset = useCallback(() => setResolution(IDLE), []);

  return { resolve, reset, resolution };
}
