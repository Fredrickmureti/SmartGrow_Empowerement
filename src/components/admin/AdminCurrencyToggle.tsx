/**
 * AdminCurrencyToggle
 *
 * Lets a platform admin pick the display currency for every figure in the
 * admin console. Lists every currency that has an active rate row in
 * `platform_exchange_rates`, not a hardcoded USD/KES pair.
 *
 * Mirrors how Stripe / Shopify / Linear handle display currency: a per-user
 * preference applied with a per-currency FX factor at view time. The
 * underlying data stays in USD; nothing is written back at the converted
 * rate.
 */
import { useMemo, useState } from "react";
import { Check, DollarSign, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";

export function AdminCurrencyToggle() {
  const {
    displayCurrency,
    setDisplayCurrency,
    availableCurrencies,
    isLoadingRates,
  } = useAdminCurrency();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const current = useMemo(
    () => availableCurrencies.find((c) => c.code === displayCurrency),
    [availableCurrencies, displayCurrency],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return availableCurrencies;
    return availableCurrencies.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.display_name.toLowerCase().includes(q),
    );
  }, [availableCurrencies, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 min-w-[88px]">
          <DollarSign className="h-4 w-4" />
          <span className="font-medium">{current?.symbol ?? "$"}</span>
          <span className="hidden sm:inline text-muted-foreground">
            {displayCurrency}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search currency…"
              className="pl-8 h-8 text-xs"
            />
          </div>
        </div>
        <ScrollArea className="max-h-72">
          {isLoadingRates ? (
            <div className="p-4 text-xs text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">
              No currencies match.
            </div>
          ) : (
            <div className="py-1">
              {filtered.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => {
                    setDisplayCurrency(c.code);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="w-full flex items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium w-7 text-center">
                      {c.symbol}
                    </span>
                    <span className="truncate">{c.display_name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {c.code}
                    </span>
                  </div>
                  {displayCurrency === c.code ? (
                    <Check className="h-4 w-4 text-primary" />
                  ) : (
                    <span className="text-[10px] text-muted-foreground">
                      1 USD = {c.usdRate.toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
        <div className="px-3 py-2 text-[10px] text-muted-foreground border-t">
          Display only — figures are stored in USD and converted at view time.
        </div>
      </PopoverContent>
    </Popover>
  );
}
