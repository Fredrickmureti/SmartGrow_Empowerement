/**
 * Promise-to-pay hook for the Collections workspace.
 *
 * Loads the open commitments keyed by contact and exposes record/cancel
 * mutations. Status transitions are server-owned (`evaluate_promise_status`);
 * this hook only triggers the evaluation and re-reads.
 */
import { useCallback, useEffect, useState } from "react";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  cancelPromiseToPay,
  evaluatePromiseStatus,
  fetchOpenPromisesByContact,
  recordPromiseToPay,
  type PromiseToPay,
} from "@/services/finance/promises";

export function usePromisesToPay() {
  const { currentBusiness } = useBusinesses();
  const orgId = currentBusiness?.organization_id ?? null;
  const businessId = currentBusiness?.id ?? null;

  const [data, setData] = useState<Record<string, PromiseToPay>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      // Refresh kept/broken states before reading, so the work list is truthful.
      await evaluatePromiseStatus(businessId).catch(() => 0);
      setData(await fetchOpenPromisesByContact({ orgId, businessId }));
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Failed to load promises to pay");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  const record = useCallback(
    async (input: {
      contactId: string;
      promisedAmount: number;
      expectedPaymentDate: string;
      notes?: string | null;
      documentId?: string | null;
    }) => {
      if (!businessId) throw new Error("No business selected");
      await recordPromiseToPay({ businessId, ...input });
      await load();
    },
    [businessId, load],
  );

  const cancel = useCallback(
    async (id: string) => {
      await cancelPromiseToPay(id);
      await load();
    },
    [load],
  );

  return { data, isLoading, error, refresh: load, record, cancel };
}
