import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export interface PlatformSetting {
  id: string;
  setting_key: string;
  setting_value: string | null;
  setting_type: string;
  description: string | null;
  is_secret: boolean;
  created_at: string;
  updated_at: string;
}

export function usePlatformSettings() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<PlatformSetting[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  
  // Prevent refetching on component re-mount or tab focus
  const hasFetchedRef = useRef(false);

  const fetchSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("platform_settings")
        .select("*")
        .order("setting_key");

      if (error) throw error;
      setSettings(data || []);
    } catch (error: any) {
      console.error("Error fetching platform settings:", error);
      toast({
        title: "Error",
        description: "Failed to load platform settings",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    // Only fetch once on initial mount
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchSettings();
    }
  }, [fetchSettings]);

  const getSetting = (key: string): string | null => {
    const setting = settings.find((s) => s.setting_key === key);
    return setting?.setting_value ?? null;
  };

  const updateSetting = async (key: string, value: string | null) => {
    setIsSaving(true);
    try {
      // Try to update first
      const { data: updateResult, error: updateError } = await supabase
        .from("platform_settings")
        .update({ setting_value: value, updated_at: new Date().toISOString() })
        .eq("setting_key", key)
        .select();

      if (updateError) throw updateError;

      // If no rows were updated, insert the new setting
      if (!updateResult || updateResult.length === 0) {
        const { error: insertError } = await supabase
          .from("platform_settings")
          .insert({
            setting_key: key,
            setting_value: value,
            setting_type: 'string',
            is_secret: key.includes('api_key') || key.includes('secret'),
            description: null,
          });

        if (insertError) throw insertError;
      }

      // Update local state
      setSettings((prev) => {
        const exists = prev.some(s => s.setting_key === key);
        if (exists) {
          return prev.map((s) =>
            s.setting_key === key ? { ...s, setting_value: value } : s
          );
        } else {
          return [...prev, {
            id: crypto.randomUUID(),
            setting_key: key,
            setting_value: value,
            setting_type: 'string',
            description: null,
            is_secret: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }];
        }
      });

      toast({
        title: "Setting updated",
        description: `${key} has been updated successfully.`,
      });
    } catch (error: any) {
      console.error("Error updating setting:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update setting",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const updateMultipleSettings = async (
    updates: { key: string; value: string | null }[]
  ) => {
    setIsSaving(true);
    try {
      for (const update of updates) {
        // Try to update first
        const { data: updateResult, error: updateError } = await supabase
          .from("platform_settings")
          .update({
            setting_value: update.value,
            updated_at: new Date().toISOString(),
          })
          .eq("setting_key", update.key)
          .select();

        if (updateError) throw updateError;

        // If no rows were updated, insert the new setting
        if (!updateResult || updateResult.length === 0) {
          const { error: insertError } = await supabase
            .from("platform_settings")
            .insert({
              setting_key: update.key,
              setting_value: update.value,
              setting_type: 'string',
              is_secret: update.key.includes('api_key') || update.key.includes('secret'),
              description: null,
            });

          if (insertError) throw insertError;
        }
      }

      // Refresh settings
      await fetchSettings();

      toast({
        title: "Settings saved",
        description: "All settings have been updated successfully.",
      });
    } catch (error: any) {
      console.error("Error updating settings:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update settings",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return {
    settings,
    isLoading,
    isSaving,
    getSetting,
    updateSetting,
    updateMultipleSettings,
    refreshSettings: fetchSettings,
  };
}
