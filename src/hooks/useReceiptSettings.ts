/**
 * useReceiptSettings — per-COMPANY receipt formatting.
 *
 * Phase-3 audit fix: receipt formatting (paper size, template, typography,
 * field visibility) now lives on `businesses.receipt_settings` instead of
 * `organization_settings.receipt_settings`. Two companies in the same
 * workspace can legitimately need different receipt formats (e.g., a Kenyan
 * retail company on 80mm thermal vs. a Ugandan wholesale company on A5), and
 * the previous workspace-keyed storage silently overwrote one with the other.
 *
 * The legacy `organization_settings` row is kept untouched for rollback
 * safety; the migration backfilled the primary company of each workspace
 * from it. New writes never touch `organization_settings`.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import type { ExtendedReceiptSettings } from "@/types/receipt";
import { DEFAULT_EXTENDED_RECEIPT_SETTINGS, applyTemplatePreset } from "@/lib/receiptConfig";

// Re-export for backward compatibility
export type ReceiptSettings = ExtendedReceiptSettings;

export function useReceiptSettings() {
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const businessId = currentBusiness?.id;

  const {
    data: settings,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["receipt-settings", businessId],
    queryFn: async () => {
      if (!businessId) return DEFAULT_EXTENDED_RECEIPT_SETTINGS;

      const { data, error } = await supabase
        .from("businesses")
        .select("receipt_settings")
        .eq("id", businessId)
        .maybeSingle();

      if (error) throw error;

      const raw = (data as { receipt_settings?: Partial<ExtendedReceiptSettings> } | null)?.receipt_settings;
      if (raw && typeof raw === "object" && Object.keys(raw).length > 0) {
        return { ...DEFAULT_EXTENDED_RECEIPT_SETTINGS, ...raw };
      }

      return DEFAULT_EXTENDED_RECEIPT_SETTINGS;
    },
    enabled: !!businessId,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (newSettings: Partial<ExtendedReceiptSettings>) => {
      if (!businessId) throw new Error("Select a Company first — receipt settings are per-company.");

      const mergedSettings: ExtendedReceiptSettings = { ...(settings ?? DEFAULT_EXTENDED_RECEIPT_SETTINGS), ...newSettings };

      const { error } = await supabase
        .from("businesses")
        .update({ receipt_settings: mergedSettings } as never)
        .eq("id", businessId);

      if (error) throw error;

      return mergedSettings;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["receipt-settings", businessId], data);
      toast.success("Receipt settings saved");
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Failed to save receipt settings";
      console.error("Failed to save receipt settings:", error);
      toast.error(message);
    },
  });

  const applyTemplate = (template: ExtendedReceiptSettings["template"]) => {
    if (!settings) return;
    const newSettings = applyTemplatePreset(settings, template);
    updateSettingsMutation.mutate(newSettings);
  };

  return {
    settings: settings ?? DEFAULT_EXTENDED_RECEIPT_SETTINGS,
    isLoading,
    error,
    updateSettings: updateSettingsMutation.mutate,
    applyTemplate,
    isUpdating: updateSettingsMutation.isPending,
  };
}
