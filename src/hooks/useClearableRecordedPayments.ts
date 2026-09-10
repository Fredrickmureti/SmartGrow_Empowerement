/**
 * useClearableRecordedPayments — money already recorded and waiting for this
 * bank line to explain it.
 *
 * ADR-0147 names two kinds of resolution: *clearing* money already recorded
 * (a receipt sitting in Undeposited Funds) and *settling* a document, which
 * records new money.
 *
 * Microfinance scope: the ERP receipt register (`payments`) has been removed.
 * Lending money-in is recorded as `mf_repayments` and reaches the bank through
 * `mf_bank_collection_batch`, which posts the deposit and writes the matching
 * bank line in the same transaction — so there is no unbanked receipt left for
 * an operator to clear by hand. This hook therefore reports no candidates and
 * no holding accounts; the Recorded tab stays inert until a money-in path that
 * genuinely parks cash in a holding account exists.
 */
import { useQuery } from "@tanstack/react-query";

export interface ClearableRecordedPayment {
  /** `payment` — a recorded receipt waiting to be banked. */
  kind: "payment";
  id: string;
  amount: number;
  date: string;
  reference: string | null;
  method: string | null;
  partyName: string | null;
  /** The clearing account the money is waiting in. */
  holdingAccountId: string | null;
}

export interface ClearableRecordedPaymentsResult {
  candidates: ClearableRecordedPayment[];
  holdingAccountIds: string[];
}

const EMPTY: ClearableRecordedPaymentsResult = { candidates: [], holdingAccountIds: [] };

export function useClearableRecordedPayments(_params: {
  amount: number;
  isCredit: boolean;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["clearable-recorded-payments"],
    enabled: false,
    queryFn: async (): Promise<ClearableRecordedPaymentsResult> => EMPTY,
    initialData: EMPTY,
  });
}
