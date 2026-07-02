import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getOrganizationBranding } from "../_shared/branding/index.ts";
import { resolveNotificationDeepLink, resolveAppBaseUrl } from "../_shared/email/deepLink.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface NotificationEmailRequest {
  user_id: string;
  organization_id: string;
  business_id?: string | null;
  category: string;
  title: string;
  message: string;
  link?: string;
  entity_type?: string;
  entity_id?: string;
  notification_id?: string;
}

// Deep link resolution moved to ../_shared/email/deepLink.ts so every
// outbound notification path uses the same canonical CTA resolver.

const escapeHtml = (s: string) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const nl2br = (s: string) => escapeHtml(s).replace(/\n/g, "<br/>");

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const request: NotificationEmailRequest = await req.json();
    const { user_id, organization_id, business_id, category, title, message, link, entity_type, entity_id, notification_id } = request;

    // Resolve absolute app base URL once (used to build clickable deep links).
    const appBaseUrl = await resolveAppBaseUrl(supabase, supabaseUrl);

    if (!user_id || !organization_id || !category || !title || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: user_id, organization_id, category, title, message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { checkSubscriptionActive, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
    const subResult = await checkSubscriptionActive(supabase, organization_id);
    if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);

    console.log(`[send-notification-email] Processing user=${user_id} category=${category} business=${business_id ?? "(primary)"}`);

    // 1. Notification preferences
    const { data: pref } = await supabase
      .from("notification_preferences")
      .select("email_enabled")
      .eq("user_id", user_id)
      .eq("organization_id", organization_id)
      .eq("category", category)
      .maybeSingle();

    if (!(pref?.email_enabled ?? true)) {
      return new Response(JSON.stringify({ success: true, skipped: true, reason: "email_disabled" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. Recipient profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("email, full_name")
      .eq("user_id", user_id)
      .single();

    if (!profile?.email) {
      return new Response(JSON.stringify({ success: true, skipped: true, reason: "no_email" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 3. Business branding (the legal entity that owns the event)
    const branding = await getOrganizationBranding(supabase, organization_id, business_id ?? null);

    // 4. Org name fallback
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", organization_id)
      .single();

    // Prefer the tenant's email display-name override; fall back to legal/trading name,
    // then org name. Never the platform name for a tenant-facing notification.
    const businessName =
      branding?.email_display_name ||
      branding?.legal_name ||
      branding?.name ||
      org?.name ||
      "Your Business";
    const tenantReplyTo = branding?.email_reply_to || branding?.email || null;
    const userName = profile.full_name?.split(" ")[0] || "there";
    const logoUrl = branding?.logo_url || null;
    const addressParts = [branding?.address, branding?.city, branding?.state, branding?.postal_code, branding?.country].filter(Boolean);
    const fullAddress = addressParts.join(", ");
    const contactBits = [branding?.email, branding?.phone].filter(Boolean);

    // 5. Category visual config
    const categoryConfig: Record<string, { color: string; icon: string; label: string }> = {
      invoices: { color: "#2563eb", icon: "📄", label: "Invoice" },
      payments: { color: "#16a34a", icon: "💰", label: "Payment" },
      inventory: { color: "#f59e0b", icon: "📦", label: "Inventory" },
      expenses: { color: "#dc2626", icon: "💳", label: "Expense" },
      team: { color: "#7c3aed", icon: "👥", label: "Team" },
      pos: { color: "#0891b2", icon: "🛒", label: "Point of Sale" },
      system: { color: "#6b7280", icon: "⚙️", label: "System" },
      leave: { color: "#059669", icon: "🏖️", label: "Leave" },
      timesheets: { color: "#d97706", icon: "⏱️", label: "Timesheet" },
      payslips: { color: "#4f46e5", icon: "💵", label: "Payslip" },
      loan: { color: "#0d9488", icon: "🏦", label: "Loan" },
    };
    const cfg = categoryConfig[category] || { color: "#475569", icon: "🔔", label: category };

    // 6. Branded HTML
    const safeTitle = escapeHtml(title);
    const safeMessage = nl2br(message);
    const safeBusiness = escapeHtml(businessName);
    const safeUser = escapeHtml(userName);
    const safeAddress = escapeHtml(fullAddress);
    const safeContact = contactBits.map(escapeHtml).join(" • ");
    const safeTaxId = branding?.tax_id ? escapeHtml(branding.tax_id) : "";

    const headerLogo = logoUrl
      ? `<img src="${escapeHtml(logoUrl)}" alt="${safeBusiness}" style="max-height:48px;max-width:180px;display:block;margin:0 auto 12px;" />`
      : `<div style="width:48px;height:48px;border-radius:12px;background:${cfg.color};color:#fff;font-weight:700;font-size:20px;line-height:48px;text-align:center;margin:0 auto 12px;">${safeBusiness.charAt(0).toUpperCase()}</div>`;

    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
        <!-- Brand header -->
        <tr><td style="padding:28px 32px 20px;text-align:center;border-bottom:1px solid #f1f5f9;background:linear-gradient(180deg,#ffffff 0%,#fafafa 100%);">
          ${headerLogo}
          <div style="font-size:16px;font-weight:600;color:#111827;letter-spacing:-0.01em;">${safeBusiness}</div>
          ${fullAddress ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">${safeAddress}</div>` : ""}
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px;">
          <div style="display:inline-block;padding:4px 10px;border-radius:9999px;background:${cfg.color}15;color:${cfg.color};font-weight:600;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:14px;">
            ${cfg.icon} ${escapeHtml(cfg.label)}
          </div>
          <h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;color:#0f172a;font-weight:700;letter-spacing:-0.01em;">${safeTitle}</h1>
          <p style="margin:0 0 20px;color:#475569;font-size:14px;">Hi ${safeUser},</p>

          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid ${cfg.color};border-radius:8px;padding:18px 20px;color:#1f2937;font-size:15px;line-height:1.6;">
            ${safeMessage}
          </div>

          ${(() => {
            const cta = resolveNotificationDeepLink({
              baseUrl: appBaseUrl,
              category,
              entity_type,
              entity_id,
              link,
              notification_id,
            });
            return `
            <div style="margin-top:24px;text-align:center;">
              <a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 24px;background:${cfg.color};color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
                ${escapeHtml(cta.label)} →
              </a>
            </div>`;
          })()}
        </td></tr>

        <!-- Brand footer -->
        <tr><td style="padding:20px 32px 28px;background:#fafafa;border-top:1px solid #f1f5f9;text-align:center;">
          <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:4px;">${safeBusiness}</div>
          ${safeContact ? `<div style="font-size:12px;color:#6b7280;margin-bottom:4px;">${safeContact}</div>` : ""}
          ${safeTaxId ? `<div style="font-size:11px;color:#9ca3af;margin-bottom:8px;">Tax ID: ${safeTaxId}</div>` : ""}
          <div style="font-size:11px;color:#9ca3af;margin-top:10px;line-height:1.5;">
            You're receiving this because you have notifications enabled for ${safeBusiness}.<br/>
            <a href="${escapeHtml(appBaseUrl.replace(/\/+$/, ""))}/settings?tab=notifications" style="color:#6b7280;text-decoration:underline;">Manage notification preferences</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

    const subject = `${cfg.icon} ${title} — ${businessName}`;

    // System notifications must NEVER use a platform-admin Reply-To.
    // Pass an explicit category + organization_id + business_id so
    // send-email's resolveSenderIdentity picks the proper
    // email_display_name → legal_name → name tier. Do NOT pass an explicit
    // from_name here — it would short-circuit the resolver and risk
    // downgrading the From-line vs. the centralized rules (ADR 0023).
    const { error: emailError } = await supabase.functions.invoke("send-email", {
      body: {
        to: profile.email,
        subject,
        html,
        tenant_reply_to: tenantReplyTo,
        category: "system_notification",
        organization_id,
        business_id: business_id ?? branding?.id ?? null,
        template_key: `notification:${category}`,
        recipient_user_id: user_id,
        recipient_org_id: organization_id,
        metadata: {
          notification_id: notification_id ?? null,
          entity_type: entity_type ?? null,
          entity_id: entity_id ?? null,
          business_id: business_id ?? null,
        },
      },
    });

    if (emailError) {
      console.error(`[send-notification-email] Failed to send to ${profile.email}:`, emailError);
      return new Response(
        JSON.stringify({ error: "Failed to send email", details: emailError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[send-notification-email] Sent to ${profile.email} (business: ${businessName})`);

    return new Response(
      JSON.stringify({ success: true, sent_to: profile.email, business: businessName, category }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("[send-notification-email] Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
