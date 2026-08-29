/**
 * PaymentMethodSelector — subscription checkout payment picker.
 *
 * Platform-owned (subscription billing), independent of the removed ERP/POS
 * domains. Purely presentational: the caller owns provider state and the
 * authoritative charge is created server-side.
 */
import { Loader2, Smartphone, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { PaymentProvider } from "@/hooks/usePaymentProviders";

export type { PaymentProvider };

const PROVIDER_LABELS: Record<PaymentProvider, string> = {
  mpesa: "M-Pesa (STK Push)",
  mpesa_c2b: "M-Pesa Paybill",
  stripe: "Card (Stripe)",
  flutterwave: "Flutterwave",
  paystack: "Paystack",
};

const MOBILE_MONEY: PaymentProvider[] = ["mpesa", "mpesa_c2b"];

interface PaymentMethodSelectorProps {
  enabledProviders: PaymentProvider[];
  selectedProvider: PaymentProvider | null;
  onSelectProvider: (provider: PaymentProvider) => void;
  phoneNumber: string;
  onPhoneNumberChange: (value: string) => void;
  isProcessing: boolean;
  onProceed: () => void;
  amount: string;
  currency: string;
}

export function PaymentMethodSelector({
  enabledProviders,
  selectedProvider,
  onSelectProvider,
  phoneNumber,
  onPhoneNumberChange,
  isProcessing,
  onProceed,
  amount,
  currency,
}: PaymentMethodSelectorProps) {
  const needsPhone = selectedProvider != null && MOBILE_MONEY.includes(selectedProvider);
  const canProceed =
    selectedProvider != null && (!needsPhone || phoneNumber.trim().length >= 9) && !isProcessing;

  if (enabledProviders.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No payment provider is enabled yet. Ask an administrator to configure one in Settings.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Payment method</Label>
        <div className="grid gap-2">
          {enabledProviders.map((provider) => {
            const isSelected = provider === selectedProvider;
            const Icon = MOBILE_MONEY.includes(provider) ? Smartphone : CreditCard;
            return (
              <button
                key={provider}
                type="button"
                onClick={() => onSelectProvider(provider)}
                className={cn(
                  "flex items-center gap-3 rounded-md border p-3 text-left text-sm transition-colors",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-input hover:bg-accent",
                )}
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{PROVIDER_LABELS[provider] ?? provider}</span>
              </button>
            );
          })}
        </div>
      </div>

      {needsPhone && (
        <div className="space-y-2">
          <Label htmlFor="checkout-phone">Mobile number</Label>
          <Input
            id="checkout-phone"
            inputMode="tel"
            placeholder="07XX XXX XXX"
            value={phoneNumber}
            onChange={(event) => onPhoneNumberChange(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            You will receive a payment prompt on this number.
          </p>
        </div>
      )}

      <Button className="w-full" disabled={!canProceed} onClick={onProceed}>
        {isProcessing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Pay {currency} {amount}
      </Button>
    </div>
  );
}
