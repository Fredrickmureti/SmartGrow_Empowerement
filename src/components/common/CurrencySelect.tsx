import { useCurrency } from "@/hooks/useCurrency";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface CurrencySelectProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function CurrencySelect({ value, onChange, disabled, className }: CurrencySelectProps) {
  const { currencies, baseCurrency, isLoading } = useCurrency();

  // Default to base currency if no value
  const selectedValue = value || baseCurrency || "USD"; // architecture-allow: display-only fallback

  if (isLoading) {
    return (
      <Select disabled value={selectedValue}>
        <SelectTrigger className={className}>
          <SelectValue placeholder="Loading..." />
        </SelectTrigger>
      </Select>
    );
  }

  return (
    <Select value={selectedValue} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {currencies.map((currency) => (
          <SelectItem key={currency.id} value={currency.code}>
            {currency.code} - {currency.symbol}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
