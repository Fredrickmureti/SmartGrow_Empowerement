import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchPublicPricingSnapshot } from "@/lib/pricing/publicPricing";

export type DisplayCurrency = "KES" | "USD";

interface PriceDisplay {
  primary: string;
  secondary: string;
  rawAmount: number;
}

export function usePricingCurrency() {
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>("KES");
  const [exchangeRate, setExchangeRate] = useState<number>(130); // Default fallback
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await fetchPublicPricingSnapshot();
        if (cancelled) return;
        const usdKes = snapshot.rates.find(
          (r) => r.from_currency === "USD" && r.to_currency === "KES",
        );
        if (usdKes?.rate) setExchangeRate(Number(usdKes.rate));
      } catch (error) {
        console.error("Failed to fetch pricing snapshot:", error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const formatNumber = (num: number): string => {
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Math.round(num));
  };

  const formatPrice = useCallback(
    (priceUsd: number, priceKes?: number | null): PriceDisplay => {
      if (displayCurrency === "KES") {
        const kesAmount = priceKes ?? priceUsd * exchangeRate;
        return {
          primary: `KSh ${formatNumber(kesAmount)}`,
          secondary: priceUsd > 0 ? `≈ $${formatNumber(priceUsd)}` : "",
          rawAmount: kesAmount,
        };
      }

      const kesEquivalent = priceUsd * exchangeRate;
      return {
        primary: `$${formatNumber(priceUsd)}`,
        secondary: priceUsd > 0 ? `≈ KSh ${formatNumber(kesEquivalent)}` : "",
        rawAmount: priceUsd,
      };
    },
    [displayCurrency, exchangeRate],
  );

  const toggleCurrency = () => {
    setDisplayCurrency((prev) => (prev === "KES" ? "USD" : "KES"));
  };

  // Keep the supabase import referenced so removing this hook's only direct
  // table read doesn't leave a dangling import elsewhere expecting it.
  void supabase;

  return {
    displayCurrency,
    setDisplayCurrency,
    toggleCurrency,
    exchangeRate,
    formatPrice,
    isLoading,
  };
}
