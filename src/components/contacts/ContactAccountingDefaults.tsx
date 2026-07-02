/**
 * Phase 3a: Accounting Defaults Summary Card
 * Displays payment terms, default accounts, tax settings for a contact.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Settings, Loader2 } from "lucide-react";

interface Props {
  contact: {
    id: string;
    type: string;
    payment_term_id?: string | null;
    default_receivable_account_id?: string | null;
    default_payable_account_id?: string | null;
    default_expense_account_id?: string | null;
    default_tax_rate_id?: string | null;
    withholding_tax_rate?: number | null;
    tax_exemption_number?: string | null;
    price_list_id?: string | null;
    default_currency?: string | null;
    default_payment_method_id?: string | null;
    customer_group_id?: string | null;
    opening_balance?: number | null;
  };
}

export function ContactAccountingDefaults({ contact }: Props) {
  // Resolve IDs to human-readable names
  const { data: resolved, isLoading } = useQuery({
    queryKey: ["contact-accounting-defaults", contact.id],
    queryFn: async () => {
      const results: Record<string, string | null> = {};

      if (contact.payment_term_id) {
        const { data } = await supabase.from("payment_terms").select("name, days").eq("id", contact.payment_term_id).maybeSingle();
        results.paymentTerm = data ? `${data.name} (${data.days} days)` : null;
      }

      const accountIds = [
        contact.default_receivable_account_id,
        contact.default_payable_account_id,
        contact.default_expense_account_id,
      ].filter(Boolean) as string[];

      if (accountIds.length > 0) {
        const { data } = await supabase.from("accounts").select("id, code, name").in("id", accountIds);
        const map = new Map((data || []).map((a: any) => [a.id as string, `${a.code} - ${a.name}` as string]));
        results.receivableAccount = (map.get(contact.default_receivable_account_id!) as string) || null;
        results.payableAccount = (map.get(contact.default_payable_account_id!) as string) || null;
        results.expenseAccount = (map.get(contact.default_expense_account_id!) as string) || null;
      }

      if (contact.default_tax_rate_id) {
        const { data } = await supabase.from("tax_rates").select("name, rate").eq("id", contact.default_tax_rate_id).maybeSingle();
        results.taxRate = data ? `${data.name} (${data.rate}%)` : null;
      }

      if (contact.price_list_id) {
        const { data } = await supabase.from("price_lists").select("name").eq("id", contact.price_list_id).maybeSingle();
        results.priceList = data?.name || null;
      }

      if (contact.default_payment_method_id) {
        const { data } = await supabase.from("organization_payment_methods").select("type").eq("id", contact.default_payment_method_id).maybeSingle();
        results.paymentMethod = data?.type || null;
      }

      if (contact.customer_group_id) {
        const { data } = await supabase.from("customer_groups").select("name").eq("id", contact.customer_group_id).maybeSingle();
        results.customerGroup = data?.name || null;
      }
      return results;
    },
    enabled: !!contact.id,
    staleTime: 60000,
  });

  const isCustomer = contact.type === "customer" || contact.type === "both";
  const isSupplier = contact.type === "supplier" || contact.type === "both";

  const entries: { label: string; value: string | null | undefined; show: boolean }[] = [
    { label: "Payment Terms", value: resolved?.paymentTerm, show: !!contact.payment_term_id },
    { label: "Default Currency", value: contact.default_currency, show: !!contact.default_currency },
    { label: "Payment Method", value: resolved?.paymentMethod, show: !!contact.default_payment_method_id },
    { label: "Price List", value: resolved?.priceList, show: isCustomer && !!contact.price_list_id },
    { label: "Customer Group", value: resolved?.customerGroup, show: isCustomer && !!contact.customer_group_id },
    { label: "AR Account", value: resolved?.receivableAccount, show: isCustomer && !!contact.default_receivable_account_id },
    { label: "AP Account", value: resolved?.payableAccount, show: isSupplier && !!contact.default_payable_account_id },
    { label: "Expense Account", value: resolved?.expenseAccount, show: isSupplier && !!contact.default_expense_account_id },
    { label: "Tax Rate", value: resolved?.taxRate, show: !!contact.default_tax_rate_id },
    { label: "WHT Rate", value: contact.withholding_tax_rate ? `${contact.withholding_tax_rate}%` : null, show: isSupplier && !!contact.withholding_tax_rate },
    { label: "Tax Exemption", value: contact.tax_exemption_number, show: !!contact.tax_exemption_number },
    { label: "Opening Balance", value: contact.opening_balance ? contact.opening_balance.toString() : null, show: !!contact.opening_balance },
  ];

  const visibleEntries = entries.filter(e => e.show);

  if (visibleEntries.length === 0 && !isLoading) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Settings className="h-4 w-4" /> Accounting Defaults
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : visibleEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounting defaults configured</p>
        ) : (
          <div className="grid gap-2 grid-cols-2">
            {visibleEntries.map(entry => (
              <div key={entry.label}>
                <p className="text-xs text-muted-foreground">{entry.label}</p>
                <p className="text-sm font-medium truncate">{entry.value || "—"}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
