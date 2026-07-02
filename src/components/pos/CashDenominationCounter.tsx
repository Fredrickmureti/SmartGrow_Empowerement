import { useState, useEffect, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { Calculator, ChevronDown, ChevronUp } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface CashDenominationCounterProps {
  onTotalChange: (total: number) => void;
  currencyCode?: string;
  /** Config-driven denominations override (from pos_settings) */
  configDenominations?: number[];
}

// Default denomination presets — used as fallback when no config is set
const DEFAULT_DENOMINATIONS: Record<string, number[]> = {
  KES: [1000, 500, 200, 100, 50, 40, 20, 10, 5, 1],
  USD: [100, 50, 20, 10, 5, 2, 1, 0.25, 0.10, 0.05, 0.01],
  EUR: [500, 200, 100, 50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10, 0.05, 0.02, 0.01],
  GBP: [50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10, 0.05, 0.02, 0.01],
  NGN: [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1],
  ZAR: [200, 100, 50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10],
  UGX: [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100],
  TZS: [10000, 5000, 2000, 1000, 500, 200, 100, 50],
  DEFAULT: [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.50, 0.25, 0.10, 0.05, 0.01],
};

export function CashDenominationCounter({ onTotalChange, currencyCode = "DEFAULT", configDenominations }: CashDenominationCounterProps) {
  const { formatCurrency } = useCurrency();
  const [isOpen, setIsOpen] = useState(false);
  
  // Priority: config-driven > currency preset > default
  const denominations = configDenominations?.length
    ? configDenominations
    : (DEFAULT_DENOMINATIONS[currencyCode] || DEFAULT_DENOMINATIONS.DEFAULT);
  const [counts, setCounts] = useState<Record<number, number>>({});

  const total = useMemo(() => {
    return denominations.reduce((sum, d) => sum + (counts[d] || 0) * d, 0);
  }, [counts, denominations]);

  useEffect(() => {
    onTotalChange(total);
  }, [total, onTotalChange]);

  const handleCountChange = (denomination: number, value: string) => {
    const num = parseInt(value) || 0;
    setCounts(prev => ({ ...prev, [denomination]: Math.max(0, num) }));
  };

  const handleClear = () => {
    setCounts({});
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" type="button" className="w-full justify-between text-xs text-muted-foreground hover:text-foreground">
          <span className="flex items-center gap-1.5">
            <Calculator className="h-3.5 w-3.5" />
            Denomination Counter
          </span>
          {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <div className="border rounded-lg p-3 space-y-2">
          <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
            <span className="text-muted-foreground font-medium">Denomination</span>
            <span className="text-muted-foreground font-medium text-center">Count</span>
            <span className="text-muted-foreground font-medium text-right">Subtotal</span>
            {denominations.map(d => (
              <div key={d} className="contents">
                <span className="flex items-center text-sm">{d >= 1 ? d.toLocaleString() : d.toFixed(2)}</span>
                <Input
                  type="number"
                  min="0"
                  value={counts[d] || ""}
                  onChange={(e) => handleCountChange(d, e.target.value)}
                  className="h-7 text-center text-sm px-1"
                  placeholder="0"
                />
                <span className="flex items-center justify-end text-sm">
                  {formatCurrency((counts[d] || 0) * d)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <Button variant="ghost" size="sm" type="button" onClick={handleClear} className="text-xs h-7">
              Clear
            </Button>
            <span className="font-semibold text-sm">Total: {formatCurrency(total)}</span>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
