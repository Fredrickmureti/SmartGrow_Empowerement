import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";
import type { ExtendedReceiptSettings, PaperSize, FontSize, LineSpacing, LogoSize, ReceiptTemplate } from "@/types/receipt";
import { DEFAULT_EXTENDED_RECEIPT_SETTINGS } from "@/lib/receiptConfig";
import { useReceiptSettings } from "@/hooks/useReceiptSettings";
import { extractPOSOverrides } from "@/hooks/pos/useMergedReceiptSettings";

// Re-export the type for backward compatibility
export type ReceiptSettings = ExtendedReceiptSettings;

/**
 * Restaurant mode settings for POS
 */
export interface RestaurantSettings {
  restaurant_mode_enabled: boolean;
  kitchen_display_enabled: boolean;
  table_bookings_enabled: boolean;
  course_management_enabled: boolean;
}

export const DEFAULT_RESTAURANT_SETTINGS: RestaurantSettings = {
  restaurant_mode_enabled: false,
  kitchen_display_enabled: false,
  table_bookings_enabled: false,
  course_management_enabled: false,
};

/**
 * Cash rounding settings
 */
export interface CashRoundingSettings {
  enabled: boolean;
  precision: number; // e.g. 0.05, 0.10, 1.00
}

export const DEFAULT_CASH_ROUNDING: CashRoundingSettings = {
  enabled: false,
  precision: 1,
};

export interface POSSetting {
  id: string;
  organization_id: string;
  register_id: string | null;
  setting_key: string;
  setting_value: Json;
  created_at: string;
  updated_at: string;
}

export type POSTenderKind =
  | "cash"
  | "card"
  | "wallet"
  | "voucher"
  | "credit_liability"
  | "ar_credit"
  | "bank"
  | "other";

export type POSCaptureMode =
  | "immediate"
  | "two_step"
  | "external_lookup"
  | "deferred";

export interface POSPaymentMethod {
  id: string;
  organization_id: string;
  branch_id: string | null;
  method_key: string;
  display_name: string;
  is_enabled: boolean;
  requires_reference: boolean;
  icon: string | null;
  sort_order: number;
  debit_account_id: string | null;
  // Phase B (Wave 2): capability metadata — extensibility contract.
  // Drives tender-panel selection, GL routing, and card FSM behavior
  // WITHOUT method-key string comparisons in the UI.
  tender_kind: POSTenderKind;
  capture_mode: POSCaptureMode;
  requires_terminal: boolean;
  provider_key: string | null;
  settlement_gl_account_id: string | null;
  created_at: string;
  updated_at: string;
}

// Templates only — never insert with is_enabled=true and a NULL debit_account_id;
// the DB CHECK pos_payment_methods_enabled_requires_account would reject it.
// Enabling a method is an explicit accounting decision the user makes from the UI.
const DEFAULT_PAYMENT_METHODS: Omit<POSPaymentMethod, "id" | "organization_id" | "created_at" | "updated_at">[] = [
  { method_key: "cash",          display_name: "Cash",          is_enabled: false, requires_reference: false, icon: "Banknote",    sort_order: 1, debit_account_id: null, branch_id: null, tender_kind: "cash",             capture_mode: "immediate",        requires_terminal: false, provider_key: null,    settlement_gl_account_id: null },
  { method_key: "card",          display_name: "Card",          is_enabled: false, requires_reference: true,  icon: "CreditCard",  sort_order: 2, debit_account_id: null, branch_id: null, tender_kind: "card",             capture_mode: "two_step",         requires_terminal: true,  provider_key: null,    settlement_gl_account_id: null },
  { method_key: "mobile_money",  display_name: "Mobile Money",  is_enabled: false, requires_reference: true,  icon: "Smartphone",  sort_order: 3, debit_account_id: null, branch_id: null, tender_kind: "wallet",           capture_mode: "external_lookup",  requires_terminal: false, provider_key: "mpesa", settlement_gl_account_id: null },
  { method_key: "bank_transfer", display_name: "Bank Transfer", is_enabled: false, requires_reference: true,  icon: "Building",    sort_order: 4, debit_account_id: null, branch_id: null, tender_kind: "bank",             capture_mode: "external_lookup",  requires_terminal: false, provider_key: null,    settlement_gl_account_id: null },
  { method_key: "voucher",       display_name: "Check/Voucher", is_enabled: false, requires_reference: true,  icon: "FileText",    sort_order: 5, debit_account_id: null, branch_id: null, tender_kind: "voucher",          capture_mode: "immediate",        requires_terminal: false, provider_key: null,    settlement_gl_account_id: null },
  { method_key: "credit",        display_name: "Store Credit", is_enabled: false, requires_reference: false, icon: "Wallet",      sort_order: 6, debit_account_id: null, branch_id: null, tender_kind: "credit_liability", capture_mode: "deferred",         requires_terminal: false, provider_key: null,    settlement_gl_account_id: null },
];


// Legacy settings adapter - converts old format to new format
function adaptLegacySettings(stored: Record<string, unknown>): ExtendedReceiptSettings {
  const result = { ...DEFAULT_EXTENDED_RECEIPT_SETTINGS };
  
  // Map old property names to new ones
  if ('auto_print_receipt' in stored) result.auto_print_receipt = stored.auto_print_receipt as boolean;
  if ('include_tax_breakdown' in stored) result.show_tax_breakdown = stored.include_tax_breakdown as boolean;
  if ('show_savings' in stored) result.show_savings = stored.show_savings as boolean;
  if ('receipt_header' in stored) result.receipt_header = stored.receipt_header as string;
  if ('receipt_footer' in stored) result.receipt_footer = stored.receipt_footer as string;
  
  // Copy over any new properties that exist
  const newKeys: (keyof ExtendedReceiptSettings)[] = [
    'paper_size', 'template', 'font_size', 'line_spacing', 'show_logo', 'logo_size',
    'primary_color', 'show_store_name', 'show_store_address', 'show_store_phone',
    'show_store_email', 'show_receipt_number', 'show_date_time', 'show_cashier_name',
    'cashier_label_format', // Added: cashier label format
    'show_register_id', 'show_customer_name', 'show_item_sku', 'show_item_quantity',
    'show_unit_price', 'show_item_discount', 'truncate_long_names', 'max_item_name_length',
    'item_display_format', // Added: two-lines vs single-line vs tabular item format
    'show_subtotal', 'show_discount_total', 'show_tax_breakdown', 'show_tax_rate',
    'show_payment_method', 'show_amount_tendered', 'show_change_due', 'show_return_policy',
    'return_policy_text', 'show_barcode', 'show_qr_code', 'show_etims_info', 'show_etims_qr'
  ];
  
  newKeys.forEach(key => {
    if (key in stored) {
      (result as Record<string, unknown>)[key] = stored[key];
    }
  });
  
  return result;
}

export function usePOSSettings(registerId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  // Pull the company-level (global) receipt settings so POS overrides can be
  // diff-and-saved against them. Without this baseline, an "untouched" POS
  // toggle would silently override the company value when written.
  const { settings: globalReceiptSettingsForDiff } = useReceiptSettings();

  // Fetch all POS settings
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ["pos-settings", organizationId, registerId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];
      
      let query = supabase
        .from("pos_settings")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);
      
      if (registerId) {
        query = query.or(`register_id.eq.${registerId},register_id.is.null`);
      } else {
        query = query.is("register_id", null);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return data as POSSetting[];
    },
    enabled: !!organizationId && !!businessId,
  });

  // Resolve the register's branch (so payment methods can be branch-restricted)
  const { data: registerBranchId } = useQuery({
    queryKey: ["pos-register-branch", registerId],
    queryFn: async () => {
      if (!registerId) return null;
      const { data, error } = await supabase
        .from("pos_registers")
        .select("branch_id")
        .eq("id", registerId)
        .maybeSingle();
      if (error) throw error;
      return (data?.branch_id as string | null) ?? null;
    },
    enabled: !!registerId,
  });

  // Fetch payment methods (branch-aware: when a register is in scope, include
  // org-wide methods (branch_id IS NULL) PLUS methods restricted to that branch)
  const { data: paymentMethods, isLoading: paymentMethodsLoading } = useQuery({
    queryKey: ["pos-payment-methods", organizationId, businessId, registerBranchId ?? "all"],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];

      let query = supabase
        .from("pos_payment_methods")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);

      if (registerBranchId) {
        query = query.or(`branch_id.is.null,branch_id.eq.${registerBranchId}`);
      }

      const { data, error } = await query.order("sort_order", { ascending: true });

      if (error) throw error;
      // Inherit-with-override dedup: when both a company-default row
      // (branch_id IS NULL) and a per-branch row exist for the same
      // method_key, the branch-specific row wins. Without this dedup the
      // resolver downstream would see duplicate entries and the company
      // default could silently shadow a branch override (e.g. a branch
      // disabling cash would not actually disable it).
      const rows = (data as POSPaymentMethod[]) ?? [];
      if (!registerBranchId) return rows;
      const byKey = new Map<string, POSPaymentMethod>();
      for (const row of rows) {
        const existing = byKey.get(row.method_key);
        if (!existing) {
          byKey.set(row.method_key, row);
          continue;
        }
        // Prefer the branch-scoped row over the company default.
        const existingIsBranch = (existing as any).branch_id === registerBranchId;
        const rowIsBranch = (row as any).branch_id === registerBranchId;
        if (rowIsBranch && !existingIsBranch) byKey.set(row.method_key, row);
      }
      return Array.from(byKey.values());
    },
    enabled: !!organizationId && !!businessId,
  });

  // Get receipt settings with legacy adapter
  const receiptSettings: ExtendedReceiptSettings = (() => {
    const setting = settings?.find(s => s.setting_key === "receipt_settings");
    if (setting?.setting_value && typeof setting.setting_value === 'object' && !Array.isArray(setting.setting_value)) {
      return adaptLegacySettings(setting.setting_value as Record<string, unknown>);
    }
    return DEFAULT_EXTENDED_RECEIPT_SETTINGS;
  })();

  // Get enabled payment methods (with defaults if none exist)
  const enabledPaymentMethods = paymentMethods?.length 
    ? paymentMethods.filter(m => m.is_enabled)
    : DEFAULT_PAYMENT_METHODS.filter(m => m.is_enabled);

  // Get all payment methods with defaults if none exist
  const allPaymentMethods = paymentMethods?.length 
    ? paymentMethods 
    : DEFAULT_PAYMENT_METHODS.map(m => ({
        ...m,
        id: m.method_key,
        organization_id: organizationId || "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

  // Get restaurant settings
  const restaurantSettings: RestaurantSettings = (() => {
    const setting = settings?.find(s => s.setting_key === "restaurant_settings");
    if (setting?.setting_value && typeof setting.setting_value === 'object' && !Array.isArray(setting.setting_value)) {
      return {
        ...DEFAULT_RESTAURANT_SETTINGS,
        ...(setting.setting_value as Record<string, unknown>),
      } as RestaurantSettings;
    }
    return DEFAULT_RESTAURANT_SETTINGS;
  })();

  // Get cash rounding settings
  const cashRoundingSettings: CashRoundingSettings = (() => {
    const setting = settings?.find(s => s.setting_key === "cash_rounding");
    if (setting?.setting_value && typeof setting.setting_value === 'object' && !Array.isArray(setting.setting_value)) {
      return {
        ...DEFAULT_CASH_ROUNDING,
        ...(setting.setting_value as Record<string, unknown>),
      } as CashRoundingSettings;
    }
    return DEFAULT_CASH_ROUNDING;
  })();

  // Update receipt settings
  // IMPORTANT: This accepts the FULL settings object from the UI to avoid stale merge issues
  const updateReceiptSettings = useMutation({
    mutationFn: async (newSettings: ExtendedReceiptSettings) => {
      if (!organizationId) throw new Error("No organization");
      if (!businessId) throw new Error("Select a Company before configuring POS receipt settings");

      // POS settings are an OVERRIDE LAYER, not a full bag. Persist only the
      // POS_OVERRIDE_FIELDS that actually differ from the company-level
      // global settings. This guarantees an "untouched" field can never
      // silently shadow a non-empty company value.
      const baseline: ExtendedReceiptSettings = {
        ...DEFAULT_EXTENDED_RECEIPT_SETTINGS,
        ...(globalReceiptSettingsForDiff ?? {}),
      };
      const candidate: ExtendedReceiptSettings = {
        ...baseline,
        ...newSettings,
      };
      const diff = extractPOSOverrides(candidate, baseline);
      // Audit fix (Phase 1): thermal-affecting fields MUST always be persisted
      // when the operator interacts with the POS receipt editor — even if the
      // chosen value happens to equal the current global default. Otherwise
      // `extractPOSOverrides` collapses the diff to {}, nothing is written to
      // pos_settings, and the snapshot path silently falls back to whatever
      // the global setting is at print time. That collapse is the root cause
      // of "I clicked 58mm but the printer still prints at 80mm".
      const ALWAYS_PERSIST_FIELDS = ["paper_size", "font_size"] as const;
      for (const field of ALWAYS_PERSIST_FIELDS) {
        const v = (candidate as unknown as Record<string, unknown>)[field];
        if (v !== undefined && v !== null) {
          (diff as Record<string, unknown>)[field] = v;
        }
      }
      // Build the persisted bag = baseline + diff so reads via legacy code
      // paths still see a consistent shape, but the diff is the source of
      // truth for what this POS layer changes.
      const settingsToSave: ExtendedReceiptSettings = {
        ...baseline,
        ...diff,
        // Track which fields the operator actually overrode for diagnostics.
        __pos_overrides__: Object.keys(diff),
      } as ExtendedReceiptSettings & { __pos_overrides__: string[] };

      const { data: existing } = await supabase
        .from("pos_settings")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .eq("setting_key", "receipt_settings")
        .is("register_id", null)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("pos_settings")
          .update({
            setting_value: settingsToSave as unknown as Json,
            updated_at: new Date().toISOString()
          })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("pos_settings")
          .insert({
            organization_id: organizationId,
            business_id: businessId,
            register_id: registerId || null,
            setting_key: "receipt_settings",
            setting_value: settingsToSave as unknown as Json,
          });
        if (error) throw error;
      }

      return settingsToSave;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-settings"] });
      toast.success("Receipt settings saved");
    },
    onError: (error) => {
      toast.error("Failed to save receipt settings");
      console.error(error);
    },
  });

  // Update payment method
  const updatePaymentMethod = useMutation({
    mutationFn: async (method: { method_key: string; is_enabled?: boolean; display_name?: string; requires_reference?: boolean; debit_account_id?: string | null }) => {
      if (!organizationId) throw new Error("No organization");
      if (!businessId) throw new Error("Select a Company before configuring POS payment methods");

      const existingMethod = paymentMethods?.find(m => m.method_key === method.method_key);
      const willBeEnabled = method.is_enabled ?? existingMethod?.is_enabled ?? true;

      // ACCOUNTING INVARIANT (DB CHECK pos_payment_methods_enabled_requires_account):
      // a payment method may only be enabled when a debit_account_id (GL account)
      // is mapped. When the user enables a method without an explicit account, we
      // must resolve a default GL account server-side via pos_apply_default_method_gl
      // BEFORE we attempt to set is_enabled = true, otherwise the DB will (correctly)
      // reject the write with constraint 23514.
      const needsAccountResolution =
        willBeEnabled &&
        method.debit_account_id == null &&
        (existingMethod?.debit_account_id ?? null) === null;

      if (needsAccountResolution) {
        const { data: rpcRes, error: rpcErr } = await supabase.rpc(
          "pos_apply_default_method_gl",
          { _business_id: businessId, _method_keys: [method.method_key] } as any
        );
        if (rpcErr) {
          throw new Error(
            `Could not resolve a default GL account for "${method.method_key}": ${rpcErr.message}`
          );
        }
        // Re-read this method to see whether the RPC actually mapped an account.
        // Note: the resolver writes to debit_account_id (the column the CHECK
        // constraint requires); clearing_account_id is a separate, optional
        // concept and is not a substitute.
        const { data: refreshed, error: refErr } = await supabase
          .from("pos_payment_methods")
          .select("id, debit_account_id")
          .eq("business_id", businessId)
          .eq("method_key", method.method_key)
          .maybeSingle();
        if (refErr) throw refErr;
        const resolved = refreshed?.debit_account_id ?? null;
        if (!resolved) {
          const summary =
            rpcRes && typeof rpcRes === "object" && "details" in rpcRes
              ? JSON.stringify((rpcRes as { details: unknown }).details)
              : "no default account available";
          throw new Error(
            `Cannot enable "${method.display_name || method.method_key}": no GL account is mapped and no system default could be resolved. Pick an asset account in the dropdown below the toggle, or configure a default Cash/Bank/Clearing account in Chart of Accounts → Default Accounts. (${summary})`
          );
        }
        method = { ...method, debit_account_id: resolved };
      }

      if (existingMethod) {
        const { error } = await supabase
          .from("pos_payment_methods")
          .update({
            ...method,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingMethod.id);
        if (error) throw error;
      } else {
        const defaultMethod = DEFAULT_PAYMENT_METHODS.find(m => m.method_key === method.method_key);
        const { error } = await supabase
          .from("pos_payment_methods")
          .insert({
            organization_id: organizationId,
            business_id: businessId,
            method_key: method.method_key,
            display_name: method.display_name || defaultMethod?.display_name || method.method_key,
            is_enabled: willBeEnabled,
            requires_reference: method.requires_reference ?? defaultMethod?.requires_reference ?? false,
            icon: defaultMethod?.icon || null,
            sort_order: defaultMethod?.sort_order || 99,
            debit_account_id: method.debit_account_id ?? null,
          });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-payment-methods"] });
      toast.success("Payment method updated");
    },
    onError: (error: unknown) => {
      const msg = error instanceof Error ? error.message : "Failed to update payment method";
      toast.error(msg);
      console.error(error);
    },
  });

  // Initialize default payment methods for the current business.
  // The DB also seeds via trg_seed_pos_payment_methods on business creation;
  // this RPC is idempotent and only inserts the six template rows (all disabled)
  // when none exist for this business.
  const initializePaymentMethods = useMutation({
    mutationFn: async () => {
      if (!organizationId) throw new Error("No organization");
      if (!businessId) throw new Error("Select a Company before initializing POS payment methods");

      const { data: existing } = await supabase
        .from("pos_payment_methods")
        .select("id")
        .eq("business_id", businessId)
        .limit(1);

      if (existing && existing.length > 0) return;

      const { error } = await supabase.rpc(
        "seed_pos_payment_methods",
        { _business_id: businessId } as any
      );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-payment-methods"] });
    },
  });

  // Update restaurant settings
  const updateRestaurantSettings = useMutation({
    mutationFn: async (newSettings: Partial<RestaurantSettings>) => {
      if (!organizationId) throw new Error("No organization");
      if (!businessId) throw new Error("Select a Company before configuring restaurant POS settings");
      
      const settingsToSave: RestaurantSettings = {
        ...restaurantSettings,
        ...newSettings,
      };
      
      const { data: existing } = await supabase
        .from("pos_settings")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .eq("setting_key", "restaurant_settings")
        .is("register_id", null)
        .maybeSingle();
      
      if (existing) {
        const { error } = await supabase
          .from("pos_settings")
          .update({ 
            setting_value: settingsToSave as unknown as Json,
            updated_at: new Date().toISOString()
          })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("pos_settings")
          .insert({
            organization_id: organizationId,
            business_id: businessId,
            register_id: null,
            setting_key: "restaurant_settings",
            setting_value: settingsToSave as unknown as Json,
          });
        if (error) throw error;
      }
      
      return settingsToSave;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-settings"] });
      toast.success("Restaurant settings saved");
    },
    onError: (error) => {
      toast.error("Failed to save restaurant settings");
      console.error(error);
    },
  });

  // Update cash rounding settings
  const updateCashRounding = useMutation({
    mutationFn: async (newSettings: CashRoundingSettings) => {
      if (!organizationId) throw new Error("No organization");
      if (!businessId) throw new Error("Select a Company before configuring POS cash rounding");

      const { data: existing } = await supabase
        .from("pos_settings")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .eq("setting_key", "cash_rounding")
        .is("register_id", null)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("pos_settings")
          .update({
            setting_value: newSettings as unknown as Json,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("pos_settings")
          .insert({
            organization_id: organizationId,
            business_id: businessId,
            register_id: null,
            setting_key: "cash_rounding",
            setting_value: newSettings as unknown as Json,
          });
        if (error) throw error;
      }
      return newSettings;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-settings"] });
      toast.success("Cash rounding settings saved");
    },
    onError: (error) => {
      toast.error("Failed to save cash rounding settings");
      console.error(error);
    },
  });

  // Generic setting upsert (used by denomination profile, etc.)
  const updateSetting = async (input: { setting_key: string; setting_value: unknown; register_id?: string }) => {
    if (!organizationId) throw new Error("No organization");
    if (!businessId) throw new Error("Select a Company before configuring POS settings");

    const regId = input.register_id || null;
    let query = supabase
      .from("pos_settings")
      .select("id")
      .eq("organization_id", organizationId)
        .eq("business_id", businessId)
      .eq("setting_key", input.setting_key);

    if (regId) {
      query = query.eq("register_id", regId);
    } else {
      query = query.is("register_id", null);
    }

    const { data: existing } = await query.maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from("pos_settings")
        .update({
          setting_value: input.setting_value as unknown as Json,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("pos_settings")
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          register_id: regId,
          setting_key: input.setting_key,
          setting_value: input.setting_value as unknown as Json,
        });
      if (error) throw error;
    }

    queryClient.invalidateQueries({ queryKey: ["pos-settings"] });
  };

  return {
    // Settings
    settings,
    settingsLoading,
    receiptSettings,
    updateReceiptSettings,
    
    // Restaurant settings
    restaurantSettings,
    updateRestaurantSettings,
    
    // Cash rounding
    cashRoundingSettings,
    updateCashRounding,
    
    // Payment methods
    paymentMethods: paymentMethods || [],
    paymentMethodsLoading,
    enabledPaymentMethods,
    allPaymentMethods,
    updatePaymentMethod,
    initializePaymentMethods,
    defaultPaymentMethods: DEFAULT_PAYMENT_METHODS,
    
    // Generic setting
    updateSetting,
    
    // Loading state
    isLoading: settingsLoading || paymentMethodsLoading,
  };
}