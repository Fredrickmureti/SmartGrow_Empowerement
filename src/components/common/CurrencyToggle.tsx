import { useMemo } from "react";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useViewCurrencyPreference } from "@/hooks/useViewCurrencyPreference";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Coins, AlertTriangle, Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface CurrencyToggleProps {
  value?: string;
  onChange?: (currency: string) => void;
  label?: string;
}

/**
 * Currency toggle component that persists user's preference to the database.
 * Falls back to organization's base_currency if no preference is set.
 */
export function CurrencyToggle({ 
  value, 
  onChange, 
  label = "View in"
}: CurrencyToggleProps) {
  const { currencies, baseCurrency, isLoading: currenciesLoading } = useCurrency();
  const { getExchangeRate } = useCurrencyContext();
  const { viewCurrency, setViewCurrency, isLoading: preferenceLoading, isSaving } = useViewCurrencyPreference();

  // Use controlled value if provided, otherwise use the DB-backed preference
  const effectiveValue = value !== undefined ? value : viewCurrency;

  // Check if exchange rate exists for the selected currency pair
  const hasExchangeRate = useMemo(() => {
    if (!effectiveValue || !baseCurrency || effectiveValue === baseCurrency) return true;
    // `null` is the honest "no rate on file" answer from the rate book.
    return getExchangeRate(baseCurrency, effectiveValue) !== null;
  }, [effectiveValue, baseCurrency, getExchangeRate]);

  const handleChange = (newValue: string) => {
    // If external onChange is provided, use it (controlled mode)
    if (onChange) {
      onChange(newValue);
    }
    // Always persist to database
    setViewCurrency(newValue);
  };

  if (currenciesLoading || currencies.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
      <Coins className="h-4 w-4 text-muted-foreground hidden sm:block" />
      <span className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">{label}:</span>
      <Select value={effectiveValue || baseCurrency} onValueChange={handleChange}>
        <SelectTrigger className="w-16 sm:w-24 h-7 sm:h-8 text-xs sm:text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {currencies.map((currency) => (
            <SelectItem key={currency.id} value={currency.code}>
              {currency.code}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(preferenceLoading || isSaving) && (
        <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin text-muted-foreground flex-shrink-0" />
      )}
      {!hasExchangeRate && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangle className="h-3 w-3 sm:h-4 sm:w-4 text-amber-500 flex-shrink-0" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs text-sm">
                No exchange rate found for {baseCurrency} → {effectiveValue}. 
                Values shown without conversion. 
                Add rates in Settings → Currency.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
