import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { usePOSLoyalty } from "@/hooks/pos/usePOSLoyalty";
import { Gift, Star, TrendingUp } from "lucide-react";

interface LoyaltyRedemptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  transactionTotal: number;
  onRedeem: (discount: number, pointsUsed: number) => void;
}

export function LoyaltyRedemptionDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  transactionTotal,
  onRedeem,
}: LoyaltyRedemptionDialogProps) {
  const {
    program,
    fetchCustomerLoyalty,
    calculatePointsValue,
    getTierDiscount,
    isRedeeming,
  } = usePOSLoyalty();

  const [loyalty, setLoyalty] = useState<{
    points_balance: number;
    current_tier: string;
    points_earned_total: number;
    visit_count: number;
  } | null>(null);
  const [pointsToRedeem, setPointsToRedeem] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && customerId) {
      setLoading(true);
      fetchCustomerLoyalty(customerId)
        .then((data) => {
          setLoyalty(data);
          setPointsToRedeem(0);
        })
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [open, customerId, fetchCustomerLoyalty]);

  if (!program) return null;

  const maxPoints = loyalty?.points_balance || 0;
  const maxRedeemable = Math.min(
    maxPoints,
    Math.floor(transactionTotal / program.points_to_currency_ratio)
  );
  const minPoints = program.minimum_points_redemption;
  const canRedeem = maxPoints >= minPoints;

  const discountValue = calculatePointsValue(pointsToRedeem);
  const tierDiscount = loyalty ? getTierDiscount(loyalty.current_tier) : 0;
  const tierDiscountAmount = (transactionTotal * tierDiscount) / 100;

  const handleRedeem = () => {
    if (pointsToRedeem > 0) {
      onRedeem(discountValue, pointsToRedeem);
    }
    onOpenChange(false);
  };

  const handleApplyTierOnly = () => {
    if (tierDiscount > 0) {
      onRedeem(tierDiscountAmount, 0);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-primary" />
            Loyalty Rewards
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-muted-foreground">
            Loading customer loyalty...
          </div>
        ) : !loyalty ? (
          <div className="py-8 text-center">
            <p className="text-muted-foreground mb-4">
              {customerName} is not enrolled in the loyalty program.
            </p>
            <p className="text-sm text-muted-foreground">
              Points will be automatically earned after this purchase.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Customer Status */}
            <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
              <div>
                <p className="font-medium">{customerName}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outline" className="flex items-center gap-1">
                    <Star className="h-3 w-3" />
                    {loyalty.current_tier}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {loyalty.visit_count} visits
                  </span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-primary">
                  {loyalty.points_balance.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">Available Points</p>
              </div>
            </div>

            {/* Tier Discount */}
            {tierDiscount > 0 && (
              <div className="p-3 bg-primary/10 rounded-lg border border-primary/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    <span className="font-medium">
                      {loyalty.current_tier} Member Discount
                    </span>
                  </div>
                  <span className="font-bold text-primary">
                    {tierDiscount}% off ({tierDiscountAmount.toFixed(2)})
                  </span>
                </div>
              </div>
            )}

            {/* Points Redemption */}
            {canRedeem ? (
              <div className="space-y-4">
                <div>
                  <Label>Redeem Points</Label>
                  <p className="text-sm text-muted-foreground mb-3">
                    Min: {minPoints} points | Max: {maxRedeemable.toLocaleString()} points
                  </p>
                  <Slider
                    value={[pointsToRedeem]}
                    onValueChange={([value]) => setPointsToRedeem(value)}
                    max={maxRedeemable}
                    min={0}
                    step={program.minimum_points_redemption}
                    className="mb-2"
                  />
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      value={pointsToRedeem}
                      onChange={(e) =>
                        setPointsToRedeem(
                          Math.min(maxRedeemable, Math.max(0, parseInt(e.target.value) || 0))
                        )
                      }
                      className="w-32"
                    />
                    <span className="text-muted-foreground">=</span>
                    <span className="font-bold text-lg text-primary">
                      {discountValue.toFixed(2)} discount
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                Minimum {minPoints} points required to redeem.
                Customer has {maxPoints} points.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {tierDiscount > 0 && pointsToRedeem === 0 && (
            <Button variant="secondary" onClick={handleApplyTierOnly}>
              Apply {tierDiscount}% Tier Discount
            </Button>
          )}
          {canRedeem && pointsToRedeem >= minPoints && (
            <Button onClick={handleRedeem} disabled={isRedeeming}>
              Redeem {pointsToRedeem} Points
            </Button>
          )}
          {!canRedeem && !tierDiscount && (
            <Button onClick={() => onOpenChange(false)}>Continue</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
