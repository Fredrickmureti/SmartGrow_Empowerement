/**
 * Extended Offline Storage Service
 * Adds additional stores for comprehensive offline POS functionality
 */

import { offlineStorage, STORES } from "./OfflineStorageService";
import { supabase } from "@/integrations/supabase/client";

// Extended store names
export const EXTENDED_STORES = {
  ...STORES,
  REGISTERS: "registers",
  SHIFTS: "shifts",
  TAX_RATES: "tax_rates",
  PAYMENT_METHODS: "payment_methods",
  USER_PROFILE: "user_profile",
  ORGANIZATION: "organization",
  CASHIERS: "cashiers",
  DISCOUNTS: "discounts",
  BUSINESSES: "businesses",
  BRANCHES: "branches",
  // Studio configuration stores
  ENTITY_FIELD_CONFIGS: "entity_field_configs",
  SAVED_VIEWS: "saved_views",
  FORM_LAYOUTS: "form_layouts",
  AUTOMATED_ACTIONS: "automated_actions",
} as const;

// Types for extended data
export interface CachedRegister {
  id: string;
  register_code: string;
  name: string;
  branch_id: string;
  is_active: boolean;
  default_opening_cash: number;
}

export interface CachedShift {
  id: string;
  register_id: string;
  cashier_id: string;
  cashier_name: string;
  status: "open" | "closed";
  opening_cash: number;
  expected_cash: number;
  opened_at: string;
}

export interface CachedTaxRate {
  id: string;
  name: string;
  rate: number;
  is_default: boolean;
  is_active: boolean;
}

export interface CachedPaymentMethod {
  id: string;
  name: string;
  code: string;
  is_active: boolean;
  is_cash: boolean;
}

export interface CachedOrganization {
  id: string;
  name: string;
  base_currency: string;
  subscription_plan_id: string;
  settings: Record<string, unknown>;
}

export interface CachedBusiness {
  id: string;
  name: string;
  organization_id: string;
  base_currency: string;
  logo_url?: string;
}

/**
 * Extended data caching service
 */
class ExtendedOfflineStorageService {
  private organizationId: string | null = null;

  /**
   * Set the organization context
   */
  setOrganization(orgId: string): void {
    this.organizationId = orgId;
  }

  /**
   * Cache POS registers
   */
  async cacheRegisters(organizationId?: string): Promise<number> {
    const orgId = organizationId || this.organizationId;
    if (!orgId) return 0;

    try {
      // SCOPE-EXEMPT: offline cache caches all registers in workspace for terminal use
      const { data, error } = await supabase
        .from("pos_registers")
        .select("*")
        .eq("organization_id", orgId)
        .eq("is_active", true);

      if (error) throw error;

      const registers: CachedRegister[] = data.map((r) => ({
        id: r.id,
        register_code: r.register_code,
        name: r.register_code, // Use register_code as name
        branch_id: r.branch_id,
        is_active: r.is_active,
        default_opening_cash: r.max_cash_limit || 0,
      }));

      await offlineStorage.putBulk(EXTENDED_STORES.REGISTERS, registers);
      await offlineStorage.updateSyncMeta("registers", new Date().toISOString());
      console.log(`Cached ${registers.length} registers for offline use`);
      return registers.length;
    } catch (error) {
      console.error("Failed to cache registers:", error);
      return 0;
    }
  }

  /**
   * Get cached registers
   */
  async getCachedRegisters(): Promise<CachedRegister[]> {
    return offlineStorage.getAll<CachedRegister>(EXTENDED_STORES.REGISTERS);
  }

  /**
   * Cache open shifts for the organization
   */
  async cacheOpenShifts(organizationId?: string): Promise<number> {
    const orgId = organizationId || this.organizationId;
    if (!orgId) return 0;

    try {
      // SCOPE-EXEMPT: offline cache caches all open shifts in workspace
      const { data, error } = await supabase
        .from("pos_shifts")
        .select(`
          id,
          register_id,
          cashier_id,
          status,
          opening_cash,
          expected_cash,
          opened_at,
          profiles:cashier_id (full_name)
        `)
        .eq("organization_id", orgId)
        .eq("status", "open");

      if (error) throw error;

      const shifts: CachedShift[] = data.map((s: any) => ({
        id: s.id,
        register_id: s.register_id,
        cashier_id: s.cashier_id,
        cashier_name: s.profiles?.full_name || "Unknown",
        status: s.status,
        opening_cash: s.opening_cash || 0,
        expected_cash: s.expected_cash || 0,
        opened_at: s.opened_at,
      }));

      await offlineStorage.clear(EXTENDED_STORES.SHIFTS);
      await offlineStorage.putBulk(EXTENDED_STORES.SHIFTS, shifts);
      await offlineStorage.updateSyncMeta("shifts", new Date().toISOString());

      console.log(`Cached ${shifts.length} open shifts for offline use`);
      return shifts.length;
    } catch (error) {
      console.error("Failed to cache shifts:", error);
      return 0;
    }
  }

  /**
   * Get cached shifts
   */
  async getCachedShifts(): Promise<CachedShift[]> {
    return offlineStorage.getAll<CachedShift>(EXTENDED_STORES.SHIFTS);
  }

  /**
   * Cache tax rates
   */
  async cacheTaxRates(organizationId?: string, businessId?: string): Promise<number> {
    const orgId = organizationId || this.organizationId;
    if (!orgId) return 0;

    try {
      let q = supabase
        .from("tax_rates")
        .select("*")
        .eq("organization_id", orgId)
        .eq("is_active", true);
      // Scope to the active company when known; multi-company workspaces would
      // otherwise cache another business's rates into this device's POS cache.
      q = q.eq("business_id", businessId);
      const { data, error } = await q;

      if (error) throw error;

      const taxRates: CachedTaxRate[] = data.map((t) => ({
        id: t.id,
        name: t.name,
        rate: t.rate,
        is_default: t.is_default,
        is_active: t.is_active,
      }));

      await offlineStorage.clear(EXTENDED_STORES.TAX_RATES);
      await offlineStorage.putBulk(EXTENDED_STORES.TAX_RATES, taxRates);
      await offlineStorage.updateSyncMeta("tax_rates", new Date().toISOString());

      console.log(`Cached ${taxRates.length} tax rates for offline use`);
      return taxRates.length;
    } catch (error) {
      console.error("Failed to cache tax rates:", error);
      return 0;
    }
  }

  /**
   * Get cached tax rates
   */
  async getCachedTaxRates(): Promise<CachedTaxRate[]> {
    return offlineStorage.getAll<CachedTaxRate>(EXTENDED_STORES.TAX_RATES);
  }

  /**
   * Cache organization settings
   */
  async cacheOrganization(organizationId?: string): Promise<boolean> {
    const orgId = organizationId || this.organizationId;
    if (!orgId) return false;

    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: `organizations` is workspace-wide (no business_id column)
        .from("organizations")
        .select("id, name, subscription_plan_id")
        .eq("id", orgId)
        .single();

      if (error) throw error;

      // base_currency now lives on businesses; pull from primary business.
      const { data: biz } = await supabase
        // SCOPE-EXEMPT: `businesses` is workspace-wide (no business_id column)
        .from("businesses")
        .select("base_currency")
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const org: CachedOrganization = {
        id: data.id,
        name: data.name,
        base_currency: biz?.base_currency || "USD",
        subscription_plan_id: data.subscription_plan_id,
        settings: {},
      };

      await offlineStorage.put(EXTENDED_STORES.ORGANIZATION, { ...org, key: "current" });
      await offlineStorage.updateSyncMeta("organization", new Date().toISOString());

      console.log("Cached organization for offline use");
      return true;
    } catch (error) {
      console.error("Failed to cache organization:", error);
      return false;
    }
  }

  /**
   * Get cached organization
   */
  async getCachedOrganization(): Promise<CachedOrganization | null> {
    const data = await offlineStorage.get<CachedOrganization & { key: string }>(
      EXTENDED_STORES.ORGANIZATION,
      "current"
    );
    return data || null;
  }

  /**
   * Cache businesses
   */
  async cacheBusinesses(organizationId?: string): Promise<number> {
    const orgId = organizationId || this.organizationId;
    if (!orgId) return 0;

    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: `businesses` is workspace-wide (no business_id column)
        .from("businesses")
        .select("*")
        .eq("organization_id", orgId)
        .eq("is_active", true);

      if (error) throw error;

      const businesses: CachedBusiness[] = data.map((b) => ({
        id: b.id,
        name: b.name,
        organization_id: b.organization_id,
        base_currency: b.base_currency || "USD",
        logo_url: b.logo_url,
      }));

      await offlineStorage.clear(EXTENDED_STORES.BUSINESSES);
      await offlineStorage.putBulk(EXTENDED_STORES.BUSINESSES, businesses);
      await offlineStorage.updateSyncMeta("businesses", new Date().toISOString());

      console.log(`Cached ${businesses.length} businesses for offline use`);
      return businesses.length;
    } catch (error) {
      console.error("Failed to cache businesses:", error);
      return 0;
    }
  }

  /**
   * Get cached businesses
   */
  async getCachedBusinesses(): Promise<CachedBusiness[]> {
    return offlineStorage.getAll<CachedBusiness>(EXTENDED_STORES.BUSINESSES);
  }

  /**
   * Cache Studio entity field configurations
   */
  async cacheEntityFieldConfigs(organizationId?: string): Promise<number> {
    const orgId = organizationId || this.organizationId;
    if (!orgId) return 0;

    try {
      const { data, error } = await supabase
        .from("entity_field_configs" as "accounts")
        .select("*")
        .eq("organization_id", orgId)
        .eq("is_active", true);

      if (error) throw error;

      await offlineStorage.clear(EXTENDED_STORES.ENTITY_FIELD_CONFIGS);
      await offlineStorage.putBulk(EXTENDED_STORES.ENTITY_FIELD_CONFIGS, data || []);
      await offlineStorage.updateSyncMeta("entity_field_configs", new Date().toISOString());

      console.log(`Cached ${data?.length || 0} entity field configs for offline use`);
      return data?.length || 0;
    } catch (error) {
      console.error("Failed to cache entity field configs:", error);
      return 0;
    }
  }

  /**
   * Cache Studio saved views
   */
  async cacheSavedViews(organizationId?: string): Promise<number> {
    const orgId = organizationId || this.organizationId;
    if (!orgId) return 0;

    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: "saved_views" is workspace-wide (not in BUSINESS_SCOPED_TABLES)
        .from("saved_views" as "accounts")
        .select("*")
        .eq("organization_id", orgId);

      if (error) throw error;

      await offlineStorage.clear(EXTENDED_STORES.SAVED_VIEWS);
      await offlineStorage.putBulk(EXTENDED_STORES.SAVED_VIEWS, data || []);
      await offlineStorage.updateSyncMeta("saved_views", new Date().toISOString());

      console.log(`Cached ${data?.length || 0} saved views for offline use`);
      return data?.length || 0;
    } catch (error) {
      console.error("Failed to cache saved views:", error);
      return 0;
    }
  }

  /**
   * Cache Studio form layouts
   */
  async cacheFormLayouts(organizationId?: string): Promise<number> {
    const orgId = organizationId || this.organizationId;
    if (!orgId) return 0;

    try {
      const { data, error } = await supabase
        .from("form_layouts" as "accounts")
        .select("*")
        .eq("organization_id", orgId);

      if (error) throw error;

      await offlineStorage.clear(EXTENDED_STORES.FORM_LAYOUTS);
      await offlineStorage.putBulk(EXTENDED_STORES.FORM_LAYOUTS, data || []);
      await offlineStorage.updateSyncMeta("form_layouts", new Date().toISOString());

      console.log(`Cached ${data?.length || 0} form layouts for offline use`);
      return data?.length || 0;
    } catch (error) {
      console.error("Failed to cache form layouts:", error);
      return 0;
    }
  }

  /**
   * Cache automated actions for offline reference
   */
  async cacheAutomatedActions(organizationId?: string): Promise<number> {
    const orgId = organizationId || this.organizationId;
    if (!orgId) return 0;

    try {
      // SCOPE-EXEMPT: offline cache caches all automation rules in workspace
      const { data, error } = await supabase
        .from("automated_actions")
        .select("*, automated_action_steps(*)")
        .eq("organization_id", orgId)
        .eq("is_active", true);

      if (error) throw error;

      await offlineStorage.clear(EXTENDED_STORES.AUTOMATED_ACTIONS);
      await offlineStorage.putBulk(EXTENDED_STORES.AUTOMATED_ACTIONS, data || []);
      await offlineStorage.updateSyncMeta("automated_actions", new Date().toISOString());

      console.log(`Cached ${data?.length || 0} automated actions for offline use`);
      return data?.length || 0;
    } catch (error) {
      console.error("Failed to cache automated actions:", error);
      return 0;
    }
  }

  /**
   * Full data cache for offline mode
   */
  async cacheAllData(organizationId: string): Promise<{
    registers: number;
    shifts: number;
    taxRates: number;
    businesses: number;
    organization: boolean;
    entityFieldConfigs: number;
    savedViews: number;
    formLayouts: number;
    automatedActions: number;
  }> {
    this.setOrganization(organizationId);

    const [
      registers, 
      shifts, 
      taxRates, 
      businesses, 
      organization,
      entityFieldConfigs,
      savedViews,
      formLayouts,
      automatedActions,
    ] = await Promise.all([
      this.cacheRegisters(organizationId),
      this.cacheOpenShifts(organizationId),
      this.cacheTaxRates(organizationId),
      this.cacheBusinesses(organizationId),
      this.cacheOrganization(organizationId),
      this.cacheEntityFieldConfigs(organizationId),
      this.cacheSavedViews(organizationId),
      this.cacheFormLayouts(organizationId),
      this.cacheAutomatedActions(organizationId),
    ]);

    return {
      registers,
      shifts,
      taxRates,
      businesses,
      organization,
      entityFieldConfigs,
      savedViews,
      formLayouts,
      automatedActions,
    };
  }

  /**
   * Get cache freshness status
   */
  async getCacheFreshness(): Promise<Record<string, { lastSync: string | null; isStale: boolean }>> {
    const stores = ["products", "customers", "registers", "shifts", "tax_rates", "organization"];
    const staleThreshold = 60 * 60 * 1000; // 1 hour

    const freshness: Record<string, { lastSync: string | null; isStale: boolean }> = {};

    for (const store of stores) {
      const meta = await offlineStorage.getSyncMeta(store);
      const lastSync = meta?.lastSyncedAt || null;
      const isStale = !lastSync || Date.now() - new Date(lastSync).getTime() > staleThreshold;

      freshness[store] = { lastSync, isStale };
    }

    return freshness;
  }
}

// Singleton instance
export const extendedOfflineStorage = new ExtendedOfflineStorageService();
