/**
 * ExchangeRatePanel — the ONE display surface for "what rate does the book hold
 * for this currency on this date, and where did it come from?" (ADR 0136).
 *
 * Display only. It never converts a posted amount and never sends a rate: the
 * authoritative booking rate is resolved and stamped server-side by
 * `require_exchange_rate` / `fx_stamp_document` and the posting engines.
 *
 * A missing rate is an absence, rendered as a destructive block — never 1:1.
 * Callers use `missingRate` to disable submission so a document can never be
 * valued at parity.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

/** Shape returned by the canonical `public.describe_exchange_rate`. */
export interface DescribedRate {
  rate: number;
  source: string | null;
  provider_key: string | null;
  effective_date: string;
  scope: string | null;
}

const RATE_SOURCE_LABEL: Record<string, string> = {
  base: "Base currency",
  override: "Tenant override",
  manual: "Manual entry",
  provider: "Platform",
};

export function useDescribedExchangeRate(currency: string, onDate: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const baseCurrency = currentBusiness?.base_currency ?? "";

  const query = useQuery({
    queryKey: [
      "fx-describe",
      currentOrg?.id,
      currentBusiness?.id,
      currency,
      onDate,
    ],
    enabled:
      !!currentOrg?.id && !!currentBusiness?.id && !!currency && !!onDate,
    queryFn: async (): Promise<DescribedRate | null> => {
      const { data, error } = await supabase.rpc("describe_exchange_rate", {
        p_org_id: currentOrg!.id,
        p_business_id: currentBusiness!.id,
        p_currency: currency,
        p_on_date: onDate,
      });
      if (error) throw error;
      const row = (data as DescribedRate[] | null)?.[0];
      return row ?? null;
    },
  });

  const isBase = !!currency && !!baseCurrency && currency === baseCurrency;

  return {
    rate: query.data ?? null,
    isLoading: query.isLoading,
    baseCurrency,
    isBase,
    /** True when a non-base currency has no rate on file for `onDate`. */
    missingRate: !!currency && !!baseCurrency && !isBase && !query.isLoading && !query.data,
  };
}

interface ExchangeRatePanelProps {
  currency: string;
  onDate: string;
  /** Sentence shown when the document currency is the base currency. */
  baseHint?: string;
  /** Sentence appended to the missing-rate block. */
  missingHint?: string;
}

export function ExchangeRatePanel({
  currency,
  onDate,
  baseHint = "Amounts are already in the base currency — no conversion applies.",
  missingHint = "Publish or override a rate in the rate book before saving — this document cannot be valued at parity.",
}: ExchangeRatePanelProps) {
  const { rate, isLoading, baseCurrency, isBase } = useDescribedExchangeRate(
    currency,
    onDate,
  );

  if (!currency) {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        Select a currency to resolve its rate.
      </p>
    );
  }

  if (isBase) {
    return <p className="mt-1 text-xs text-muted-foreground">{baseHint}</p>;
  }

  if (isLoading) {
    return <p className="mt-1 text-xs text-muted-foreground">Resolving rate…</p>;
  }

  if (rate) {
    return (
      <div className="text-sm">
        <div className="font-medium">
          1 {currency} ={" "}
          {Number(rate.rate).toLocaleString(undefined, {
            maximumFractionDigits: 6,
          })}{" "}
          {baseCurrency}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Source: {RATE_SOURCE_LABEL[rate.source ?? ""] ?? rate.source}
          {rate.provider_key ? ` (${rate.provider_key})` : ""}
          {" · Effective: "}
          {rate.effective_date}
        </p>
      </div>
    );
  }

  return (
    <p className="mt-1 text-xs text-destructive">
      No rate on file for {currency} → {baseCurrency} on {onDate}. {missingHint}
    </p>
  );
}
