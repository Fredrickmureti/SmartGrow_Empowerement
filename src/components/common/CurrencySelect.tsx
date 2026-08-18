import { useCurrency } from "@/hooks/useCurrency";
import { CurrencyCombobox } from "@/components/contacts/CurrencyCombobox";

interface CurrencySelectProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Canonical currency picker for form surfaces.
 *
 * Thin wrapper over the searchable `CurrencyCombobox` so every consumer gets
 * type-ahead search over `public.currencies` instead of a long scroll list.
 */
export function CurrencySelect({ value, onChange, disabled, className }: CurrencySelectProps) {
  const { currencies, baseCurrency, isLoading } = useCurrency();

  // Default to the business base currency. No currency literal: if the base
  // currency is unknown the picker stays empty and shows its placeholder
  // rather than inventing a currency for the operator (ADR 0135/0136).
  const selectedValue = value || baseCurrency || "";

  return (
    <div className={className}>
      <CurrencyCombobox
        currencies={currencies}
        value={selectedValue}
        onValueChange={onChange}
        disabled={disabled || isLoading}
        placeholder={isLoading ? "Loading..." : "Search currency..."}
      />
    </div>
  );
}
