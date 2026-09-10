/**
 * useClearableRecordedPayments — money that is already recorded and is waiting
 * for this bank line to explain it.
 *
 * ADR-0147 names two kinds of resolution: *clearing* money already recorded
 * (a receipt sitting in Undeposited Funds) and *settling* a document, which
 * records new money. Clearing gets its own picker so an operator never has to
 * post the same money twice.
 *
 * Microfinance scope: only money-in receipts parked in a holding account are
 * clearable. Money-out lines reconcile through the Expenses tab, an account
 * offset or a transfer — the ERP supplier-payment branch is gone.
 *
 * Two rules keep the picker honest rather than merely helpful:
 *  - A receipt is deposited **in full** and at most once, so only recorded
 *    payments whose amount equals the bank line are offered. `_bank_match_validate`
 *    refuses anything else; the picker must not offer what the seam will refuse.
 *  - Money already spoken for by a confirmed or open match is withheld.
 *
 * `holdingAccountIds` is the set of clearing accounts this company actually
 * parks money in, derived from the payments themselves rather than from account
 * names. The Journal tab uses it to refuse a hand-post that would drain a
 * holding account without ever marking the receipt deposited.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

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
const EPSILON = 0.005;

export function useClearableRecordedPayments(params: {
  amount: number;
  isCredit: boolean;
  enabled?: boolean;
}) {
  const { amount, isCredit, enabled = true } = params;
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: [
      "clearable-recorded-payments",
      currentOrg?.id,
      currentBusiness?.id,
      isCredit ? "in" : "out",
      Math.round(amount * 100),
    ],
    enabled: enabled && isCredit && !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 15_000,
    queryFn: async (): Promise<ClearableRecordedPaymentsResult> => {
      const orgId = currentOrg!.id;
      const businessId = currentBusiness!.id;
      const claimed = await spokenFor(businessId);

      const { data, error } = await supabase
        .from("payments")
        .select("id, amount, payment_date, reference, payment_method, deposit_account_id, contact_id, status")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .not("deposit_account_id", "is", null)
        .order("payment_date", { ascending: false })
        .limit(500);
      if (error) throw error;

      const live = ((data ?? []) as Array<Record<string, unknown>>).filter(
        (r) =>
          !["voided", "cancelled"].includes(String(r.status ?? "")) &&
          !claimed.has(String(r.id)),
      );
      const names = await namesFor(live.map((r) => String(r.contact_id ?? "")));

      return {
        holdingAccountIds: [
          ...new Set(live.map((r) => String(r.deposit_account_id)).filter(Boolean)),
        ],
        candidates: live
          .filter((r) => Math.abs(Number(r.amount) - amount) < EPSILON)
          .map((r) => ({
            kind: "payment" as const,
            id: String(r.id),
            amount: Number(r.amount),
            date: String(r.payment_date),
            reference: (r.reference as string) ?? null,
            method: (r.payment_method as string) ?? null,
            partyName: names.get(String(r.contact_id ?? "")) ?? null,
            holdingAccountId: String(r.deposit_account_id),
          })),
      };
    },
    initialData: EMPTY,
  });
}
