import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Check } from "lucide-react";
import { DisplayCurrency } from "@/hooks/usePricingCurrency";

interface PricingCurrencyToggleProps {
  displayCurrency: DisplayCurrency;
  onCurrencyChange: (currency: DisplayCurrency) => void;
}

const currencies: { value: DisplayCurrency; label: string; symbol: string }[] = [
  { value: "KES", label: "Kenyan Shilling", symbol: "KSh" },
  { value: "USD", label: "US Dollar", symbol: "$" },
];

export function PricingCurrencyToggle({
  displayCurrency,
  onCurrencyChange,
}: PricingCurrencyToggleProps) {
  const currentCurrency = currencies.find((c) => c.value === displayCurrency);

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">View prices in:</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <span className="font-medium">{currentCurrency?.symbol}</span>
            <span>{displayCurrency}</span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {currencies.map((currency) => (
            <DropdownMenuItem
              key={currency.value}
              onClick={() => onCurrencyChange(currency.value)}
              className="flex items-center justify-between gap-4"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium w-8">{currency.symbol}</span>
                <span>{currency.label}</span>
              </div>
              {displayCurrency === currency.value && (
                <Check className="h-4 w-4 text-primary" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
