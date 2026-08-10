/**
 * AR disputes hook for the Collections workspace.
 *
 * Reads open disputes keyed by contact and exposes raise/resolve mutations.
 * All writes go through the server RPCs — the browser never inserts or
 * mutates a dispute row directly.
 */
import { useCallback, useEffect, useState } from "react";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  fetchOpenDisputesByContact,
  raiseArDispute,
  resolveArDispute,
  type ArDispute,
  type DisputeStatus,
} from "@/services/finance/disputes";

export interface ContactDisputeSummary {
  count: number;
  baseAmount: number;
  first: ArDispute;
}

export function useArDisputes() {
  const { currentBusiness } = useBusinesses();
  const orgId = currentBusiness?.organization_id ?? null;
  const businessId = currentBusiness?.id ?? null;

  const [data, setData] = useState<Record<string, ContactDisputeSummary>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      setData(await fetchOpenDisputesByContact({ orgId, businessId }));
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Failed to load disputes");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  const raise = useCallback(
    async (input: {
      contactId: string;
      amountDisputed: number;
      disputeType: string;
      reason?: string | null;
      documentId?: string | null;
    }) => {
      if (!businessId) throw new Error("No business selected");
      await raiseArDispute({ businessId, ...input });
      await load();
    },
    [businessId, load],
  );

  const resolve = useCallback(
    async (id: string, status: Exclude<DisputeStatus, "open">, note?: string | null) => {
      await resolveArDispute(id, status, note);
      await load();
    },
    [load],
  );

  /** Total disputed exposure (base currency) — reported, never netted off AR. */
  const totalDisputed = Object.values(data).reduce((s, d) => s + d.baseAmount, 0);

  return { data, isLoading, error, refresh: load, raise, resolve, totalDisputed };
}
