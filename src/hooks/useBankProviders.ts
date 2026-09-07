/**
 * Bank feed providers — retired.
 *
 * The inherited ERP shipped a platform-level catalogue of open-banking
 * aggregators (`platform_bank_providers`). That table has been removed: this
 * single-institution Kenyan microfinance deployment reconciles its bank
 * accounts manually (branch deposits, bank statements, M-Pesa PayBill), and
 * there is no platform-admin persona to configure aggregator credentials.
 *
 * The hook is kept as an inert stub so the bank-account creation flow keeps
 * its "manual account" path and its existing types without a redesign. It
 * always reports an empty provider list.
 */
import { useCallback } from "react";
import type { Json } from "@/integrations/supabase/types";

export interface BankProvider {
  id: string;
  provider_code: string;
  provider_name: string;
  description: string | null;
  logo_url: string | null;
  api_base_url: string | null;
  api_key_encrypted: string | null;
  api_secret_encrypted: string | null;
  merchant_code: string | null;
  public_key: string | null;
  private_key_encrypted: string | null;
  is_enabled: boolean;
  is_sandbox: boolean;
  supported_countries: string[];
  config: Json;
  created_at: string;
  updated_at: string;
}

// Public view type (without sensitive fields)
export interface BankProviderPublic {
  id: string;
  provider_code: string;
  provider_name: string;
  description: string | null;
  logo_url: string | null;
  is_enabled: boolean;
  is_sandbox: boolean;
  supported_countries: string[];
  created_at: string;
  updated_at: string;
}

export interface BankProviderUpdateData {
  api_key_encrypted?: string | null;
  api_secret_encrypted?: string | null;
  merchant_code?: string | null;
  public_key?: string | null;
  private_key_encrypted?: string | null;
  is_enabled?: boolean;
  is_sandbox?: boolean;
  config?: Json;
  logo_url?: string | null;
}

const NO_PROVIDERS: BankProvider[] = [];

export function useBankProviders() {
  const noop = useCallback(async () => {}, []);

  return {
    providers: NO_PROVIDERS,
    isLoading: false,
    isSaving: false,
    fetchProviders: noop,
    updateProvider: async (_id: string, _data: BankProviderUpdateData) => {},
    toggleProvider: async (_id: string, _isEnabled: boolean) => {},
    testConnection: async (_providerId: string): Promise<boolean> => false,
  };
}
