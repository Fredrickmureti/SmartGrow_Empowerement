/**
 * useMergedReceiptSettings
 *
 * Merges company-level receipt settings (businesses.receipt_settings, surfaced
 * by useReceiptSettings) with POS-register-specific overrides
 * (pos_settings.receipt_settings).
 *
 * Architecture: Company Defaults + POS Register Override Layer
 * - Company settings are the canonical source of truth for branding, sections, content
 * - POS register settings store ONLY terminal-specific overrides (paper_size, auto_print, compact mode, etc.)
 * - Final settings = { ...companyDefaults, ...posOverrides }
 */

import { useMemo } from "react";
import { useReceiptSettings } from "@/hooks/useReceiptSettings";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import type { ExtendedReceiptSettings } from "@/types/receipt";

/**
 * Fields that are POS-specific overrides.
 * These are the ONLY fields that POS settings should store/expose.
 * Everything else inherits from global receipt settings.
 */
export const POS_OVERRIDE_FIELDS = [
  'paper_size',
  'auto_print_receipt',
  'font_size',
  'line_spacing',
  'item_display_format',
  'show_tax_breakdown',
  'show_savings',
  'show_cashier_name',
  'cashier_label_format',
  'show_item_sku',
  'receipt_header',
  'receipt_footer',
] as const;

export type POSOverrideField = typeof POS_OVERRIDE_FIELDS[number];

/**
 * Extract only POS override fields from a full settings object.
 * Returns a partial object with only the fields that differ from global defaults.
 */
export function extractPOSOverrides(
  posSettings: ExtendedReceiptSettings,
  globalSettings: ExtendedReceiptSettings
): Partial<ExtendedReceiptSettings> {
  const overrides: Partial<ExtendedReceiptSettings> = {};
  
  for (const field of POS_OVERRIDE_FIELDS) {
    const posValue = posSettings[field];
    const globalValue = globalSettings[field];
    
    if (posValue !== globalValue) {
      (overrides as Record<string, unknown>)[field] = posValue;
    }
  }
  
  return overrides;
}

/**
 * Hook that provides merged receipt settings for POS use.
 * 
 * Returns:
 * - mergedSettings: Global defaults with POS overrides applied
 * - globalSettings: The raw global settings (for showing "inherited" indicators)
 * - posOverrides: Only the fields the POS has explicitly overridden
 * - isFieldOverridden: Helper to check if a specific field is overridden by POS
 * - isLoading: Combined loading state
 */
export function useMergedReceiptSettings(registerId?: string) {
  const { settings: globalSettings, isLoading: globalLoading } = useReceiptSettings();
  const { receiptSettings: posReceiptSettings, isLoading: posLoading } = usePOSSettings(registerId);

  const { mergedSettings, posOverrides } = useMemo(() => {
    // Start with global settings as the base
    const merged = { ...globalSettings };
    
    // Apply POS overrides on top — but only for POS_OVERRIDE_FIELDS
    const overrides: Partial<ExtendedReceiptSettings> = {};
    
    for (const field of POS_OVERRIDE_FIELDS) {
      const posValue = posReceiptSettings[field];
      const globalValue = globalSettings[field];
      
      // Only apply override if POS has a different value
      if (posValue !== undefined && posValue !== globalValue) {
        (merged as Record<string, unknown>)[field] = posValue;
        (overrides as Record<string, unknown>)[field] = posValue;
      }
    }
    
    return { mergedSettings: merged as ExtendedReceiptSettings, posOverrides: overrides };
  }, [globalSettings, posReceiptSettings]);

  const isFieldOverridden = (field: POSOverrideField): boolean => {
    return field in posOverrides;
  };

  return {
    mergedSettings,
    globalSettings,
    posOverrides,
    isFieldOverridden,
    isLoading: globalLoading || posLoading,
  };
}
