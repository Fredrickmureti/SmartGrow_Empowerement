/**
 * Dunning assignment hook — the "next action" column in Collections.
 *
 * Reads the server-side `dunning_assignment` view through the service layer.
 * No client-side escalation arithmetic.
 */
import { useEffect, useState } from "react";
import {
  fetchDunningAssignments,
  type DunningAssignmentRow,
} from "@/services/finance/dunning";
import { useBusinesses } from "@/hooks/useBusinesses";

export function useDunningAssignments() {
  const { currentBusiness } = useBusinesses();
  const [data, setData] = useState<Record<string, DunningAssignmentRow>>({});
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
    fetchDunningAssignments(orgId, businessId, null)
      .then((rows) => {
        if (cancelled) return;
        setData(rows);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message || "Failed to load dunning assignments");
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
