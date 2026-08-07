import { useCallback, useEffect, useState } from "react";
import {
  useTransactionReversal,
  type ReversalConsequences,
  type ReversalDocumentType,
} from "@/hooks/useTransactionReversal";

/**
 * Fetch container for the Phase 2 consequence preview.
 *
 * Kept separate from `ReversalConsequencePreview` on purpose: the preview is a
 * pure projection of the server's answer and must stay free of data access, so
 * it can be mounted in any reversal confirmation surface (invoice void, payment
 * reversal wizard, and — from Phase 3 — bills and goods receipts) without each
 * surface re-implementing the fetch.
 *
 * Never cached across documents: settlement, reconciliation and period state
 * change underneath a long-lived dialog.
 */
export function useReversalConsequences(
  documentType: ReversalDocumentType,
  documentId: string | null | undefined,
  enabled: boolean,
) {
  const { previewReversalConsequences } = useTransactionReversal();
  const [consequences, setConsequences] = useState<ReversalConsequences | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  /**
   * Phase 4: the preview must be re-projected after a blocker is resolved
   * (e.g. a bank statement line was un-matched), otherwise the surface would
   * keep gating on stale server truth.
   */
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !documentId) {
      setConsequences(null);
      setIsError(false);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setIsError(false);
    previewReversalConsequences(documentType, documentId)
      .then((result) => {
        if (cancelled) return;
        setConsequences(result);
        setIsError(result === null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, documentType, documentId, nonce]);

  return { consequences, isLoading, isError, refetch };
}
