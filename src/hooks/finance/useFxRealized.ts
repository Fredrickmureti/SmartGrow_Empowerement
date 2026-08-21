/**
 * useFxRealizedGainLoss — realized FX gain/loss, straight from the server (ADR 0136/0138).
 *
 * Realized FX is posted at settlement by `record_multi_invoice_payment` /
 * `record_multi_bill_payment` (ADR 0123 posting monopoly). This report is a
 * PROJECTION over what those postings actually put in the ledger: it reads the
 * realized FX gain/loss accounts resolved by `resolve_fx_realized_account`, so
 * the report and the general ledger cannot diverge.
 *
 * The browser resolves no rate and computes no posted amount — it formats what
 * `public.fx_realized_gain_loss` returns.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface FxRealizedSettlement {
  journal_entry_id: string;
  entry_number: string | null;
  entry_date: string;
  reference: string | null;
  description: string | null;
  source_type: string | null;
  source_id: string | null;
  party_name: string | null;
  currency: string;
  settlement_rate: number | null;
  settled_foreign_amount: number | null;
  booked_base_amount: number;
  booked_rate: number | null;
  realized_amount: number;
  kind: "gain" | "loss";
}

export interface FxRealizedByCurrency {
  currency: string;
  settlement_count: number;
  gain: number;
  loss: number;
  net: number;
}

export interface FxRealizedGainLoss {
  base_currency: string;
  from: string;
  to: string;
  accounts_configured: boolean;
  settlements: FxRealizedSettlement[];
  by_currency: FxRealizedByCurrency[];
  total_gain: number;
  total_loss: number;
  net_realized: number;
}

export function useFxRealizedGainLoss(from: string, to: string) {
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["fx-realized", currentBusiness?.id, from, to],
    enabled: !!currentBusiness?.id && !!from && !!to,
    queryFn: async (): Promise<FxRealizedGainLoss> => {
      const { data, error } = await (supabase as any).rpc("fx_realized_gain_loss", {
        _business_id: currentBusiness!.id,
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return data as FxRealizedGainLoss;
    },
  });
}
