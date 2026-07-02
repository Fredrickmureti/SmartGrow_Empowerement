import { useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinesses } from "@/hooks/useBusinesses";

const LOCAL_STORAGE_KEY = "bookflow_view_currency";

interface UseViewCurrencyPreferenceReturn {
  /** The current view currency (user preference > business base_currency > USD) */
  viewCurrency: string;
  /** Whether the preference is loading from DB */
  isLoading: boolean;
  /** Update the user's view currency preference */
  setViewCurrency: (currency: string) => void;
  /** Whether the save is in progress */
  isSaving: boolean;
}

/**
 * Hook to manage user's view currency preference.
 * 
 * Priority:
 * 1. User's saved preference (from profiles.preferred_currency)
 * 2. Current business's base_currency (Phase-7 architecture)
 * 3. Fallback: USD
 *
 * The preference is persisted to the database so it survives:
 * - Cache clears
 * - Different devices
 * - Logout/login cycles
 */
export function useViewCurrencyPreference(): UseViewCurrencyPreferenceReturn {
  const { user } = useAuth();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  // Fetch user's preferred currency from profiles table
  const { data: userPreference, isLoading } = useQuery({
    queryKey: ["view-currency-preference", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      
      const { data, error } = await supabase
        .from("profiles")
        .select("preferred_currency")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) {
        console.error("Error fetching currency preference:", error);
        return null;
      }

      return data?.preferred_currency;
    },
    enabled: !!user?.id,
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
  });

  // Mutation to save preference to database
  const { mutate: savePreference, isPending: isSaving } = useMutation({
    mutationFn: async (currency: string) => {
      if (!user?.id) throw new Error("No user logged in");

      const { error } = await supabase
        .from("profiles")
        .update({ preferred_currency: currency })
        .eq("user_id", user.id);

      if (error) throw error;

      // Also update localStorage for instant access on page load
      localStorage.setItem(LOCAL_STORAGE_KEY, currency);
      
      return currency;
    },
    onSuccess: (currency) => {
      // Update the query cache immediately
      queryClient.setQueryData(["view-currency-preference", user?.id], currency);
    },
    onError: (error) => {
      console.error("Error saving currency preference:", error);
    },
  });

  // Determine the effective view currency
  const viewCurrency = useMemo(() => {
    // Priority 1: User's DB preference
    if (userPreference) {
      return userPreference;
    }

    // Priority 2: Current business's base currency (canonical Phase-7 source)
    if (currentBusiness?.base_currency) {
      return currentBusiness.base_currency;
    }

    // Priority 3: Check localStorage for cached value (fallback during loading)
    if (typeof window !== "undefined") {
      const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (cached) return cached;
    }

    // Priority 4: Ultimate fallback
    return "USD";
  }, [userPreference, currentBusiness?.base_currency]);

  const setViewCurrency = useCallback((currency: string) => {
    // Update localStorage immediately for instant UI feedback
    if (typeof window !== "undefined") {
      localStorage.setItem(LOCAL_STORAGE_KEY, currency);
    }
    // Persist to database
    savePreference(currency);
  }, [savePreference]);

  return {
    viewCurrency,
    isLoading,
    setViewCurrency,
    isSaving,
  };
}
