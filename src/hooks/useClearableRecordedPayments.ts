/**
 * useClearableRecordedPayments — money that is already recorded and is waiting
 * for this bank line to explain it.
 *
 * ADR-0147 names two kinds of resolution: *clearing* money already recorded
 * (a receipt sitting in Undeposited Funds, a supplier payment presenting at the
 * bank) and *settling* a document, which records new money. Until now clearing
 * was reachable only as an engine suggestion — when the suggestion was
 * suppressed, an operator's only options were to settle the invoice a second
 * time or hand-post a journal. Both are the duplicate the engine exists to
 * prevent, so clearing gets its own picker.
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
  /** `payment` for a customer receipt, `bill_payment` for a supplier payment. */
  kind: "payment" | "bill_payment";
  id: string;
  amount: number;
  date: string;
  reference: string | null;
  method: string | null;
  partyName: string | null;
  /** The clearing account the money is waiting in (money-in only). */
  holdingAccountId: string | null;
}

export interface ClearableRecordedPaymentsResult {
  candidates: ClearableRecordedPayment[];
  holdingAccountIds: string[];
}

const EMPTY: ClearableRecordedPaymentsResult = { candidates: [], holdingAccountIds: [] };
const EPSILON = 0.005;

async function namesFor(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const { data } = await supabase.from("contacts").select("id, name").in("id", unique);
  for (const row of data ?? []) out.set(row.id, row.name);
  return out;
}

/** Document ids already claimed by a confirmed or still-open match. */
async function spokenFor(businessId: string): Promise<Set<string>> {
  const claimed = new Set<string>();
  const { data } = await supabase
    .from("bank_reconciliation_matches")
    .select("allocations, status")
    .eq("business_id", businessId)
    .in("status", ["confirmed", "suggested", "to_check"]);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const allocations = Array.isArray(row.allocations) ? row.allocations : [];
    for (const a of allocations as Array<Record<string, unknown>>) {
      const kind = String(a.document_type ?? "");
      if (kind === "payment" || kind === "bill_payment") claimed.add(String(a.document_id));
    }
  }
  return claimed;
}

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
    enabled: enabled && !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 15_000,
    queryFn: async (): Promise<ClearableRecordedPaymentsResult> => {
      const orgId = currentOrg!.id;
      const businessId = currentBusiness!.id;
      const claimed = await spokenFor(businessId);

      if (isCredit) {
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
      }

      const { data, error } = await supabase
        .from("bill_payments")
        .select("id, amount, payment_date, reference, payment_method, vendor_id, status")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .order("payment_date", { ascending: false })
        .limit(500);
      if (error) throw error;

      const live = ((data ?? []) as Array<Record<string, unknown>>).filter(
        (r) =>
          !["voided", "cancelled"].includes(String(r.status ?? "")) && !claimed.has(String(r.id)),
      );
      const names = await namesFor(live.map((r) => String(r.vendor_id ?? "")));

      return {
        holdingAccountIds: [],
        candidates: live
          .filter((r) => Math.abs(Number(r.amount) - amount) < EPSILON)
          .map((r) => ({
            kind: "bill_payment" as const,
            id: String(r.id),
            amount: Number(r.amount),
            date: String(r.payment_date),
            reference: (r.reference as string) ?? null,
            method: (r.payment_method as string) ?? null,
            partyName: names.get(String(r.vendor_id ?? "")) ?? null,
            holdingAccountId: null,
          })),
      };
    },
    initialData: EMPTY,
  });
}
