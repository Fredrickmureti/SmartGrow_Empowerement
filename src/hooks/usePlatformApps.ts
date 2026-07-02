/**
 * usePlatformApps Hook
 * 
 * Fetches the platform_apps catalog from the database.
 * Used to derive core app IDs, default app IDs, and signup-visible apps
 * instead of hardcoding them in client code.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PlatformApp {
  id: string;
  name: string;
  description: string | null;
  category: string;
  required_plan: string;
  is_available: boolean;
  is_core: boolean;
  is_free_trial: boolean;
  is_visible_in_signup: boolean;
  trial_days: number | null;
  sort_order: number;
}

/**
 * Fetch all platform apps from DB. Works for both anon and authenticated contexts.
 */
export function usePlatformApps() {
  return useQuery({
    queryKey: ["platform-apps"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("platform_apps")
        .select("id, name, description, category, required_plan, is_available, is_core, is_free_trial, is_visible_in_signup, trial_days, sort_order")
        .eq("is_available", true)
        .order("sort_order", { ascending: true });

      if (error) throw error;
      return (data || []) as PlatformApp[];
    },
    staleTime: 10 * 60 * 1000, // 10 minutes — catalog rarely changes
  });
}

/**
 * Derive core app IDs from platform_apps data.
 * Falls back to safe defaults if data is unavailable.
 */
export function getCoreAppIds(platformApps: PlatformApp[] | undefined): string[] {
  if (platformApps && platformApps.length > 0) {
    return platformApps.filter(a => a.is_core).map(a => a.id);
  }
  // Fallback: matches current DB state
  return ["finance", "sales", "contacts", "purchases", "reports", "platform"];
}

/**
 * Derive default app IDs for new organizations from platform_apps data.
 * Core apps + commonly useful non-core apps at starter plan level.
 */
export function getDefaultAppIds(platformApps: PlatformApp[] | undefined): string[] {
  if (platformApps && platformApps.length > 0) {
    // Core apps are always included
    const coreIds = platformApps.filter(a => a.is_core).map(a => a.id);
    // Also include starter-tier non-core apps that are visible in signup
    const starterExtras = platformApps
      .filter(a => !a.is_core && a.required_plan === "starter" && a.is_visible_in_signup)
      .map(a => a.id);
    // Always include platform
    const result = new Set([...coreIds, ...starterExtras, "platform"]);
    return Array.from(result);
  }
  // Fallback
  return ["finance", "sales", "contacts", "purchases", "inventory", "reports", "platform"];
}
