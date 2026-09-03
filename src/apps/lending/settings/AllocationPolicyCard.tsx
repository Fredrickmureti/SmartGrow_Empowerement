/**
 * Lending → Configuration → Payment allocation policy.
 *
 * The order in which a receipt clears the components of an installment is
 * configuration, never hardcoded in React. `mf_record_repayment` reads this
 * row; the UI only edits it.
 */

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const COMPONENT_LABEL: Record<string, string> = {
  penalty: "Penalties",
  fee: "Fees",
  interest: "Interest",
  principal: "Principal",
};

const DEFAULT_ORDER = ["penalty", "fee", "interest", "principal"];

interface PolicyRow {
  id: string;
  business_id: string;
  allocation_order: string[];
  allow_overpayment: boolean;
}

export function AllocationPolicyCard() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["mf-allocation-policy", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mf_allocation_policy")
        .select("id, business_id, allocation_order, allow_overpayment")
        .eq("business_id", businessId!)
        .maybeSingle();
      if (error) throw error;
      return (data as PolicyRow | null) ?? null;
    },
  });

  const order = useMemo(() => {
    const current = data?.allocation_order?.length ? data.allocation_order : DEFAULT_ORDER;
    return current.filter((c) => c in COMPONENT_LABEL);
  }, [data]);

  const save = useMutation({
    mutationFn: async (next: string[]) => {
      if (!businessId) throw new Error("No institution selected.");
      const payload = { business_id: businessId, allocation_order: next };
      const { error } = data?.id
        ? await supabase.from("mf_allocation_policy").update(payload).eq("id", data.id)
        : await supabase.from("mf_allocation_policy").insert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mf-allocation-policy", businessId] });
      toast.success("Allocation order saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const move = (index: number, delta: number) => {
    const next = [...order];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    save.mutate(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment allocation policy</CardTitle>
        <CardDescription>
          The order a receipt clears each installment: the topmost component is
          settled first. Payments are always applied to the oldest unpaid
          installment before moving on. Any surplus is held as client credit and
          applied automatically to the client's next installments.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          order.map((component, index) => (
            <div
              key={component}
              className="flex items-center justify-between rounded-md border px-3 py-2"
            >
              <span className="text-sm">
                <span className="mr-2 text-muted-foreground">{index + 1}.</span>
                {COMPONENT_LABEL[component]}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${COMPONENT_LABEL[component]} up`}
                  disabled={index === 0 || save.isPending}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${COMPONENT_LABEL[component]} down`}
                  disabled={index === order.length - 1 || save.isPending}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default AllocationPolicyCard;
