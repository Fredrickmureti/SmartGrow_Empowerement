import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface SendEmailRequest {
  to: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  templateKey?: string;
  templateId?: string;
  campaignId?: string;
  ruleId?: string;
  recipientUserId?: string;
  recipientOrgId?: string;
  variables?: Record<string, string>;
}

// Replace template variables like {{variable_name}}
function replaceVariables(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(regex, value || '');
  }
  return result;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch email settings from platform_settings
    const { data: settings } = await supabase
      .from("platform_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["resend_api_key", "resend_from_email", "resend_from_name", "platform_admin_reply_to_email"]);

    const settingsMap = (settings || []).reduce((acc: Record<string, string>, s) => {
      if (s.setting_value) acc[s.setting_key] = s.setting_value;
      return acc;
    }, {});

    const resendApiKey = settingsMap.resend_api_key;
    if (!resendApiKey) {
      console.error("[send-platform-email] No Resend API key configured");
      return new Response(
        JSON.stringify({ error: "Email provider not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const fromEmail = settingsMap.resend_from_email || "noreply@accrualflow.systems";
    const fromName = settingsMap.resend_from_name || "AccrualFlow";
    // Platform-admin Reply-To (scoped). Notifications never use this.
    const replyTo = settingsMap.platform_admin_reply_to_email;

    const request: SendEmailRequest = await req.json();
    
    let { to, subject, htmlBody, textBody, templateKey, templateId, campaignId, ruleId, recipientUserId, recipientOrgId, variables } = request;

    // If templateKey or templateId provided, fetch template
    if (templateKey || templateId) {
      const query = templateId 
        ? supabase.from("platform_email_templates").select("*").eq("id", templateId).single()
        : supabase.from("platform_email_templates").select("*").eq("template_key", templateKey).single();
      
      const { data: template, error: templateError } = await query;
      
      if (templateError || !template) {
        console.error("[send-platform-email] Template not found:", templateKey || templateId);
        return new Response(
          JSON.stringify({ error: "Template not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      subject = subject || template.subject;
      htmlBody = htmlBody || template.html_body;
      textBody = textBody || template.text_body;
    }

    // Replace variables in subject and body
    if (variables) {
      subject = replaceVariables(subject, variables);
      htmlBody = replaceVariables(htmlBody, variables);
      if (textBody) textBody = replaceVariables(textBody, variables);
    }

    // Create log entry
    const { data: logEntry, error: logError } = await supabase
      .from("platform_email_logs")
      .insert({
        recipient_email: to,
        recipient_user_id: recipientUserId || null,
        recipient_org_id: recipientOrgId || null,
        template_key: templateKey || null,
        template_id: templateId || null,
        campaign_id: campaignId || null,
        rule_id: ruleId || null,
        subject,
        status: "pending",
      })
      .select()
      .single();

    if (logError) {
      console.warn("[send-platform-email] Failed to create log entry:", logError);
    }

    // Send email via Resend
    const emailPayload: Record<string, unknown> = {
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject,
      html: htmlBody,
    };

    if (textBody) {
      emailPayload.text = textBody;
    }

    if (replyTo) {
      emailPayload.reply_to = replyTo;
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailPayload),
    });

    const responseText = await response.text();
    let resendResult: { id?: string } = {};
    try {
      resendResult = JSON.parse(responseText);
    } catch {
      console.error("[send-platform-email] Failed to parse Resend response:", responseText);
    }

    if (!response.ok) {
      console.error("[send-platform-email] Resend error:", responseText);
      
      // Update log with error
      if (logEntry) {
        await supabase
          .from("platform_email_logs")
          .update({ status: "failed", error_message: responseText })
          .eq("id", logEntry.id);
      }

      return new Response(
        JSON.stringify({ error: responseText }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update log with success
    if (logEntry) {
      await supabase
        .from("platform_email_logs")
        .update({ 
          status: "sent", 
          sent_at: new Date().toISOString(),
          resend_id: resendResult.id || null,
        })
        .eq("id", logEntry.id);
    }

    console.log("[send-platform-email] Email sent successfully:", resendResult.id);

    return new Response(
      JSON.stringify({ success: true, id: resendResult.id, logId: logEntry?.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("[send-platform-email] Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
