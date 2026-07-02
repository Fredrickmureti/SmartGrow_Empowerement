import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, CreditCard, Smartphone, Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export type PaymentProvider = "stripe" | "paypal" | "pesapal" | "mpesa";

interface PaymentMethodSelectorProps {
  enabledProviders: PaymentProvider[];
  selectedProvider: PaymentProvider | null;
  onSelectProvider: (provider: PaymentProvider) => void;
  phoneNumber?: string;
  onPhoneNumberChange?: (phone: string) => void;
  isProcessing?: boolean;
  onProceed: () => void;
  amount: string;
  currency: string;
}

const providerConfig: Record<PaymentProvider, {
  name: string;
  description: string;
  icon: React.ReactNode;
  requiresPhone: boolean;
  color: string;
}> = {
  stripe: {
    name: "Card Payment",
    description: "Pay with Visa, Mastercard, or other cards",
    icon: <CreditCard className="h-6 w-6" />,
    requiresPhone: false,
    color: "bg-[#635BFF]/10 border-[#635BFF]/30",
  },
  paypal: {
    name: "PayPal",
    description: "Pay with your PayPal account",
    icon: <Globe className="h-6 w-6" />,
    requiresPhone: false,
    color: "bg-[#003087]/10 border-[#003087]/30",
  },
  pesapal: {
    name: "PesaPal",
    description: "Multiple payment options across Africa",
    icon: <Globe className="h-6 w-6" />,
    requiresPhone: false,
    color: "bg-[#00A650]/10 border-[#00A650]/30",
  },
  mpesa: {
    name: "M-Pesa",
    description: "Pay via M-Pesa mobile money",
    icon: <Smartphone className="h-6 w-6" />,
    requiresPhone: true,
    color: "bg-[#4CAF50]/10 border-[#4CAF50]/30",
  },
};

export function PaymentMethodSelector({
  enabledProviders,
  selectedProvider,
  onSelectProvider,
  phoneNumber = "",
  onPhoneNumberChange,
  isProcessing = false,
  onProceed,
  amount,
  currency,
}: PaymentMethodSelectorProps) {
  const selectedConfig = selectedProvider ? providerConfig[selectedProvider] : null;

  if (enabledProviders.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">
            No payment methods are currently available. Please contact support.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Payment Method Selection */}
      <div className="space-y-3">
        <Label className="text-base font-medium">Select Payment Method</Label>
        <div className="grid grid-cols-2 gap-3">
          {enabledProviders.map((provider) => {
            const config = providerConfig[provider];
            const isSelected = selectedProvider === provider;

            return (
              <Card
                key={provider}
                className={cn(
                  "cursor-pointer transition-all border-2",
                  isSelected 
                    ? "border-primary ring-2 ring-primary/20" 
                    : "border-border hover:border-primary/50",
                  config.color
                )}
                onClick={() => onSelectProvider(provider)}
              >
                <CardContent className="p-4 flex flex-col items-center text-center gap-2">
                  <div className={cn(
                    "p-2 rounded-full",
                    isSelected ? "text-primary" : "text-muted-foreground"
                  )}>
                    {config.icon}
                  </div>
                  <div>
                    <p className="font-medium text-sm">{config.name}</p>
                    <p className="text-xs text-muted-foreground">{config.description}</p>
                  </div>
                  {isSelected && (
                    <Badge variant="default" className="mt-1">Selected</Badge>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Phone Number Input for M-Pesa */}
      {selectedProvider === "mpesa" && (
        <div className="space-y-2">
          <Label htmlFor="phone">M-Pesa Phone Number</Label>
          <Input
            id="phone"
            type="tel"
            placeholder="e.g., 0712345678 or 254712345678"
            value={phoneNumber}
            onChange={(e) => onPhoneNumberChange?.(e.target.value)}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Enter the phone number registered with M-Pesa
          </p>
        </div>
      )}

      {/* Amount Summary */}
      <div className="rounded-lg bg-muted/50 p-4">
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Total Amount</span>
          <span className="text-xl font-bold">{currency} {amount}</span>
        </div>
      </div>

      {/* Proceed Button */}
      <Button
        className="w-full"
        size="lg"
        onClick={onProceed}
        disabled={
          !selectedProvider || 
          isProcessing || 
          (selectedProvider === "mpesa" && !phoneNumber.trim())
        }
      >
        {isProcessing ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Processing...
          </>
        ) : selectedProvider === "mpesa" ? (
          "Send M-Pesa Prompt"
        ) : selectedProvider === "stripe" ? (
          "Proceed to Card Payment"
        ) : selectedProvider === "paypal" ? (
          "Pay with PayPal"
        ) : selectedProvider === "pesapal" ? (
          "Pay with PesaPal"
        ) : (
          "Select a Payment Method"
        )}
      </Button>

      {/* Security Note */}
      <p className="text-xs text-center text-muted-foreground">
        🔒 Your payment is secured with industry-standard encryption
      </p>
    </div>
  );
}
