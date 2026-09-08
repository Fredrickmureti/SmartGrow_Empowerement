/**
 * Lending → Configuration → Client admission fee.
 *
 * One institution-level policy: is a one-time admission fee charged when a
 * client joins, and how much. Left off or blank, nothing changes anywhere in
 * the app. The amount is read server-side by `mf_raise_client_admission_fee`;
 * React never computes or posts it.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useMfClientFeePolicy } from "@/hooks/useMfClientCharges";

export function AdmissionFeeCard() {
  const { currentBusiness } = useBusinesses();
  const { policy, isLoading, save } = useMfClientFeePolicy();
  const [active, setActive] = useState(false);
  const [amount, setAmount] = useState("");

  useEffect(() => {
    setActive(policy?.admission_fee_active ?? false);
    setAmount(policy?.admission_fee_amount != null ? String(policy.admission_fee_amount) : "");
  }, [policy]);

  const currency = policy?.admission_fee_currency ?? currentBusiness?.base_currency ?? "KES";
  const dirty =
    active !== (policy?.admission_fee_active ?? false) ||
    (amount.trim() === "" ? null : Number(amount)) !== (policy?.admission_fee_amount ?? null);
  const invalid = active && (amount.trim() === "" || Number(amount) <= 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client admission fee</CardTitle>
        <CardDescription>
          A one-time fee raised on a client record when they join. It is institution
          income, posted to the mapped fee income account when paid. Switched off, no
          fee is ever raised.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <Label htmlFor="admission-fee-active" className="text-sm">
                Charge an admission fee
              </Label>
              <Switch id="admission-fee-active" checked={active} onCheckedChange={setActive} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="admission-fee-amount">Amount ({currency})</Label>
              <Input
                id="admission-fee-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                disabled={!active}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Not set"
              />
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!dirty || invalid || save.isPending}
                onClick={() =>
                  save.mutate({
                    admission_fee_active: active,
                    admission_fee_amount: amount.trim() === "" ? null : Number(amount),
                    admission_fee_currency: currency,
                  })
                }
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default AdmissionFeeCard;
