/**
 * Collections work queue hook.
 *
 * Thin wrapper over `get_collections_work_queue`. Ranking, dispute/promise
 * de-prioritisation and exposure all come from SQL; this hook only chooses
 * whether to scope the queue to the current user.
 */
import { useCallback, useEffect, useState } from "react";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  fetchCollectionsWorkQueue,
  type WorkQueueRow,
} from "@/services/finance/collectionsWorkQueue";

export function useCollectionsWorkQueue(collectorUserId?: string | null) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id ?? null;

  const [data, setData] = useState<WorkQueueRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!businessId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      setData(await fetchCollectionsWorkQueue({ businessId, collectorUserId }));
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Failed to load the work queue");
    } finally {
      setIsLoading(false);
    }
  }, [businessId, collectorUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, isLoading, error, refresh: load };
}
