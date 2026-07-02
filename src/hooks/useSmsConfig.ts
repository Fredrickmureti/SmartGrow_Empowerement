import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type SmsMode = "test" | "live";

/** Masked config returned from the SECURITY DEFINER RPC — never contains real credentials */
export interface SmsProviderConfigMasked {
  id: string;
  organization_id: string;
  business_id: string | null;
  provider: "twilio";
  provider_mode: SmsMode;
  is_enabled: boolean;
  account_sid_masked: string | null;
  auth_token_masked: string;
  sender_phone: string | null;
  messaging_service_sid: string | null;
  webhook_url: string | null;
  daily_limit: number | null;
  messages_sent_today: number | null;
  last_reset_date: string | null;
  last_test_at: string | null;
  last_test_status: string | null;
  last_test_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Structured response from send-sms / test-sms-connection edge functions */
export interface SmsEdgeResponse {
  success: boolean;
  code: string;
  message: string | null;
  mode?: SmsMode;
  message_sid?: string | null;
  log_id?: string | null;
}

export interface UpsertSmsConfigInput {
  provider?: "twilio";
  provider_mode?: SmsMode;
  is_enabled?: boolean;
  account_sid?: string;
  auth_token?: string;
  sender_phone?: string | null;
  messaging_service_sid?: string | null;
}

export function useSmsConfig() {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const configQuery = useQuery({
    queryKey: ["sms-config", orgId],
    queryFn: async () => {
      if (!orgId) return null;
      const { data, error } = await supabase
        .rpc("get_sms_config_masked", { p_organization_id: orgId });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] ?? null : data;
      return row as SmsProviderConfigMasked | null;
    },
    enabled: !!orgId,
  });

  const upsertConfig = useMutation({
    mutationFn: async (config: UpsertSmsConfigInput) => {
      if (!orgId) throw new Error("No organization");
      // All credential writes go through the SECURITY DEFINER RPC so the auth_token
      // never travels through PostgREST as a plain table column and so every change
      // is audited. The RPC also enforces role + format validation server-side.
      const { error } = await supabase.rpc("set_sms_provider_config", {
        p_organization_id: orgId,
        p_account_sid: config.account_sid ?? null,
        p_auth_token: config.auth_token ?? null,
        p_provider_mode: config.provider_mode ?? null,
        p_is_enabled: config.is_enabled ?? null,
        p_sender_phone: config.sender_phone ?? null,
        p_messaging_service_sid: config.messaging_service_sid ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-config", orgId] });
      // Surfaces like document previews read these keys; refresh them so the
      // SMS button appears/disappears immediately after toggling Enabled.
      queryClient.invalidateQueries({ queryKey: ["sms-availability-config", orgId] });
      queryClient.invalidateQueries({ queryKey: ["sms-enabled", orgId] });
      toast.success("SMS configuration saved");
    },
    onError: (err: Error) => {
      toast.error("Failed to save SMS config: " + normalizeError(err).message);
    },
  });

  const testConnection = useMutation({
    mutationFn: async (testPhone: string): Promise<SmsEdgeResponse> => {
      if (!orgId) throw new Error("No organization");
      const { data, error } = await supabase.functions.invoke("provider-test", {
        body: { kind: "sms", organization_id: orgId, test_phone: testPhone },
      });
      // Edge function returns 200 with structured {success:false,code,message} for handled errors.
      // Only treat as transport failure if there is no body at all.
      if (data) return data as SmsEdgeResponse;
      if (error) {
        // Try to recover the structured body from supabase-js FunctionsHttpError context
        const ctx = (error as unknown as { context?: { body?: unknown } })?.context;
        if (ctx?.body) {
          try {
            const text = typeof ctx.body === "string" ? ctx.body : await (ctx.body as Response).text?.();
            if (text) return JSON.parse(text) as SmsEdgeResponse;
          } catch { /* fall through */ }
        }
        throw error;
      }
      throw new Error("Empty response from test-sms-connection");
    },
    onSuccess: (data) => {
      if (data?.success) {
        toast.success(
          data.mode === "test"
            ? "Test SMS simulated successfully (test mode — no real SMS sent)."
            : "Test SMS sent successfully."
        );
      } else {
        toast.error(`Test failed (${data?.code || "UNKNOWN"}): ${data?.message || "Unknown error"}`);
      }
      queryClient.invalidateQueries({ queryKey: ["sms-config", orgId] });
    },
    onError: (err: Error) => {
      toast.error("Connection test failed: " + normalizeError(err).message);
    },
  });

  return {
    config: configQuery.data,
    isLoading: configQuery.isLoading,
    upsertConfig,
    testConnection,
  };
}
