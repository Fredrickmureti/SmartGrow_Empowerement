import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logEmailSend } from "../_shared/email/sendLog.ts";
import { resolveSenderIdentity, type SenderCategory } from "../_shared/branding/resolveSenderIdentity.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Email category model — controls Reply-To resolution.
 * Different email types must NOT share a single global Reply-To.
 */
type EmailCategory =
  | "system_notification"
  | "tenant_document"
  | "user_invitation"
  | "vendor_portal"
  | "platform_admin"
  | "support"
  | "auth";

const TENANT_FACING_CATEGORIES: ReadonlySet<EmailCategory> = new Set([
  "tenant_document",
  "system_notification",
  "user_invitation",
  "vendor_portal",
]);

interface SendEmailRequest {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from_name?: string;
  category?: EmailCategory;
  tenant_reply_to?: string | null;
  /** Tenant context — used to resolve From-name when from_name is omitted. */
  organization_id?: string | null;
  business_id?: string | null;
  branch_id?: string | null;
  attachments?: Array<{ filename: string; content: string; encoding?: string }>;
  // Optional logging context — when present we persist to platform_email_logs.
  template_key?: string | null;
  recipient_user_id?: string | null;
  recipient_org_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let request: SendEmailRequest;
  try {
    request = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { to, subject, html, text, attachments, from_name, tenant_reply_to,
    organization_id, business_id, branch_id,
    template_key, recipient_user_id, recipient_org_id, metadata } = request;
  const category: EmailCategory = request.category ?? "system_notification";

  if (!to || !subject || !html) {
    return new Response(JSON.stringify({ error: "Missing required fields: to, subject, html" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    // Pull scoped Reply-To settings. The legacy unscoped `resend_reply_to_email`
    // is intentionally NOT read — it leaked the platform admin's personal
    // address onto every email.
    const { data: settings } = await supabase
      .from("platform_settings")
      .select("setting_key, setting_value")
      .in("setting_key", [
        "resend_api_key",
        "resend_from_email",
        "resend_from_name",
        "support_reply_to_email",
        "platform_admin_reply_to_email",
      ]);

    const settingsMap = (settings || []).reduce((acc: Record<string, string>, s: { setting_key: string; setting_value: string | null }) => {
      if (s.setting_value) acc[s.setting_key] = s.setting_value;
      return acc;
    }, {});

    // Prefer the platform_settings value; fall back to the RESEND_API_KEY
    // function secret so a deployment can work without a DB row.
    const resendApiKey = settingsMap.resend_api_key || Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      console.error("[send-email] No Resend API key configured");
      await logEmailSend(supabase, {
        template_key, recipient_email: to, recipient_user_id, recipient_org_id,
        subject, status: "failed", error_message: "missing_resend_api_key",
        metadata: { ...(metadata || {}), category },
      });
      return new Response(JSON.stringify({ error: "Email provider not configured." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const fromEmail = settingsMap.resend_from_email || "noreply@accrualflow.systems";
    const platformFromName = settingsMap.resend_from_name || "AccrualFlow";

    // ─── Sender identity resolution ──────────────────────────────────
    // Tenant-facing categories MUST resolve their From-name from the
    // tenant's business identity. The platform name is ONLY used for
    // platform-level categories (platform_admin/support/auth) — it must
    // never silently leak onto tenant mail. See ADR 0023.
    let senderName = from_name?.trim() || "";
    let senderSource: string = from_name?.trim() ? "explicit" : "platform";
    let resolvedTenantReplyTo: string | null = tenant_reply_to?.trim() || null;

    if (!senderName && TENANT_FACING_CATEGORIES.has(category) && (organization_id || business_id)) {
      try {
        const resolved = await resolveSenderIdentity(supabase, {
          organization_id: organization_id ?? null,
          business_id: business_id ?? null,
          branch_id: branch_id ?? null,
          category: category as SenderCategory,
        });
        senderName = resolved.from_name;
        senderSource = resolved.source;
        if (!resolvedTenantReplyTo) resolvedTenantReplyTo = resolved.reply_to;
      } catch (e) {
        console.warn("[send-email] resolveSenderIdentity failed:", (e as Error).message);
      }
    }

    if (!senderName) {
      // Last resort. Only acceptable for platform categories; for tenant
      // categories this means the caller failed to pass any tenant context.
      senderName = platformFromName;
      senderSource = "platform";
      if (TENANT_FACING_CATEGORIES.has(category)) {
        console.warn(
          `[send-email] tenant-facing category=${category} resolved to platform name — caller did not provide organization_id/business_id or from_name`,
        );
      }
    }

    // Reply-To resolver — strict per category. No global fallback.
    let replyTo: string | null = null;
    switch (category) {
      case "tenant_document":
      case "system_notification":
      case "vendor_portal":
        replyTo = resolvedTenantReplyTo;
        break;
      case "user_invitation":
      case "support":
        replyTo = settingsMap.support_reply_to_email || null;
        break;
      case "platform_admin":
        replyTo = settingsMap.platform_admin_reply_to_email || null;
        break;
      case "auth":
      default:
        replyTo = null;
        break;
    }


    const emailPayload: Record<string, unknown> = {
      from: `${senderName} <${fromEmail}>`,
      to: [to],
      subject,
      html,
    };
    if (text) emailPayload.text = text;
    if (replyTo) emailPayload.reply_to = replyTo;
    if (attachments && attachments.length > 0) emailPayload.attachments = attachments;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload),
    });

    const responseText = await response.text();
    let resendResult: { id?: string } = {};
    try { resendResult = JSON.parse(responseText); } catch { /* ignore */ }

    if (!response.ok) {
      console.error(`[send-email] Resend error (category=${category}):`, responseText);
      await logEmailSend(supabase, {
        template_key, recipient_email: to, recipient_user_id, recipient_org_id,
        subject, status: "failed", reply_to: replyTo,
        error_message: responseText.slice(0, 1000),
        metadata: { ...(metadata || {}), category, from: emailPayload.from, sender_source: senderSource },
      });
      return new Response(JSON.stringify({ error: responseText }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[send-email] Sent id=${resendResult.id} to=${to} category=${category} sender_source=${senderSource} reply_to=${replyTo ?? "(none)"}`);

    await logEmailSend(supabase, {
      template_key, recipient_email: to, recipient_user_id, recipient_org_id,
      subject, status: "sent", reply_to: replyTo, resend_id: resendResult.id ?? null,
      metadata: { ...(metadata || {}), category, from: emailPayload.from, sender_source: senderSource },
    });

    return new Response(
      JSON.stringify({ success: true, id: resendResult.id, category, reply_to: replyTo, sender_source: senderSource }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("[send-email] Error:", error);
    await logEmailSend(supabase, {
      template_key, recipient_email: to, recipient_user_id, recipient_org_id,
      subject, status: "failed",
      error_message: error instanceof Error ? error.message : String(error),
      metadata: { ...(metadata || {}), category },
    });
    return new Response(JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
