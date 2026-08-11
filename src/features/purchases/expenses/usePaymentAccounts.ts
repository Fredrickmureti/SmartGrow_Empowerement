/**
 * Shared payment-account fetcher for Expense create / edit routes.
 *
 * Extracted from the retired `src/pages/Expenses.tsx` inline dialog so
 * the two `RecordFormShell` routes and the (future) `/purchases/expenses/:id`
 * page share one payment-account resolution rule.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import type { PaymentAccountOption } from "./ExpenseFormFields";

const PAYMENT_ACCOUNT_KEYWORDS = [
  "cash",
  "bank",
  "petty",
  "mobile",
  "m-pesa",
  "mpesa",
  "credit card",
  "card",
  "payable",
  "wallet",
  "reimbursement",
];

export function usePaymentAccounts(): PaymentAccountOption[] {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [accounts, setAccounts] = useState<PaymentAccountOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentOrg) return;
      // Header (group) accounts are non-postable — `prevent_journal_post_to_header`
      // rejects any journal line against them, so they must never be offered as a
      // payment account.
      let query = supabase
        .from("accounts")
        .select("id, name, code, account_type")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .eq("is_header", false)
        .in("account_type", ["asset", "liability"])
        .order("code");
      if (currentBusiness?.id) {
        query = query.or(
          `business_id.eq.${currentBusiness.id},business_id.is.null`,
        );
      }
      const { data } = await query;
      if (cancelled || !data) return;
      const filtered = (data as PaymentAccountOption[]).filter((a) => {
        const n = a.name.toLowerCase();
        return PAYMENT_ACCOUNT_KEYWORDS.some((k) => n.includes(k));
      });
      setAccounts(filtered.length > 0 ? filtered : (data as PaymentAccountOption[]));
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, currentBusiness?.id]);

  return accounts;
}
