import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface NotificationAlertSettings {
  id: string | null;
  organization_id: string;
  business_id: string | null;

  // Inventory thresholds
  low_stock_warning_threshold: number;
  low_stock_critical_threshold: number;
  out_of_stock_alert: boolean;

  // Invoice settings
  invoice_reminder_days_before: number;
  overdue_reminder_frequency_days: number;
  overdue_escalation_enabled: boolean;

  // Payment settings
  payment_received_notify: boolean;
  large_payment_threshold: number;

  // Expense settings
  expense_approval_required_above: number;

  // Digest settings
  daily_digest_enabled: boolean;
  weekly_digest_enabled: boolean;
  digest_send_hour: number;
  digest_timezone: string;

  created_at: string | null;
  updated_at: string | null;
}

// IMPORTANT: do NOT type the editable input as `typeof DEFAULT_SETTINGS`
// when DEFAULT_SETTINGS is `as const` — that turns every field into a literal
// type (e.g. `10`, `5`, `true`) and rejects any runtime user value at the
// type level. Define a real mutable interface instead.
export interface NotificationAlertSettingsInput {
  low_stock_warning_threshold: number;
  low_stock_critical_threshold: number;
  out_of_stock_alert: boolean;
  invoice_reminder_days_before: number;
  overdue_reminder_frequency_days: number;
  overdue_escalation_enabled: boolean;
  payment_received_notify: boolean;
  large_payment_threshold: number;
  expense_approval_required_above: number;
  daily_digest_enabled: boolean;
  weekly_digest_enabled: boolean;
  digest_send_hour: number;
  digest_timezone: string;
}

const DEFAULT_SETTINGS: NotificationAlertSettingsInput = {
  low_stock_warning_threshold: 10,
  low_stock_critical_threshold: 5,
  out_of_stock_alert: true,
  invoice_reminder_days_before: 7,
  overdue_reminder_frequency_days: 7,
  overdue_escalation_enabled: true,
  payment_received_notify: true,
  large_payment_threshold: 10000,
  expense_approval_required_above: 5000,
  daily_digest_enabled: false,
  weekly_digest_enabled: true,
  digest_send_hour: 8,
  digest_timezone: "Africa/Nairobi",
};

// Editable-field schema. Validates ranges before any DB call.
export const notificationAlertSettingsSchema = z
  .object({
    low_stock_warning_threshold: z.number().int().min(0).max(1_000_000),
    low_stock_critical_threshold: z.number().int().min(0).max(1_000_000),
    out_of_stock_alert: z.boolean(),
    invoice_reminder_days_before: z.number().int().min(0).max(365),
    overdue_reminder_frequency_days: z.number().int().min(1).max(365),
    overdue_escalation_enabled: z.boolean(),
    payment_received_notify: z.boolean(),
    large_payment_threshold: z.number().min(0),
    expense_approval_required_above: z.number().min(0),
    daily_digest_enabled: z.boolean(),
    weekly_digest_enabled: z.boolean(),
    digest_send_hour: z.number().int().min(0).max(23),
    digest_timezone: z.string().min(1).max(64),
  })
  .refine(
    (s) => s.low_stock_critical_threshold <= s.low_stock_warning_threshold,
    {
      path: ["low_stock_critical_threshold"],
      message: "Critical threshold must be ≤ warning threshold",
    },
  );

const EDITABLE_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof NotificationAlertSettingsInput)[];

function pickEditable(input: Partial<NotificationAlertSettingsInput>) {
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE_KEYS) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  return out;
}

export function useNotificationAlertSettings() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const { data: settings, isLoading } = useQuery({
    queryKey: ["notification-alert-settings", organizationId, businessId],
    queryFn: async (): Promise<NotificationAlertSettings | null> => {
      if (!organizationId) return null;

      // SCOPE-EXEMPT: intentional .or() pulls business-specific OR org-default row
      const { data, error } = await supabase
        .from("notification_alert_settings")
        .select("*")
        .eq("organization_id", organizationId)
        .or(
          businessId
            ? `business_id.eq.${businessId},business_id.is.null`
            : "business_id.is.null",
        )
        .order("business_id", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      if (data) return data as NotificationAlertSettings;

      // No row yet — return editable defaults only. Critically, do NOT
      // synthesize empty `id` / `created_at` / `updated_at` strings — those
      // would crash any caller that spreads this object back into an upsert.
      return {
        id: null,
        organization_id: organizationId,
        business_id: businessId ?? null,
        ...DEFAULT_SETTINGS,
        created_at: null,
        updated_at: null,
      };
    },
    enabled: !!organizationId,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (updates: Partial<NotificationAlertSettingsInput>) => {
      if (!organizationId) throw new Error("Missing organization");

      const merged = {
        ...DEFAULT_SETTINGS,
        ...(settings ? pickEditable(settings as NotificationAlertSettingsInput) : {}),
        ...pickEditable(updates),
      } as NotificationAlertSettingsInput;

      const parsed = notificationAlertSettingsSchema.safeParse(merged);
      if (!parsed.success) {
        // Surface ALL issues — don't mask later failures behind the first one.
        const messages = parsed.error.issues.map((iss) => {
          const field = iss.path?.join(".") || "field";
          return `${field}: ${iss.message}`;
        });
        throw new Error(messages.join("; "));
      }

      const { data, error } = await supabase.rpc(
        "upsert_notification_alert_settings",
        {
          _organization_id: organizationId,
          _business_id: businessId ?? null,
          _settings: parsed.data,
        },
      );

      if (error) {
        // Surface human-readable messages for known PG codes.
        if (error.code === "22007") {
          throw new Error(
            "Invalid date in payload — please reload the page and retry.",
          );
        }
        if (error.code === "42501") {
          throw new Error(
            "You do not have permission to change notification settings for this organization.",
          );
        }
        throw new Error(error.message);
      }
      return data as NotificationAlertSettings;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification-alert-settings"] });
      toast.success("Alert settings updated");
    },
    onError: (error: Error) => {
      toast.error(`Failed to update settings: ${normalizeError(error).message}`);
    },
  });

  return {
    settings:
      settings ??
      ({
        id: null,
        organization_id: organizationId ?? "",
        business_id: businessId ?? null,
        ...DEFAULT_SETTINGS,
        created_at: null,
        updated_at: null,
      } as NotificationAlertSettings),
    isLoading,
    updateSettings: updateSettingsMutation.mutate,
    isUpdating: updateSettingsMutation.isPending,
    defaults: DEFAULT_SETTINGS,
  };
}
