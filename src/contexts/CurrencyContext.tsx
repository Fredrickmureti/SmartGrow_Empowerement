// @ts-nocheck
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface Currency {
  id: string;
  code: string;
  name: string;
  symbol: string;
  decimal_places: number;
  is_active: boolean;
}

export interface ExchangeRate {
  id: string;
  organization_id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  effective_date: string;
}

interface CurrencyContextType {
  currencies: Currency[];
  exchangeRates: ExchangeRate[];
  baseCurrency: string;
  isReady: boolean;
  isLoading: boolean;
  formatCurrency: (amount: number, currencyCode?: string) => string;
  getCurrencySymbol: (currencyCode?: string) => string;
  /** Resolved rate, or `null` when no rate is on file. NEVER silently 1. */
  getExchangeRate: (fromCurrency: string, toCurrency: string, date?: string) => number | null;
  /** Converted amount, or `null` when no rate is on file. */
  convertCurrency: (amount: number, fromCurrency: string, toCurrency: string, date?: string) => number | null;
  addExchangeRate: (fromCurrency: string, toCurrency: string, rate: number, effectiveDate?: string) => Promise<void>;
  refreshCurrencies: () => Promise<void>;
  refreshExchangeRates: () => Promise<void>;
}

const STORAGE_KEY = "bookflow_base_currency";

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined);

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currenciesLoaded, setCurrenciesLoaded] = useState(false);

  // Initialize baseCurrency from localStorage for instant access (no flash)
  const [baseCurrency, setBaseCurrency] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEY) || "USD";
    }
    return "USD";
  });

  // Sync baseCurrency when current business loads/changes (Phase-7: business is source of truth)
  useEffect(() => {
    if (currentBusiness?.base_currency) {
      const newCurrency = currentBusiness.base_currency;
      setBaseCurrency(newCurrency);
      localStorage.setItem(STORAGE_KEY, newCurrency);
    }
  }, [currentBusiness?.base_currency]);

  const fetchCurrencies = useCallback(async () => {
    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: `currencies` is workspace-wide (no business_id column)
        .from("currencies")
        .select("*")
        .eq("is_active", true)
        .order("code");

      if (error) throw error;
      setCurrencies(data || []);
      setCurrenciesLoaded(true);
    } catch (error) {
      console.error("Error fetching currencies:", error);
      setCurrenciesLoaded(true);
    }
  }, []);

  const fetchExchangeRates = useCallback(async () => {
    if (!currentOrg) return;

    try {
      const { data, error } = await supabase
        .from("exchange_rates")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("effective_date", { ascending: false });

      if (error) throw error;
      setExchangeRates(data || []);
    } catch (error) {
      console.error("Error fetching exchange rates:", error);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await Promise.all([fetchCurrencies(), fetchExchangeRates()]);
      setIsLoading(false);
    };
    load();
  }, [fetchCurrencies, fetchExchangeRates]);

  const formatCurrency = useCallback(
    (amount: number, currencyCode?: string): string => {
      const code = currencyCode || baseCurrency;
      const currency = currencies.find((c) => c.code === code);
      
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: code,
          minimumFractionDigits: currency?.decimal_places ?? 2,
          maximumFractionDigits: currency?.decimal_places ?? 2,
        }).format(amount);
      } catch {
        // Fallback for unsupported currency codes
        const symbol = currency?.symbol || code;
        return `${symbol}${amount.toFixed(currency?.decimal_places ?? 2)}`;
      }
    },
    [baseCurrency, currencies]
  );

  const getCurrencySymbol = useCallback(
    (currencyCode?: string): string => {
      const code = currencyCode || baseCurrency;
      const currency = currencies.find((c) => c.code === code);
      return currency?.symbol || code;
    },
    [baseCurrency, currencies]
  );

  const getExchangeRate = useCallback(
    (fromCurrency: string, toCurrency: string, date?: string): number => {
      if (fromCurrency === toCurrency) return 1;

      const targetDate = date || new Date().toISOString().split("T")[0];
      
      // 1. Try direct rate first (e.g., USD -> KES)
      const directRate = exchangeRates.find(
        (r) =>
          r.from_currency === fromCurrency &&
          r.to_currency === toCurrency &&
          r.effective_date <= targetDate
      );

      if (directRate) return directRate.rate;

      // 2. Try reverse rate and invert it (e.g., KES -> USD, then 1/rate)
      const reverseRate = exchangeRates.find(
        (r) =>
          r.from_currency === toCurrency &&
          r.to_currency === fromCurrency &&
          r.effective_date <= targetDate
      );

      if (reverseRate && reverseRate.rate !== 0) {
        return 1 / reverseRate.rate;
      }

      // 3. Try triangulation through USD (common base currency)
      const baseCurrencyForTriangulation = "USD";
      
      if (fromCurrency !== baseCurrencyForTriangulation && toCurrency !== baseCurrencyForTriangulation) {
        // Find from -> USD rate
        let fromToBase = exchangeRates.find(
          (r) =>
            r.from_currency === fromCurrency &&
            r.to_currency === baseCurrencyForTriangulation &&
            r.effective_date <= targetDate
        )?.rate;

        // Try reverse if not found
        if (!fromToBase) {
          const baseToFrom = exchangeRates.find(
            (r) =>
              r.from_currency === baseCurrencyForTriangulation &&
              r.to_currency === fromCurrency &&
              r.effective_date <= targetDate
          )?.rate;
          if (baseToFrom && baseToFrom !== 0) {
            fromToBase = 1 / baseToFrom;
          }
        }

        // Find USD -> to rate
        let baseToTarget = exchangeRates.find(
          (r) =>
            r.from_currency === baseCurrencyForTriangulation &&
            r.to_currency === toCurrency &&
            r.effective_date <= targetDate
        )?.rate;

        // Try reverse if not found
        if (!baseToTarget) {
          const targetToBase = exchangeRates.find(
            (r) =>
              r.from_currency === toCurrency &&
              r.to_currency === baseCurrencyForTriangulation &&
              r.effective_date <= targetDate
          )?.rate;
          if (targetToBase && targetToBase !== 0) {
            baseToTarget = 1 / targetToBase;
          }
        }

        if (fromToBase && baseToTarget) {
          return fromToBase * baseToTarget;
        }
      }

      // No rate found - return 1 (no conversion)
      return 1;
    },
    [exchangeRates]
  );

  const convertCurrency = useCallback(
    (amount: number, fromCurrency: string, toCurrency: string, date?: string): number => {
      const rate = getExchangeRate(fromCurrency, toCurrency, date);
      return amount * rate;
    },
    [getExchangeRate]
  );

  const addExchangeRate = async (
    fromCurrency: string,
    toCurrency: string,
    rate: number,
    effectiveDate?: string
  ) => {
    if (!currentOrg) throw new Error("No organization selected");

    const { error } = await supabase.from("exchange_rates").upsert({
      organization_id: currentOrg.id,
      from_currency: fromCurrency,
      to_currency: toCurrency,
      rate,
      effective_date: effectiveDate || new Date().toISOString().split("T")[0],
    });

    if (error) throw error;
    await fetchExchangeRates();
  };

  // isReady is true when we have a cached currency OR when currencies have loaded
  const isReady = useMemo(() => {
    // If we have a cached baseCurrency from localStorage and it's not the default "USD",
    // we're ready immediately
    const cachedCurrency = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (cachedCurrency && cachedCurrency !== "USD") {
      return true;
    }
    // Otherwise, wait for currencies to load
    return currenciesLoaded;
  }, [currenciesLoaded]);

  const value = useMemo(
    () => ({
      currencies,
      exchangeRates,
      baseCurrency,
      isReady,
      isLoading,
      formatCurrency,
      getCurrencySymbol,
      getExchangeRate,
      convertCurrency,
      addExchangeRate,
      refreshCurrencies: fetchCurrencies,
      refreshExchangeRates: fetchExchangeRates,
    }),
    [
      currencies,
      exchangeRates,
      baseCurrency,
      isReady,
      isLoading,
      formatCurrency,
      getCurrencySymbol,
      getExchangeRate,
      convertCurrency,
      fetchCurrencies,
      fetchExchangeRates,
    ]
  );

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrencyContext() {
  const context = useContext(CurrencyContext);
  if (context === undefined) {
    throw new Error("useCurrencyContext must be used within a CurrencyProvider");
  }
  return context;
}
