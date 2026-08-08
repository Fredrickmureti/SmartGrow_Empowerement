/**
 * Phase 3b: Aging Breakdown Widget
 * Shows 30/60/90/120+ aging buckets for a contact.
 */
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Clock, Loader2 } from "lucide-react";
import { fetchContactOpenItemAging } from "@/services/finance/openItems";

interface Props {
  contactId: string;
  contactType: string;
}

interface AgingBuckets {
  current: number;
  days30: number;
  days60: number;
  days90: number;
  days120: number;
  total: number;
}

export function ContactAgingBreakdown({ contactId, contactType }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();

  const isCustomer = contactType === "customer" || contactType === "both";
  const isSupplier = contactType === "supplier" || contactType === "both";

  const { data: aging, isLoading } = useQuery({
    queryKey: ["contact-aging", contactId, currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<{ ar: AgingBuckets | null; ap: AgingBuckets | null }> => {
      if (!currentOrg?.id) return { ar: null, ap: null };

      // GL-gated projection — residual already nets cash receipts and applied
      // credit notes, so no status list is involved.
      const [ar, ap] = await Promise.all([
        isCustomer
          ? fetchContactOpenItemAging("ar", {
              orgId: currentOrg.id,
              contactId,
              businessId: currentBusiness?.id ?? null,
            })
          : Promise.resolve(null),
        isSupplier
          ? fetchContactOpenItemAging("ap", {
              orgId: currentOrg.id,
              contactId,
              businessId: currentBusiness?.id ?? null,
            })
          : Promise.resolve(null),
      ]);

      return { ar, ap };
    },
    enabled: !!contactId && !!currentOrg?.id,
    staleTime: 30000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const hasData = (aging?.ar && aging.ar.total > 0) || (aging?.ap && aging.ap.total > 0);
  if (!hasData) return null;

  const renderBuckets = (buckets: AgingBuckets, label: string) => {
    if (buckets.total <= 0) return null;
    const items = [
      { label: "Current", amount: buckets.current, color: "bg-emerald-500" },
      { label: "1-30", amount: buckets.days30, color: "bg-yellow-500" },
      { label: "31-60", amount: buckets.days60, color: "bg-orange-500" },
      { label: "61-90", amount: buckets.days90, color: "bg-red-500" },
      { label: "90+", amount: buckets.days120, color: "bg-red-700" },
    ];

    return (
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {/* Stacked bar */}
        <div className="flex h-3 rounded-full overflow-hidden bg-muted">
          {items.map(item => item.amount > 0 && (
            <div
              key={item.label}
              className={`${item.color} transition-all`}
              style={{ width: `${(item.amount / buckets.total) * 100}%` }}
              title={`${item.label}: ${formatCurrency(item.amount)}`}
            />
          ))}
        </div>
        <div className="grid grid-cols-5 gap-1 text-center">
          {items.map(item => (
            <div key={item.label}>
              <p className="text-[10px] text-muted-foreground">{item.label}</p>
              <p className="text-xs font-medium">{formatCurrency(item.amount)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Clock className="h-4 w-4" /> Aging Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {aging?.ar && aging.ar.total > 0 && renderBuckets(aging.ar, "Accounts Receivable")}
        {aging?.ap && aging.ap.total > 0 && renderBuckets(aging.ap, "Accounts Payable")}
      </CardContent>
    </Card>
  );
}
