/**
 * Rate coverage for the Currency Settings screen (Phase 8).
 *
 * Read-only projection of `fx_rate_coverage_summary(business_id)`. Every fact —
 * which currencies are actually used, how far the rate book reaches, how stale
 * the provider snapshot is — is computed server-side. The browser renders it and
 * nothing else: no interpolation, no "assume 1:1", no client-side arithmetic.
 */

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type FxCoverageStatus = "none" | "partial" | "stale" | "covered";

export interface FxCoverageRow {
  currency: string;
  first_used_on: string | null;
  last_used_on: string | null;
  document_count: number;
  coverage_start: string | null;
  latest_rate_date: string | null;
  rate_dates: number;
  latest_rate: number | null;
  latest_source: string | null;
  uncovered_documents: number;
  status: FxCoverageStatus;
}

export interface FxCoverageSummary {
  business_id: string;
  base_currency: string | null;
  as_of: string;
  provider_snapshot_as_of: string | null;
  provider_snapshot_age_days: number | null;
  last_published_at: string | null;
  currencies_in_use: number;
  currencies_without_any_rate: number;
  currencies_partially_covered: number;
  currencies_stale: number;
  documents_before_coverage: number;
  coverage: FxCoverageRow[];
}

export function useFxRateCoverage(businessId: string | null | undefined) {
  const [summary, setSummary] = useState<FxCoverageSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!businessId) {
      setSummary(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("fx_rate_coverage_summary", {
      p_business_id: businessId,
    });
    if (rpcError) {
      setError(rpcError.message);
      setSummary(null);
    } else {
      const parsed = data as unknown as FxCoverageSummary | null;
      setSummary(
        parsed ? { ...parsed, coverage: parsed.coverage ?? [] } : null,
      );
    }
    setIsLoading(false);
  }, [businessId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { summary, isLoading, error, refresh };
}
