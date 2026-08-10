/**
 * Per-currency net AR position for the Collections workspace.
 *
 * ADR: reads `finance_ar_net_position_by_currency` via the service layer —
 * the only sanctioned source for per-currency receivable breakdowns.
 */
import { useEffect, useState } from "react";
import {
  fetchNetPositionByCurrency,
  type CurrencyNetPositionRow,
} from "@/services/finance/openItems";
import { useBusiness } from "@/hooks/useBusiness";

export interface PerCurrencyByContact {
  [contactId: string]: CurrencyNetPositionRow[];
}

export function useNetPositionByCurrency() {
  const { currentBusiness } = useBusiness();
  const [data, setData] = useState<PerCurrencyByContact>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const orgId = currentBusiness?.organization_id;
    const businessId = currentBusiness?.id ?? null;
    if (!orgId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    fetchNetPositionByCurrency(orgId, businessId, null)
      .then((rows) => {
        if (cancelled) return;
        const grouped: PerCurrencyByContact = {};
        for (const r of rows) {
          if (!grouped[r.contactId]) grouped[r.contactId] = [];
          grouped[r.contactId].push(r);
        }
        setData(grouped);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message || "Failed to load per-currency positions");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentBusiness?.organization_id, currentBusiness?.id]);

  return { data, isLoading, error };
}
