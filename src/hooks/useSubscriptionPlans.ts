import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

/**
 * Subscription plan shape exposed to UI.
 *
 * Pricing source-of-truth: `price_monthly` and `price_yearly` in the plan's
 * `currency` (typically USD). Display in any other currency is computed live
 * from `platform_exchange_rates` via `usePricingCurrency.formatPrice`. The
 * legacy `price_monthly_kes` / `price_yearly_kes` columns still exist in the
 * DB for back-compat with the old marketing page; UI no longer reads them
 * (plan: drop columns in a follow-up data migration).
 */
export interface SubscriptionPlan {
  id: string;
  name: string;
  description: string | null;
  price_monthly: number;
  price_yearly: number | null;
  /** @deprecated UI no longer reads this — converted live via FX. */
  price_monthly_kes?: number | null;
  /** @deprecated UI no longer reads this — converted live via FX. */
  price_yearly_kes?: number | null;
  currency: string;
  features: string[];
  max_users: number | null;
  max_invoices_per_month: number | null;
  max_organizations: number;
  max_storage_mb: number | null;
  grace_period_days: number | null;
  is_popular: boolean;
  is_active: boolean;
  is_default: boolean;
  trial_period_days: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function useSubscriptionPlans() {
  const { toast } = useToast();
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  
  const hasFetchedRef = useRef(false);

  const fetchPlans = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("platform_subscription_plans")
        .select("*")
        .order("sort_order");

      if (error) throw error;
      
      const parsedPlans: SubscriptionPlan[] = (data || []).map(plan => ({
        ...plan,
        features: Array.isArray(plan.features) 
          ? (plan.features as unknown[]).map(f => String(f))
          : [],
      }));
      
      setPlans(parsedPlans);
    } catch (error: any) {
      console.error("Error fetching subscription plans:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchPlans();
    }
  }, [fetchPlans]);

  const createPlan = async (plan: Partial<SubscriptionPlan>) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("platform_subscription_plans")
        .insert({
          name: plan.name,
          description: plan.description,
          price_monthly: plan.price_monthly,
          price_yearly: plan.price_yearly,
          // _kes columns intentionally omitted — UI converts via live FX rate.
          currency: plan.currency || "USD", // architecture-allow: display-only fallback
          features: plan.features,
          max_users: plan.max_users,
          max_invoices_per_month: plan.max_invoices_per_month,
          max_organizations: plan.max_organizations || 1,
          max_storage_mb: plan.max_storage_mb,
          grace_period_days: plan.grace_period_days,
          is_popular: plan.is_popular || false,
          is_active: plan.is_active ?? true,
          is_default: plan.is_default || false,
          trial_period_days: plan.trial_period_days,
          sort_order: plan.sort_order || 0,
        });

      if (error) throw error;

      toast({
        title: "Plan created",
        description: `${plan.name} has been created successfully.`,
      });

      await fetchPlans();
    } catch (error: any) {
      console.error("Error creating plan:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to create plan",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const updatePlan = async (id: string, updates: Partial<SubscriptionPlan>) => {
    setIsSaving(true);
    try {
      // Remove read-only fields from updates
      const { id: _id, created_at, updated_at, ...cleanUpdates } = updates as any;
      const { error } = await supabase
        .from("platform_subscription_plans")
        .update({
          ...cleanUpdates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw error;

      toast({
        title: "Plan updated",
        description: "The plan has been updated successfully.",
      });

      await fetchPlans();
    } catch (error: any) {
      console.error("Error updating plan:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update plan",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const deletePlan = async (id: string) => {
    try {
      const { error } = await supabase
        .from("platform_subscription_plans")
        .delete()
        .eq("id", id);

      if (error) throw error;

      toast({
        title: "Plan deleted",
        description: "The plan has been deleted successfully.",
      });

      await fetchPlans();
    } catch (error: any) {
      console.error("Error deleting plan:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to delete plan",
        variant: "destructive",
      });
    }
  };

  const togglePlanActive = async (id: string, isActive: boolean) => {
    await updatePlan(id, { is_active: isActive });
  };

  return {
    plans,
    activePlans: plans.filter(p => p.is_active),
    isLoading,
    isSaving,
    createPlan,
    updatePlan,
    deletePlan,
    togglePlanActive,
    refreshPlans: fetchPlans,
  };
}
