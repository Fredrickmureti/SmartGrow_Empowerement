import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { reinitializeSentry, disableSentry, isSentryInitialized } from "@/lib/sentry";

interface SentryConfig {
  enabled: boolean;
  dsn: string | null;
  environment: string;
  sampleRate: number;
}

export function useSentryConfig() {
  const [config, setConfig] = useState<SentryConfig>({
    enabled: false,
    dsn: null,
    environment: "auto",
    sampleRate: 0.1,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("platform_settings")
        .select("setting_key, setting_value")
        .in("setting_key", [
          "sentry_enabled",
          "sentry_dsn",
          "sentry_environment",
          "sentry_sample_rate",
        ]);

      if (error) throw error;

      const settings = data?.reduce((acc, item) => {
        acc[item.setting_key] = item.setting_value;
        return acc;
      }, {} as Record<string, string | null>) || {};

      const newConfig: SentryConfig = {
        enabled: settings.sentry_enabled === "true",
        dsn: settings.sentry_dsn || null,
        environment: settings.sentry_environment || "auto",
        sampleRate: parseFloat(settings.sentry_sample_rate || "0.1"),
      };

      setConfig(newConfig);

      // Auto-initialize if enabled and has DSN
      if (newConfig.enabled && newConfig.dsn) {
        reinitializeSentry({
          dsn: newConfig.dsn,
          environment: newConfig.environment === "auto" ? undefined : newConfig.environment,
          sampleRate: newConfig.sampleRate,
        });
        setIsInitialized(true);
      } else if (!newConfig.enabled && isSentryInitialized()) {
        disableSentry();
        setIsInitialized(false);
      }
    } catch (error) {
      console.error("[Sentry Config] Failed to fetch settings:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const applyConfig = useCallback((newConfig: SentryConfig) => {
    if (newConfig.enabled && newConfig.dsn) {
      reinitializeSentry({
        dsn: newConfig.dsn,
        environment: newConfig.environment === "auto" ? undefined : newConfig.environment,
        sampleRate: newConfig.sampleRate,
      });
      setIsInitialized(true);
      console.log("[Sentry] Reinitialized with new configuration");
    } else {
      disableSentry();
      setIsInitialized(false);
      console.log("[Sentry] Disabled");
    }
    setConfig(newConfig);
  }, []);

  return {
    config,
    isLoading,
    isInitialized,
    applyConfig,
    refetch: fetchConfig,
  };
}
