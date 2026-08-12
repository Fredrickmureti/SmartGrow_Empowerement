import { useCurrency } from "@/hooks/useCurrency";
import { ArrowRightLeft } from "lucide-react";

interface CurrencyConverterProps {
  amount: number;
  fromCurrency: string;
  toCurrency?: string;
  showIcon?: boolean;
  className?: string;
}

export function CurrencyConverter({
  amount,
  fromCurrency,
  toCurrency,
  showIcon = true,
  className = "",
}: CurrencyConverterProps) {
  const { formatCurrency, convertCurrency, baseCurrency, getCurrencySymbol } = useCurrency();

  const targetCurrency = toCurrency || baseCurrency;

  // Don't show conversion if currencies are the same
  if (fromCurrency === targetCurrency) {
    return <span className={className}>{formatCurrency(amount, fromCurrency)}</span>;
  }

  const convertedAmount = convertCurrency(amount, fromCurrency, targetCurrency);

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span>{formatCurrency(amount, fromCurrency)}</span>
      {showIcon && <ArrowRightLeft className="h-3 w-3 text-muted-foreground" />}
      <span className="text-muted-foreground">
        {convertedAmount === null
          ? `no ${fromCurrency}→${targetCurrency} rate on file`
          : `≈ ${formatCurrency(convertedAmount, targetCurrency)}`}
      </span>
    </span>
  );
}
