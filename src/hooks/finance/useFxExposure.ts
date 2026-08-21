/**
 * useFxExposure — read-only FX exposure, straight from the server (ADR 0136).
 *
 * Exposure answers "what is at risk before I revalue": open foreign-currency
 * monetary balances, the value already booked, the rate the resolver would use
 * today (with its provenance) and the resulting unrealized difference.
 *
 * It is a PROJECTION. It posts nothing, and it computes no rate in the browser:
 * `public.fx_exposure_by_currency` / `public.fx_exposure_open_items` derive every
 * rate from `resolve_exchange_rate`, over the same open-balance scope as
 * `revalue_fx_balances`, so the exposure report and the revaluation run can never
 * present different numbers for the same date. A currency with no rate on file is
 * returned with `rate = null` and flagged — never valued at 1:1.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface FxExposureCurrency {
  currency: string;
  foreign_balance: number;
  receivable: number;
  payable: number;
  cash_bank: number;
  other: number;
  account_count: number;
  booked_base_amount: number;
  rate: number | null;
  rate_source: string | null;
  rate_provider_key: string | null;
  rate_effective_date: string | null;
  rate_scope: string | null;
  revalued_base_amount: number | null;
  unrealized_difference: number | null;
}

export interface FxExposure {
  base_currency: string;
  as_of: string;
  currencies: FxExposureCurrency[];
  missing_rates: string[];
}

export interface FxExposureOpenItem {
  journal_entry_id: string;
  entry_number: string | null;
  entry_date: string;
  source_type: string | null;
  source_id: string | null;
  description: string | null;
  account_id: string;
  account_code: string | null;
  account_name: string | null;
  detail_type: string | null;
  foreign_amount: number;
  booked_base_amount: number;
  booked_rate: number | null;
  revalued_base_amount: number | null;
  difference: number | null;
}

export interface FxExposureOpenItems {
  base_currency: string;
  currency: string;
  as_of: string;
  rate: number | null;
  rate_source: string | null;
  rate_provider_key: string | null;
  rate_effective_date: string | null;
  rate_scope: string | null;
  items: FxExposureOpenItem[];
}

export function useFxExposure(asOf: string) {
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["fx-exposure", currentBusiness?.id, asOf],
    enabled: !!currentBusiness?.id && !!asOf,
    queryFn: async (): Promise<FxExposure> => {
      const { data, error } = await (supabase as any).rpc("fx_exposure_by_currency", {
        _business_id: currentBusiness!.id,
        _as_of: asOf,
      });
      if (error) throw error;
      return data as FxExposure;
    },
  });
}

export function useFxExposureOpenItems(currency: string | null, asOf: string) {
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["fx-exposure-items", currentBusiness?.id, currency, asOf],
    enabled: !!currentBusiness?.id && !!currency && !!asOf,
    queryFn: async (): Promise<FxExposureOpenItems> => {
      const { data, error } = await (supabase as any).rpc("fx_exposure_open_items", {
        _business_id: currentBusiness!.id,
        _currency: currency,
        _as_of: asOf,
      });
      if (error) throw error;
      return data as FxExposureOpenItems;
    },
  });
}
/**
 * Exposure dimensions: the same open-balance scope and the same server-side
 * resolver, cut by counterparty and by how long the amount has been open.
 * Purely a projection — no rate, no conversion and no ageing arithmetic here.
 */
export interface FxExposureCounterparty {
  currency: string;
  contact_id: string | null;
  contact_name: string;
  foreign_balance: number;
  booked_base_amount: number;
  rate: number | null;
  revalued_base_amount: number | null;
  unrealized_difference: number | null;
}

export interface FxExposureAgeBucket {
  currency: string;
  bucket: string;
  bucket_order: number;
  foreign_balance: number;
  booked_base_amount: number;
  rate: number | null;
  revalued_base_amount: number | null;
  unrealized_difference: number | null;
}

export interface FxExposureDimensions {
  base_currency: string;
  as_of: string;
  currency_filter: string | null;
  by_counterparty: FxExposureCounterparty[];
  by_age_bucket: FxExposureAgeBucket[];
  missing_rates: string[];
}

export function useFxExposureDimensions(asOf: string, currency?: string | null) {
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["fx-exposure-dimensions", currentBusiness?.id, asOf, currency ?? null],
    enabled: !!currentBusiness?.id && !!asOf,
    queryFn: async (): Promise<FxExposureDimensions> => {
      const { data, error } = await (supabase as any).rpc("fx_exposure_dimensions", {
        _business_id: currentBusiness!.id,
        _as_of: asOf,
        _currency: currency ?? null,
      });
      if (error) throw error;
      return data as FxExposureDimensions;
    },
  });
}
