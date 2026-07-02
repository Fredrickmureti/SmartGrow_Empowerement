import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSms, normalizePhoneE164, sanitizeForLog, type SmsMode, type SmsErrorCode } from "../_shared/twilio.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface SendSmsRequest {
  organization_id: string;
  business_id?: string;
  event_type?: string;
  recipient_phone: string;
  template_variables?: Record<string, string>;
  custom_message?: string;
  /** Optional: which sms_log row this is a retry of */
  retry_of_log_id?: string;
  /** Optional document linkage so the communication history pane can find this send. */
  entity_type?: string;
  entity_id?: string;
  /** Optional explicit template id for accurate audit trail. */
  template_id?: string;
  /** Test send (template editor "Send test"). Logged with is_test=true. */
  is_test?: boolean;
  /** Source of the send: manual | automation | test | retry. */
  triggered_by?: "manual" | "automation" | "test" | "retry";
}

function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? "");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorBody(code: SmsErrorCode | string, message: string) {
  return { success: false, code, error: message, message };
}

function nextRetryDelayMs(attempt: number): number {
  // 1m, 5m, 30m
  const ladder = [60_000, 300_000, 1_800_000];
  return ladder[Math.min(attempt, ladder.length - 1)];
}

const fallbackTemplates: Record<string, string> = {
  invoice_posted: "Invoice {{invoice_number}} for {{customer_name}} has been posted. Amount: {{currency}} {{amount}}. Due: {{due_date}}.",
  payment_received: "Payment received from {{customer_name}}: {{currency}} {{amount}}. Reference: {{reference}}.",
  invoice_overdue: "Invoice {{invoice_number}} for {{customer_name}} is overdue by {{days_overdue}} days. Amount: {{currency}} {{amount}}.",
  estimate_sent: "Estimate {{estimate_number}} for {{customer_name}} has been sent. Amount: {{currency}} {{amount}}. Valid until {{valid_until}}.",
  payment_reminder: "Reminder: Invoice {{invoice_number}} for {{customer_name}} is due on {{due_date}}. Amount: {{currency}} {{amount}}.",
  low_stock_alert: "Low stock alert: {{product_name}} has {{current_stock}} left. Reorder level: {{reorder_level}}.",
  out_of_stock: "Out of stock alert: {{product_name}} is out of stock. SKU: {{sku}}.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse(errorBody("UNAUTHORIZED", "Missing bearer token"), 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const token = authHeader.replace("Bearer ", "").trim();

    // Service-role short-circuit: the SMS outbox dispatcher (and other server
    // jobs) call this function with the service-role JWT. Validating that
    // through `auth.getClaims` against the anon client returns "Invalid token"
    // under the new signing-keys system, so accept it explicitly here.
    let isServiceRole = false;
    let userId: string | null = null;

    if (token === serviceKey) {
      isServiceRole = true;
    } else {
      const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: claimsData, error: claimsError } = await supabaseUser.auth.getClaims(token);
      if (claimsError || !claimsData?.claims) {
        return jsonResponse(errorBody("UNAUTHORIZED", "Invalid token"), 401);
      }
      const claims = claimsData.claims;
      isServiceRole = claims.role === "service_role";
      userId = claims.sub ?? null;
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    const body: SendSmsRequest = await req.json();
    const {
      organization_id, business_id, event_type, template_variables,
      custom_message, retry_of_log_id,
      entity_type, entity_id, template_id,
      is_test, triggered_by,
    } = body;
    const rawRecipient = body.recipient_phone;

    if (!organization_id || !rawRecipient) {
      return jsonResponse(errorBody("MISSING_FIELDS", "organization_id and recipient_phone are required"), 400);
    }

    // ── Subscription entitlement ──
    const { checkSubscriptionActive, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
    const subResult = await checkSubscriptionActive(supabaseAdmin, organization_id);
    if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);

    // ── Membership / role ──
    if (!isServiceRole) {
      const { data: userRole } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("organization_id", organization_id)
        .eq("is_active", true)
        .maybeSingle();
      if (!userRole) {
        return jsonResponse(errorBody("PERMISSION_DENIED", "Not a member of this organization"), 403);
      }
      const adminRoles = ["admin", "owner", "super_admin"];
      if (event_type && !adminRoles.includes(userRole.role)) {
        return jsonResponse(errorBody("PERMISSION_DENIED", "Insufficient permissions for event-triggered SMS"), 403);
      }
    }

    // ── Event-rule gate ──
    if (event_type) {
      const { data: rule } = await supabaseAdmin
        .from("sms_event_rules")
        .select("is_enabled")
        .eq("organization_id", organization_id)
        .eq("event_type", event_type)
        .limit(1)
        .maybeSingle();
      if (!rule || !rule.is_enabled) {
        return jsonResponse({ success: false, code: "EVENT_DISABLED", message: "Event rule is disabled or missing" });
      }
    }

    // ── Provider config (prefer business-scoped row, fall back to org-wide) ──
    let configQuery = supabaseAdmin
      .from("sms_provider_configs")
      .select("*")
      .eq("organization_id", organization_id)
      .eq("is_enabled", true);
    if (business_id) {
      configQuery = configQuery.or(`business_id.eq.${business_id},business_id.is.null`);
    }
    const { data: configs } = await configQuery.limit(2);
    // Pick business-scoped row first, else org-wide
    const config = (configs || []).sort((a, b) => {
      if (business_id && a.business_id === business_id) return -1;
      if (business_id && b.business_id === business_id) return 1;
      return 0;
    })[0];

    if (!config) {
      return jsonResponse(errorBody("CONFIG_MISSING", "SMS not configured or disabled for this organization"));
    }

    if (config.provider !== "twilio") {
      return jsonResponse(errorBody("PROVIDER_UNSUPPORTED", `Unsupported SMS provider: ${config.provider}`));
    }

    const mode: SmsMode = config.provider_mode === "test" ? "test" : "live";

    // ── Phone normalization ──
    const recipient = normalizePhoneE164(rawRecipient);
    if (!recipient) {
      return jsonResponse(errorBody("INVALID_RECIPIENT", "Recipient phone must be in E.164 format (e.g. +14155552671)"));
    }

    // ── Daily limit (atomic) ──
    const { data: newCount, error: counterError } = await supabaseAdmin
      .rpc("sms_increment_daily_counter", { config_id: config.id });
    if (counterError) {
      console.error("[send-sms] Counter error:", counterError);
      return jsonResponse(errorBody("RATE_LIMIT_CHECK_FAILED", "Rate limit check failed"), 500);
    }
    const dailyLimit = config.daily_limit ?? 500;
    if ((newCount as number) > dailyLimit) {
      return jsonResponse(errorBody("RATE_LIMITED", `Daily SMS limit reached (${dailyLimit})`));
    }

    // ── Opt-out check (against normalized form) ──
    const { data: optOut } = await supabaseAdmin
      .from("sms_opt_outs")
      .select("id")
      .eq("organization_id", organization_id)
      .eq("phone_number", recipient)
      .limit(1)
      .maybeSingle();
    if (optOut) {
      return jsonResponse(errorBody("OPTED_OUT", "Recipient is on this organization's opt-out list"));
    }

    // ── Positive-consent check (contacts + employees) ──
    {
      const { data: contactConsent } = await supabaseAdmin
        .from("contacts")
        .select("id, sms_consent")
        .eq("organization_id", organization_id)
        .eq("phone", recipient)
        .limit(1)
        .maybeSingle();
      if (contactConsent && contactConsent.sms_consent === false) {
        return jsonResponse(errorBody("CONSENT_REQUIRED", "Recipient has not consented to SMS"));
      }
      if (!contactConsent) {
        const { data: employeeConsent } = await supabaseAdmin
          .from("employees")
          .select("id, sms_consent")
          .eq("organization_id", organization_id)
          .or(`phone.eq.${recipient},personal_phone.eq.${recipient}`)
          .limit(1)
          .maybeSingle();
        if (employeeConsent && employeeConsent.sms_consent === false) {
          return jsonResponse(errorBody("CONSENT_REQUIRED", "Employee has not consented to SMS"));
        }
      }
    }

    // ── Resolve message body ──
    // Always run substitution so {{placeholders}} render whether the body
    // came from a DB template, a fallback template, or a caller-supplied
    // custom_message (manual SMS dialog, automation retries, test sends).
    let messageBody = custom_message
      ? substituteVariables(custom_message, template_variables || {})
      : "";
    let resolvedTemplateId: string | null = template_id || null;
    if (!messageBody && event_type) {
      const { data: template } = await supabaseAdmin
        .from("sms_templates")
        .select("id, body_template")
        .eq("organization_id", organization_id)
        .eq("event_type", event_type)
        .eq("is_active", true)
        .or(business_id ? `business_id.eq.${business_id},business_id.is.null` : "business_id.is.null")
        .order("business_id", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (template) {
        messageBody = substituteVariables(template.body_template, template_variables || {});
        resolvedTemplateId = resolvedTemplateId || template.id;
      } else if (fallbackTemplates[event_type]) {
        messageBody = substituteVariables(fallbackTemplates[event_type], template_variables || {});
      }
    }
    if (!messageBody) {
      return jsonResponse(errorBody("MESSAGE_EMPTY", "No message body resolved (no custom_message and no active template)"));
    }

    // ── Send via shared provider (single source of truth) ──
    const webhookUrl = `${supabaseUrl}/functions/v1/sms-webhook`;
    const result = await sendSms({
      to: recipient,
      body: messageBody,
      config: {
        account_sid: config.account_sid,
        auth_token: config.auth_token,
        sender_phone: config.sender_phone,
        messaging_service_sid: config.messaging_service_sid,
        provider_mode: mode,
      },
      statusCallbackUrl: webhookUrl,
    });

    // ── Decide outcome ──
    const willRetry = !result.ok && result.permanent === false;
    const logStatus: "sent" | "failed" | "queued" =
      result.ok ? "sent" : (willRetry ? "queued" : "failed");

    const sanitizedError = result.ok ? null : sanitizeForLog(result.message, config.account_sid);
    const errorCode = result.ok ? null : (result.twilio_code != null ? String(result.twilio_code) : result.code);

    // ── Log ──
    if (retry_of_log_id) {
      const { data: prev } = await supabaseAdmin
        .from("sms_log").select("retry_count").eq("id", retry_of_log_id).maybeSingle();
      const updates: Record<string, unknown> = {
        status: logStatus,
        provider_message_id: result.ok ? result.sid : null,
        error_code: errorCode,
        error_message: sanitizedError,
        sent_at: result.ok ? new Date().toISOString() : null,
        cost: result.ok && result.price ? Number(result.price) : null,
        cost_unit: result.ok ? (result.price_unit ?? null) : null,
        retry_count: (prev?.retry_count ?? 0) + 1,
        next_retry_at: willRetry ? new Date(Date.now() + nextRetryDelayMs((prev?.retry_count ?? 0))).toISOString() : null,
      };
      await supabaseAdmin.from("sms_log").update(updates).eq("id", retry_of_log_id);
    } else {
      const inferredTrigger: "manual" | "automation" | "test" | "retry" =
        triggered_by || (is_test ? "test" : (event_type ? "automation" : "manual"));
      await supabaseAdmin.from("sms_log").insert({
        organization_id,
        business_id: business_id || null,
        event_type: event_type || null,
        recipient_phone: recipient,
        from_phone: result.ok ? (result.from ?? config.sender_phone) : config.sender_phone,
        message_body: messageBody,
        status: logStatus,
        provider_mode: mode,
        provider_message_id: result.ok ? result.sid : null,
        error_code: errorCode,
        error_message: sanitizedError,
        cost: result.ok && result.price ? Number(result.price) : null,
        cost_unit: result.ok ? (result.price_unit ?? null) : null,
        sent_at: result.ok ? new Date().toISOString() : null,
        sent_by: isServiceRole ? null : userId,
        direction: "outbound",
        retry_count: 0,
        next_retry_at: willRetry ? new Date(Date.now() + nextRetryDelayMs(0)).toISOString() : null,
        entity_type: entity_type || null,
        entity_id: entity_id || null,
        template_id: resolvedTemplateId,
        is_test: !!is_test,
        triggered_by: inferredTrigger,
      });
    }

    return jsonResponse({
      success: result.ok,
      mode,
      message_sid: result.ok ? result.sid : null,
      status: result.ok ? result.status : logStatus,
      will_retry: willRetry,
      code: result.ok ? null : result.code,
      error: result.ok ? null : sanitizedError,
      message: result.ok ? "SMS dispatched" : (sanitizedError || "SMS send failed"),
    });
  } catch (error) {
    console.error("send-sms error:", error);
    return jsonResponse(errorBody("INTERNAL_ERROR", "Internal error"), 500);
  }
});
