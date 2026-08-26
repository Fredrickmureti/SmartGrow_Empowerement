import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export interface Business {
  id: string;
  organization_id: string;
  name: string;
  legal_name: string | null;
  tax_id: string | null;
  registration_number: string | null;
  logo_url: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  base_currency: string | null;
  /** Vertical captured at signup/onboarding; drives UX defaults (see industryProfiles). */
  industry?: string | null;
  invoice_prefix: string | null;
  estimate_prefix: string | null;
  bill_prefix: string | null;
  is_active: boolean;
  week_starts_on?: number | null;
  weekly_hours_target?: number | null;
  timezone?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBusinessInput {
  name: string;
  legal_name?: string;
  tax_id?: string;
  registration_number?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  base_currency?: string;
  invoice_prefix?: string;
  estimate_prefix?: string;
  bill_prefix?: string;
}

interface BusinessAccessInfo {
  businessId: string;
  isPrimary: boolean;
  canSwitch: boolean;
}

interface BusinessContextType {
  businesses: Business[];
  currentBusiness: Business | null;
  isLoading: boolean;
  hasMultipleCompanies: boolean;
  /** @deprecated use hasMultipleCompanies (Odoo-aligned vocabulary). */
  hasMultipleBusinesses: boolean;
  canSwitchBusiness: boolean;
  /** Switch to a specific company. Pass a valid id — passing null throws. */
  switchBusiness: (businessId: string) => Promise<void> | void;
  createBusiness: (input: CreateBusinessInput) => Promise<Business>;
  updateBusiness: (id: string, updates: Partial<CreateBusinessInput>) => Promise<Business>;
  deleteBusiness: (id: string) => Promise<void>;
  refreshBusinesses: () => Promise<void>;
}

export const BusinessContext = createContext<BusinessContextType | undefined>(undefined);

export function BusinessProvider({ children }: { children: ReactNode }) {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [accessMap, setAccessMap] = useState<Map<string, BusinessAccessInfo>>(new Map());
  const [currentBusiness, setCurrentBusiness] = useState<Business | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadedOrgId, setLoadedOrgId] = useState<string | null>(null);

  const fetchBusinesses = useCallback(async () => {
    if (!currentOrg) {
      setBusinesses([]);
      setAccessMap(new Map());
      setCurrentBusiness(null);
      setLoadedOrgId(null);
      setIsLoading(false);
      return;
    }

    const orgId = currentOrg.id;

    setIsLoading(true);
    try {
      // Get current user
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setBusinesses([]);
        setAccessMap(new Map());
        setCurrentBusiness(null);
        setLoadedOrgId(orgId);
        setIsLoading(false);
        return;
      }

      // Fetch user's business access rows
      let { data: accessRows, error: accessError } = await supabase
        .from("user_business_access")
        .select("business_id, is_primary, can_switch")
        .eq("user_id", user.id)
        .eq("organization_id", orgId);

      if (accessError) throw accessError;

      // No silent recovery: per Odoo architecture, an empty `businesses` set is
      // a deliberate state. The UI shows a "Create your first company" CTA
      // (see ContextSwitcherSheet). Auto-recreating a company with US/USD
      // defaults is an anti-pattern that hides real configuration mistakes.

      // Build access map
      const newAccessMap = new Map<string, BusinessAccessInfo>();
      const rows = accessRows || [];
      rows.forEach((row: any) => {
        newAccessMap.set(row.business_id, {
          businessId: row.business_id,
          isPrimary: row.is_primary,
          canSwitch: row.can_switch,
        });
      });
      setAccessMap(newAccessMap);

      // Determine which businesses to show:
      // If user can switch → show all allowed businesses
      // If user cannot switch → show only primary business
      const userCanSwitch = rows.some((r: any) => r.can_switch);
      const idsToFetch = userCanSwitch
        ? rows.map((r: any) => r.business_id)
        : rows.filter((r: any) => r.is_primary).map((r: any) => r.business_id);

      let data: Business[] = [];
      if (idsToFetch.length > 0) {
        const { data: bizData, error } = await supabase
          // SCOPE-EXEMPT: `businesses` is workspace-wide (no business_id column)
          .from("businesses")
          .select("*")
          .in("id", idsToFetch)
          .eq("is_active", true)
          .order("name");
        if (error) throw error;
        data = bizData || [];
      }

      setBusinesses(data);

      // Phase E: DB is source of truth. user_active_business holds the
      // per-(user, org) active company. localStorage is only a startup hint.
      const primaryBiz = data.find(b => newAccessMap.get(b.id)?.isPrimary);
      const localHint = localStorage.getItem(`currentBusinessId_${orgId}`);

      const { data: activeRow } = await supabase
        .from("user_active_business")
        .select("business_id")
        .eq("user_id", user.id)
        .eq("organization_id", orgId)
        .maybeSingle();

      const dbActive = activeRow?.business_id
        ? data.find(b => b.id === activeRow.business_id)
        : null;
      const hintActive = localHint && localHint !== "all"
        ? data.find(b => b.id === localHint)
        : null;

      const chosen = dbActive || hintActive || primaryBiz || data[0] || null;
      setCurrentBusiness(chosen);

      if (chosen && (!dbActive || dbActive.id !== chosen.id)) {
        await supabase
          .from("user_active_business")
          .upsert(
            { user_id: user.id, organization_id: orgId, business_id: chosen.id },
            { onConflict: "user_id,organization_id" },
          );
      }
      if (chosen) {
        localStorage.setItem(`currentBusinessId_${orgId}`, chosen.id);
      }
    } catch (error) {
      console.error("Error fetching businesses:", error);
      toast.error("Failed to load businesses");
    } finally {
      setLoadedOrgId(orgId);
      setIsLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    fetchBusinesses();
  }, [fetchBusinesses]);

  // Phase E: realtime multi-tab sync. When the user switches companies in
  // another tab, user_active_business updates and we react here.
  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      channel = supabase
        .channel(`active-biz-${user.id}-${currentOrg.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "user_active_business",
            filter: `user_id=eq.${user.id}`,
          },
          (payload: any) => {
            const next = (payload.new?.business_id ?? null) as string | null;
            if (!next || payload.new?.organization_id !== currentOrg.id) return;
            setCurrentBusiness(prev => {
              if (prev?.id === next) return prev;
              const found = businesses.find(b => b.id === next);
              if (!found) return prev;
              queryClient.clear();
              localStorage.setItem(`currentBusinessId_${currentOrg.id}`, next);
              return found;
            });
          },
        )
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [currentOrg, businesses, queryClient]);

  const hasMultipleBusinesses = businesses.length >= 2;
  // During sign-in / org switches there is one render where SessionContext has
  // selected an org but this provider still holds the signed-out/previous-org
  // business snapshot. Surface that as loading synchronously so downstream
  // guards do not emit false "Select a Company" toasts before this effect runs.
  const effectiveIsLoading = isLoading || (!!currentOrg && loadedOrgId !== currentOrg.id);
  const canSwitchBusiness = useMemo(() => {
    if (!hasMultipleBusinesses) return false;
    return Array.from(accessMap.values()).some(a => a.canSwitch);
  }, [accessMap, hasMultipleBusinesses]);

  const switchBusiness = useCallback(async (businessId: string) => {
    if (!currentOrg) return;
    if (!businessId) {
      throw new Error("switchBusiness requires a valid company id. The legacy 'All Companies' pseudo-mode no longer exists — see /finance/reports/cross-company for cross-company comparison.");
    }
    const business = businesses.find((b) => b.id === businessId);
    if (!business) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from("user_active_business")
        .upsert(
          { user_id: user.id, organization_id: currentOrg.id, business_id: businessId },
          { onConflict: "user_id,organization_id" },
        );
    }
    queryClient.clear();
    setCurrentBusiness(business);
    localStorage.setItem(`currentBusinessId_${currentOrg.id}`, businessId);
  }, [businesses, currentOrg, queryClient]);

  const createBusiness = async (input: CreateBusinessInput): Promise<Business> => {
    if (!currentOrg) throw new Error("No organization selected");

    // Currency MUST come from explicit input or be inherited from the active
    // company. Defaulting to "USD" silently makes the system non-country-
    // agnostic — a Kenyan tenant's second company would post in USD and
    // poison every report. Force the caller to be explicit.
    const resolvedCurrency = input.base_currency || currentBusiness?.base_currency;
    if (!resolvedCurrency) {
      throw new Error(
        "base_currency is required when creating a company. Pass it explicitly — there is no safe default.",
      );
    }

    // Country is a NOT NULL accounting boundary in the schema (drives
    // localization pack, tax setup, and reporting). Inherit from the active
    // company only if not provided — never default to a hardcoded value.
    const resolvedCountry = input.country || currentBusiness?.country || null;
    if (!resolvedCountry) {
      throw new Error(
        "country is required when creating a company. Pass it explicitly — there is no safe default.",
      );
    }

    // Use the hardened RPC: provisions company row + HQ branch + user access
    // + country-localized chart of accounts + current fiscal year + 12 monthly
    // periods. Plain INSERT into `businesses` is forbidden because it would
    // leave the new company without a CoA — first invoice would fail.
    const { data: newBusinessId, error: rpcError } = await supabase.rpc(
      "provision_additional_company" as any,
      {
        _org_id: currentOrg.id,
        _name: input.name,
        _country: resolvedCountry,
        _currency: resolvedCurrency,
        _business_type: null,
        _legal_name: input.legal_name ?? null,
      } as any,
    );
    if (rpcError) throw rpcError;

    // Apply any extra optional fields (tax_id, address, prefixes, …) that the
    // RPC doesn't take. Safe because the row already exists and is owned.
    const extras: Partial<CreateBusinessInput> = { ...input };
    delete (extras as any).name;
    delete (extras as any).country;
    delete (extras as any).base_currency;
    delete (extras as any).legal_name;

    let row: Business;
    if (Object.keys(extras).length > 0) {
      const { data: updated, error: updError } = await supabase
        .from("businesses")
        .update(extras)
        .eq("id", newBusinessId as string)
        .select()
        .single();
      if (updError) throw updError;
      row = updated as Business;
    } else {
      const { data: fetched, error: fetchError } = await supabase
        .from("businesses")
        .select("*")
        .eq("id", newBusinessId as string)
        .single();
      if (fetchError) throw fetchError;
      row = fetched as Business;
    }

    toast.success("Company created with chart of accounts and fiscal periods");
    // Seed POS defaults (default payment methods etc.). Non-blocking.
    try {
      await supabase.rpc("seed_pos_defaults_for_business" as any, {
        _business_id: newBusinessId as string,
      } as any);
    } catch (e) {
      console.warn("Non-blocking: seed_pos_defaults_for_business failed", e);
    }
    await fetchBusinesses();
    return row;
  };

  const updateBusiness = async (id: string, updates: Partial<CreateBusinessInput>): Promise<Business> => {
    if (!currentOrg) throw new Error("No organization selected");
    const { data, error } = await supabase
      .from("businesses")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", currentOrg.id)
      .select()
      .single();

    if (error) throw error;

    toast.success("Business updated successfully");
    await fetchBusinesses();
    return data;
  };

  const deleteBusiness = async (id: string): Promise<void> => {
    if (!currentOrg) throw new Error("No organization selected");
    const { error } = await supabase
      .from("businesses")
      .update({ is_active: false })
      .eq("id", id)
      .eq("organization_id", currentOrg.id);

    if (error) throw error;

    toast.success("Business deleted successfully");
    await fetchBusinesses();
  };

  return (
    <BusinessContext.Provider
      value={{
        businesses,
        currentBusiness,
          isLoading: effectiveIsLoading,
        hasMultipleCompanies: hasMultipleBusinesses,
        hasMultipleBusinesses,
        canSwitchBusiness,
        switchBusiness,
        createBusiness,
        updateBusiness,
        deleteBusiness,
        refreshBusinesses: fetchBusinesses,
      }}
    >
      {children}
    </BusinessContext.Provider>
  );
}

export function useBusinesses() {
  const context = useContext(BusinessContext);
  if (!context) {
    throw new Error("useBusinesses must be used within BusinessProvider");
  }
  return context;
}

// ─────────────────────────────────────────────────────────────────────────────
// Odoo-aligned vocabulary aliases.
// New code should prefer `Company` / `useCompanies` / `currentCompany`.
// The `Business` exports remain as deprecated re-exports for backward compat.
// ─────────────────────────────────────────────────────────────────────────────

/** @see Business — Odoo-aligned alias (res.company). */
export type Company = Business;

/** @see CreateBusinessInput — Odoo-aligned alias. */
export type CreateCompanyInput = CreateBusinessInput;

/**
 * Odoo-aligned hook returning the current workspace's companies and active
 * company. Thin alias over `useBusinesses()` exposing `companies` /
 * `currentCompany` / `switchCompany` / `createCompany` etc.
 */
export function useCompanies() {
  const ctx = useBusinesses();
  return {
    companies: ctx.businesses,
    currentCompany: ctx.currentBusiness,
    isLoading: ctx.isLoading,
    hasMultipleCompanies: ctx.hasMultipleCompanies,
    canSwitchCompany: ctx.canSwitchBusiness,
    switchCompany: ctx.switchBusiness,
    createCompany: ctx.createBusiness,
    updateCompany: ctx.updateBusiness,
    deleteCompany: ctx.deleteBusiness,
    refreshCompanies: ctx.refreshBusinesses,
  };
}
