import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useViewCurrencyPreference } from "@/hooks/useViewCurrencyPreference";
import { normalizeError } from "@/services/resilience";
import { resolveRateFromBook, type RateBookRow } from "@/services/fx/rateBook";


export interface ExchangeRate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  display_name?: string | null;
  symbol?: string | null;
}

/**
 * AdminDisplayCurrency is now any active ISO 4217 currency code present in
 * `platform_exchange_rates`. The `"USD" | "KES"` literal union is kept for
 * back-compat with old call sites — new code should use `string`.
 */
export type AdminDisplayCurrency = string;

/**
 * A currency the admin can pick from the toggle. Always includes USD (the
 * canonical base) plus any currency that has at least one direct rate row
 * to/from USD.
 */
export interface AvailableAdminCurrency {
  code: string;
  display_name: string;
  symbol: string;
  /** rate to convert 1 USD → 1 unit of this currency */
  usdRate: number;
}

export function useAdminCurrency() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Use the shared database-backed preference
  const { viewCurrency, setViewCurrency: setPreference, isSaving } = useViewCurrencyPreference();

  // The displayed currency is whatever the user previously chose. We do NOT
  // narrow it to USD/KES anymore — the Indian/UK/EU admin gets their own
  // ISO code through.
  const displayCurrency: AdminDisplayCurrency = (viewCurrency || "USD").toUpperCase(); // architecture-allow: display-only fallback — platform billing is denominated in USD

  // Fetch exchange rates
  const { data: exchangeRates, isLoading: isLoadingRates } = useQuery({
    queryKey: ["platform-exchange-rates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("platform_exchange_rates")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data as ExchangeRate[];
    },
  });

  /**
   * Resolve the rate to convert 1 USD into `target` from the platform market
   * book, direct or inverted.
   *
   * ADR 0136: returns `null` when no path exists. It must never invent 1 and
   * must never carry a hardcoded literal — an unknown rate is displayed as
   * unknown, not as an unconverted number wearing the target currency's
   * symbol. This is platform BILLING display only; tenant accounting rates
   * come from `public.exchange_rates` via the server resolver.
   */
  const usdToTargetRate = useCallback(
    (target: string): number | null => {
      const t = (target || "").toUpperCase();
      if (!t) return null;
      // One lookup implementation for the whole client (ADR 0136): the platform
      // market rows are mapped onto the rate-book shape and resolved by the
      // shared resolver — no second inversion/precedence implementation lives here.
      const rows: RateBookRow[] = (exchangeRates ?? []).map((r) => ({
        from_currency: r.from_currency,
        to_currency: r.to_currency,
        rate: r.rate,
        effective_date: (r.created_at ?? "").split("T")[0] || "1970-01-01",
        source: "provider",
      }));
      return resolveRateFromBook(rows, "USD", t, undefined, "USD");
    },
    [exchangeRates]
  );


  /** Back-compat helper — `null` when the KES row is absent. No literal fallback. */
  const usdToKesRate = usdToTargetRate("KES");

  /** Currencies the admin can choose from in the toggle. */
  const availableCurrencies: AvailableAdminCurrency[] = (() => {
    const rates = exchangeRates ?? [];
    const map = new Map<string, AvailableAdminCurrency>();
    // Always offer USD even if the row is missing.
    map.set("USD", { code: "USD", display_name: "US Dollar", symbol: "$", usdRate: 1 });
    for (const r of rates) {
      if (r.from_currency === "USD") {
        map.set(r.to_currency, {
          code: r.to_currency,
          display_name: r.display_name || r.to_currency,
          symbol: r.symbol || r.to_currency,
          usdRate: Number(r.rate),
        });
      } else if (r.to_currency === "USD" && Number(r.rate) !== 0) {
        map.set(r.from_currency, {
          code: r.from_currency,
          display_name: r.display_name || r.from_currency,
          symbol: r.symbol || r.from_currency,
          usdRate: 1 / Number(r.rate),
        });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.code === "USD" ? -1 : b.code === "USD" ? 1 : a.code.localeCompare(b.code)
    );
  })();

  // Set display currency using the shared DB-backed preference
  const setDisplayCurrency = useCallback(
    (currency: AdminDisplayCurrency) => {
      setPreference(currency.toUpperCase());
    },
    [setPreference],
  );

  /**
   * Convert an amount **stored in USD** into the admin's chosen display
   * currency. Pass `target` to override the current display preference.
   * Returns `null` when no rate is on file for the target.
   */
  const convertAmount = useCallback(
    (amountInUsd: number, target?: string): number | null => {
      const t = (target ?? displayCurrency).toUpperCase();
      if (t === "USD") return amountInUsd;
      const rate = usdToTargetRate(t);
      return rate === null ? null : amountInUsd * rate;
    },
    [displayCurrency, usdToTargetRate],
  );

  // Format currency in the admin's display currency. Renders an em dash when
  // no rate is on file — an unconverted USD figure must never be shown
  // wearing another currency's symbol.
  const formatCurrency = useCallback(
    (amountInUsd: number, target?: string): string => {
      const code = (target ?? displayCurrency).toUpperCase();
      const converted = convertAmount(amountInUsd, code);
      if (converted === null) return "—";
      // JPY / KES / UGX / TZS / RWF have effectively no fractional unit in
      // common usage — render them as integers.
      const zeroDecimal = new Set(["JPY", "KES", "UGX", "TZS", "RWF", "NGN"]);
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: code,
          minimumFractionDigits: zeroDecimal.has(code) ? 0 : 2,
          maximumFractionDigits: zeroDecimal.has(code) ? 0 : 2,
        }).format(converted);
      } catch {
        const meta = availableCurrencies.find((c) => c.code === code);
        const symbol = meta?.symbol || code;
        return `${symbol} ${converted.toLocaleString(undefined, {
          minimumFractionDigits: zeroDecimal.has(code) ? 0 : 2,
          maximumFractionDigits: zeroDecimal.has(code) ? 0 : 2,
        })}`;
      }
    },
    [displayCurrency, convertAmount, availableCurrencies],
  );

  // Update exchange rate mutation
  const updateRateMutation = useMutation({
    mutationFn: async ({ id, rate }: { id: string; rate: number }) => {
      // Capture the previous value for the audit log entry.
      const { data: before } = await supabase
        .from("platform_exchange_rates")
        .select("from_currency, to_currency, rate")
        .eq("id", id)
        .maybeSingle();

      const { error } = await supabase
        .from("platform_exchange_rates")
        .update({ rate })
        .eq("id", id);

      if (error) throw error;

      // Audit v2 (M3): every FX edit must be traceable to the actor and
      // the old → new value. Failure to log MUST NOT block the edit.
      try {
        const { data: userResp } = await supabase.auth.getUser();
        await supabase.from("admin_audit_log").insert({
          admin_user_id: userResp?.user?.id ?? null,
          action_type: "fx_rate_edit",
          target_entity_type: "platform_exchange_rates",
          target_entity_id: id,
          details: {
            from_currency: before?.from_currency,
            to_currency: before?.to_currency,
            old_rate: before?.rate,
            new_rate: rate,
          },
        });
      } catch (logErr) {
        console.warn("[useAdminCurrency] audit log failed:", logErr);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-exchange-rates"] });
      toast({ title: "Exchange rate updated successfully" });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to update exchange rate",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  // Create exchange rate mutation
  const createRateMutation = useMutation({
    mutationFn: async ({
      from_currency,
      to_currency,
      rate,
      display_name,
      symbol,
    }: {
      from_currency: string;
      to_currency: string;
      rate: number;
      display_name?: string;
      symbol?: string;
    }) => {
      const { data: inserted, error } = await supabase
        .from("platform_exchange_rates")
        .insert({
          from_currency,
          to_currency,
          rate,
          display_name: display_name ?? null,
          symbol: symbol ?? null,
        })
        .select("id")
        .single();

      if (error) throw error;

      // Audit v2 (M3): record currency additions too.
      try {
        const { data: userResp } = await supabase.auth.getUser();
        await supabase.from("admin_audit_log").insert({
          admin_user_id: userResp?.user?.id ?? null,
          action_type: "fx_rate_create",
          target_entity_type: "platform_exchange_rates",
          target_entity_id: inserted?.id ?? null,
          details: { from_currency, to_currency, rate, display_name, symbol },
        });
      } catch (logErr) {
        console.warn("[useAdminCurrency] audit log failed:", logErr);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-exchange-rates"] });
      toast({ title: "Exchange rate created successfully" });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to create exchange rate",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  return {
    displayCurrency,
    setDisplayCurrency,
    exchangeRates,
    availableCurrencies,
    usdToKesRate,
    usdToTargetRate,
    isLoadingRates,
    convertAmount,
    formatCurrency,
    updateRate: updateRateMutation.mutate,
    createRate: createRateMutation.mutate,
    isUpdatingRate: updateRateMutation.isPending,
    isCreatingRate: createRateMutation.isPending,
    isSavingPreference: isSaving,
  };
}
