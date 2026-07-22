import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Percent, DollarSign, Tag, Check } from "lucide-react";
import { usePOSDiscounts, POSDiscount } from "@/hooks/pos/usePOSDiscounts";
// Stage 8.6: PIN/% gate now lives in pos_override_matrix (action='discount_over_limit').
import { useManagerOverride } from "@/hooks/pos/useManagerOverride";
import { ManagerOverrideDialog } from "./ManagerOverrideDialog";
import { useCurrency } from "@/hooks/useCurrency";

import { cn } from "@/lib/utils";

interface ActiveSession {
  cashier?: {
    id?: string;
    display_name?: string;
    employee_number?: string | null;
    user_id?: string | null;
    max_discount_percent?: number | null;
    max_void_amount?: number | null;
    can_apply_discounts?: boolean | null;
    can_void_transactions?: boolean | null;
    can_process_returns?: boolean | null;
    can_open_cash_drawer?: boolean | null;
  } | null;
  session_type?: string | null;
}

interface DiscountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subtotal: number;
  registerId?: string;
  onApply: (type: "percent" | "fixed", value: number, name?: string) => void;
  activeSession?: ActiveSession | null;
}

export function DiscountDialog({
  open,
  onOpenChange,
  subtotal,
  registerId,
  onApply,
  activeSession,
}: DiscountDialogProps) {
  const { discounts, getApplicableDiscounts, calculateDiscount } = usePOSDiscounts();
  const { formatCurrency, getCurrencySymbol } = useCurrency();
  const { currentOrg } = useOrganization();
  // Stage 8.6: server-side gate via assert_manager_override / pos_override_matrix.
  const { requestOverride, isVerifying } = useManagerOverride(currentOrg?.id);
  
  const [activeTab, setActiveTab] = useState("presets");
  const [discountType, setDiscountType] = useState<"percent" | "fixed">("percent");
  const [value, setValue] = useState("");
  const [showManagerOverride, setShowManagerOverride] = useState(false);
  const [pendingDiscount, setPendingDiscount] = useState<{
    type: "percent" | "fixed";
    value: number;
    name?: string;
  } | null>(null);

  const applicableDiscounts = getApplicableDiscounts(subtotal);

  // Stage 8.6: % threshold + PIN-required flag moved to pos_override_matrix.
  // Client now only knows about: (a) explicit discount.requires_approval flag,
  // (b) per-cashier max_discount_percent. The matrix-driven gate fires when the
  // server-side discount-application path raises override_required.
  const needsApproval = (discountPercent: number) => {
    if (activeSession?.session_type === 'manager') return false;
    const cashierMaxDiscount = activeSession?.cashier?.max_discount_percent;
    if (cashierMaxDiscount != null && cashierMaxDiscount > 0 && discountPercent > cashierMaxDiscount) {
      return true;
    }
    return false;
  };

  const handlePresetDiscount = (discount: POSDiscount) => {
    const discountPercent = discount.discount_type === "percentage" 
      ? discount.value 
      : (discount.value / subtotal) * 100;
    
    if (discount.requires_approval || needsApproval(discountPercent)) {
      setPendingDiscount({
        type: discount.discount_type === "percentage" ? "percent" : "fixed",
        value: discount.value,
        name: discount.name,
      });
      setShowManagerOverride(true);
    } else {
      onApply(
        discount.discount_type === "percentage" ? "percent" : "fixed",
        discount.value,
        discount.name
      );
      onOpenChange(false);
    }
  };

  const handleCustomDiscount = () => {
    if (!value || parseFloat(value) <= 0) return;
    
    const numValue = parseFloat(value);
    
    // Validate percentage doesn't exceed 100%
    if (discountType === "percent" && numValue > 100) {
      return;
    }
    
    // Validate fixed discount doesn't exceed subtotal
    if (discountType === "fixed" && numValue > subtotal) {
      return;
    }

    const discountPercent = discountType === "percent" 
      ? numValue 
      : (numValue / subtotal) * 100;

    if (needsApproval(discountPercent)) {
      setPendingDiscount({ type: discountType, value: numValue });
      setShowManagerOverride(true);
    } else {
      onApply(discountType, numValue);
      onOpenChange(false);
      setValue("");
    }
  };

  const handleOverrideApprove = async (pin: string, reason?: string) => {
    if (!pendingDiscount || !registerId) return;
    
    const discountAmount = pendingDiscount.type === "percent"
      ? (subtotal * pendingDiscount.value) / 100
      : pendingDiscount.value;
    
    await requestOverride({
      action: 'discount_over_limit',
      pin,
      registerId: registerId!,
      originalValue: subtotal,
      newValue: subtotal - discountAmount,
      reason,
    } as any);
    
    onApply(pendingDiscount.type, pendingDiscount.value, pendingDiscount.name);
    setPendingDiscount(null);
    setShowManagerOverride(false);
    onOpenChange(false);
    setValue("");
  };

  const quickPercentages = [5, 10, 15, 20, 25];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Tag className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" />
            Apply Discount
          </DialogTitle>
        </DialogHeader>

        {/* Subtotal Display */}
        <div className="text-center py-2 bg-muted/50 rounded-lg">
          <p className="text-xs sm:text-sm text-muted-foreground">Cart Subtotal</p>
          <p className="text-xl sm:text-2xl font-bold">{formatCurrency(subtotal)}</p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="presets" className="text-xs sm:text-sm">Presets</TabsTrigger>
            <TabsTrigger value="custom" className="text-xs sm:text-sm">Custom</TabsTrigger>
          </TabsList>

          <TabsContent value="presets" className="flex-1 min-h-0">
            <ScrollArea className="h-[200px] sm:h-[250px]">
              {applicableDiscounts.length === 0 ? (
                <div className="text-center py-6 sm:py-8 text-muted-foreground">
                  <Tag className="h-8 w-8 sm:h-10 sm:w-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No applicable discounts</p>
                  <p className="text-xs sm:text-sm mt-1">
                    Create discounts in POS Settings
                  </p>
                </div>
              ) : (
                <div className="space-y-2 pr-2">
                  {applicableDiscounts.map((discount) => {
                    const discountAmount = calculateDiscount(discount, subtotal);
                    return (
                      <Button
                        key={discount.id}
                        variant="outline"
                        className="w-full h-auto py-2.5 sm:py-3 justify-between px-2 sm:px-4"
                        onClick={() => handlePresetDiscount(discount)}
                      >
                        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                          <div
                            className={cn(
                              "h-8 w-8 sm:h-10 sm:w-10 rounded-lg flex items-center justify-center shrink-0",
                              discount.discount_type === "percentage"
                                ? "bg-blue-500/10 text-blue-500"
                                : "bg-green-500/10 text-green-500"
                            )}
                          >
                            {discount.discount_type === "percentage" ? (
                              <Percent className="h-4 w-4 sm:h-5 sm:w-5" />
                            ) : (
                              <DollarSign className="h-4 w-4 sm:h-5 sm:w-5" />
                            )}
                          </div>
                          <div className="text-left min-w-0">
                            <p className="font-medium text-xs sm:text-sm truncate">{discount.name}</p>
                            <p className="text-[10px] sm:text-sm text-muted-foreground">
                              {discount.discount_type === "percentage"
                                ? `${discount.value}% off`
                                : `${formatCurrency(discount.value)} off`}
                            </p>
                          </div>
                        </div>
                        <div className="text-right shrink-0 ml-2">
                          <p className="text-green-600 font-semibold text-xs sm:text-sm">
                            -{formatCurrency(discountAmount)}
                          </p>
                          {discount.requires_approval && (
                            <Badge variant="outline" className="text-[10px] sm:text-xs">
                              Approval
                            </Badge>
                          )}
                        </div>
                      </Button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="custom" className="space-y-3 sm:space-y-4">
            {/* Quick Percentage Buttons */}
            <div className="space-y-1.5 sm:space-y-2">
              <Label className="text-xs sm:text-sm text-muted-foreground">Quick Discount</Label>
              <div className="flex gap-1.5 sm:gap-2 flex-wrap">
                {quickPercentages.map((pct) => (
                  <Button
                    key={pct}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDiscountType("percent");
                      setValue(pct.toString());
                    }}
                    className={cn(
                      "h-9 sm:h-8 px-3 sm:px-4 text-xs sm:text-sm",
                      discountType === "percent" && value === pct.toString() && "border-primary"
                    )}
                  >
                    {pct}%
                  </Button>
                ))}
              </div>
            </div>

            {/* Discount Type Toggle */}
            <div className="space-y-1.5 sm:space-y-2">
              <Label className="text-xs sm:text-sm">Discount Type</Label>
              <div className="flex gap-2">
                <Button
                  variant={discountType === "percent" ? "default" : "outline"}
                  className="flex-1 h-10 sm:h-9 text-xs sm:text-sm"
                  onClick={() => setDiscountType("percent")}
                >
                  <Percent className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                  <span className="hidden sm:inline">Percentage</span>
                  <span className="sm:hidden">%</span>
                </Button>
                <Button
                  variant={discountType === "fixed" ? "default" : "outline"}
                  className="flex-1 h-10 sm:h-9 text-xs sm:text-sm"
                  onClick={() => setDiscountType("fixed")}
                >
                  {getCurrencySymbol()}
                  <span className="ml-1 sm:ml-2 hidden sm:inline">Fixed Amount</span>
                  <span className="ml-1 sm:hidden">Fixed</span>
                </Button>
              </div>
            </div>

            {/* Value Input */}
            <div className="space-y-1.5 sm:space-y-2">
              <Label className="text-xs sm:text-sm">
                {discountType === "percent" ? "Percentage" : "Amount"}
              </Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                  {discountType === "percent" ? "%" : getCurrencySymbol()}
                </span>
                <Input
                  type="number"
                  step={discountType === "percent" ? "1" : "0.01"}
                  min="0"
                  max={discountType === "percent" ? "100" : subtotal}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="0"
                  className="pl-8 text-base sm:text-lg h-11 sm:h-10"
                />
              </div>
            </div>

            {/* Preview */}
            {value && parseFloat(value) > 0 && (
              <div className="p-2.5 sm:p-3 bg-green-500/10 rounded-lg">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground text-xs sm:text-sm">Discount:</span>
                  <span className="text-sm sm:text-lg font-semibold text-green-600">
                    -{discountType === "percent"
                      ? formatCurrency((subtotal * parseFloat(value)) / 100)
                      : formatCurrency(parseFloat(value))}
                  </span>
                </div>
                <div className="flex justify-between items-center mt-1">
                  <span className="text-muted-foreground text-xs sm:text-sm">New Total:</span>
                  <span className="text-sm sm:text-lg font-semibold">
                    {discountType === "percent"
                      ? formatCurrency(subtotal - (subtotal * parseFloat(value)) / 100)
                      : formatCurrency(subtotal - parseFloat(value))}
                  </span>
                </div>
              </div>
            )}

            <Button
              className="w-full h-10 sm:h-9"
              onClick={handleCustomDiscount}
              disabled={!value || parseFloat(value) <= 0}
            >
              <Check className="h-4 w-4 mr-2" />
              Apply Discount
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
      
      {/* Manager Override Dialog */}
      <ManagerOverrideDialog
        open={showManagerOverride}
        onOpenChange={(open) => {
          setShowManagerOverride(open);
          if (!open) setPendingDiscount(null);
        }}
        action="discount_over_limit"
        originalValue={subtotal}
        newValue={pendingDiscount ? (
          pendingDiscount.type === "percent"
            ? subtotal - (subtotal * pendingDiscount.value) / 100
            : subtotal - pendingDiscount.value
        ) : undefined}
        onApprove={handleOverrideApprove}
        isVerifying={isVerifying}
      />
    </Dialog>
  );
}
