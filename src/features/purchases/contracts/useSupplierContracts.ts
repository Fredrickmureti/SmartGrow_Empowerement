/**
 * Contracts available to draw from for a given vendor contact.
 *
 * Returns only contracts a PO may legally cite: active, in-window, and
 * belonging to the current business. The database re-checks all of this on
 * approval — this hook exists so the UI never offers an option the ceiling
 * trigger would reject.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import type { ContractLine, ContractRow } from "./useContracts";

export interface SupplierContract extends ContractRow {
  lines: ContractLine[];
}

export function useSupplierContracts(vendorContactId?: string | null) {
  const { currentBusiness } = useBusinesses();
  const [contracts, setContracts] = useState<SupplierContract[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!vendorContactId || !currentBusiness?.id) {
      setContracts([]);
      return;
    }
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data: suppliers } = await (supabase as any)
        .from("suppliers")
        .select("id")
        .eq("contact_id", vendorContactId)
        .eq("business_id", currentBusiness.id);
      const supplierIds = (suppliers ?? []).map((s: { id: string }) => s.id);
      if (supplierIds.length === 0) {
        setContracts([]);
        return;
      }

      const { data } = await (supabase as any)
        .from("procurement_contracts")
        .select("*, lines:procurement_contract_lines(*)")
        .eq("business_id", currentBusiness.id)
        .in("supplier_id", supplierIds)
        .eq("status", "active")
        .lte("start_date", today)
        .or(`end_date.is.null,end_date.gte.${today}`)
        .order("contract_number", { ascending: true });

      setContracts((data ?? []) as SupplierContract[]);
    } finally {
      setLoading(false);
    }
  }, [vendorContactId, currentBusiness?.id]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { contracts, loading, refresh: fetch };
}

/** Remaining header capacity, or null when the contract has no value ceiling. */
export function contractRemaining(c: Pick<ContractRow, "ceiling_value" | "committed_value">) {
  if (c.ceiling_value == null) return null;
  return Number(c.ceiling_value) - Number(c.committed_value ?? 0);
}

/** The contract line covering a product, if any. */
export function findContractLine(contract: SupplierContract | undefined, productId?: string | null) {
  if (!contract || !productId) return undefined;
  return contract.lines?.find((l) => l.product_id === productId);
}
