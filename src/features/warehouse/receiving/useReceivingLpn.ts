/**
 * Receiving audit, Phase 4c — license-plate binding for receiving capture.
 *
 * A receiving line without a handling unit loses pallet identity the moment
 * the goods leave the dock: put-away, cross-dock and quarantine all key off
 * the LPN. Both the desktop workspace and the mobile loop resolve the scanned
 * or typed plate through this seam and pass `p_lpn_id` into
 * `wms_capture_receiving_line` — the LPN module stays the owner of plates,
 * receiving only references them.
 */
import { useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ActiveLpn {
  id: string;
  code: string;
}

/** Look up an existing license plate by its code within a business. */
export async function resolveLpnByCode(
  businessId: string,
  code: string,
): Promise<ActiveLpn | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const { data, error } = await supabase
    .from("wms_license_plates")
    .select("id, code")
    .eq("business_id", businessId)
    .eq("code", trimmed)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as ActiveLpn | null) ?? null;
}

/**
 * Scan classification for receiving surfaces.
 *
 * A dock operator scans plates and item labels into the *same* wedge, and the
 * scan router hands every code to the highest-priority target — which is the
 * item intent. Without this pre-check, scanning a plate label ran the code
 * through the product identity gate and the operator got
 * "Unknown code PLT-… — enrol it before receiving" for a plate the system
 * itself had just minted.
 *
 * So: before treating a code as a product, ask whether it *is* a plate.
 * GS1 payloads are never plates, so they short-circuit. Lookup failures are
 * swallowed — the caller falls through to the product gate, which owns the
 * blocking semantics.
 */
export async function tryResolvePlateScan(
  businessId: string | undefined,
  raw: string,
  isGs1 = false,
): Promise<ActiveLpn | null> {
  if (!businessId || isGs1) return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\x1d]/.test(trimmed)) return null;
  try {
    return await resolveLpnByCode(businessId, trimmed);
  } catch {
    return null;
  }
}

/**
 * Holds the pallet the operator is currently working on. Every capture made
 * while a plate is active is stamped with it.
 */
export function useActiveLpn(businessId: string | undefined) {
  const [activeLpn, setActiveLpn] = useState<ActiveLpn | null>(null);
  const [resolving, setResolving] = useState(false);

  const bind = useCallback(
    async (code: string): Promise<ActiveLpn | null> => {
      if (!businessId) return null;
      setResolving(true);
      try {
        const lpn = await resolveLpnByCode(businessId, code);
        setActiveLpn(lpn);
        return lpn;
      } finally {
        setResolving(false);
      }
    },
    [businessId],
  );

  const clear = useCallback(() => setActiveLpn(null), []);

  return { activeLpn, bind, clear, resolving };
}
