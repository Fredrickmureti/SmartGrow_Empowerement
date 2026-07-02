import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requirePlatformAdmin } from "../_shared/requirePlatformAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface AdminEmailRequest {
  recipients: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content: string; // base64-encoded file contents
    contentType?: string;
  }>;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Centralised platform-admin gate.
  let supabase: Awaited<ReturnType<typeof requirePlatformAdmin>>["admin"];
  try {
    const ctx = await requirePlatformAdmin(req);
    supabase = ctx.admin;
  } catch (e) {
    if (e instanceof Response) {
      const body = await e.text();
      return new Response(body, {
        status: e.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    throw e;
  }

  try {

    // Fetch email settings
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
      return new Response(JSON.stringify({ error: "Email provider not configured" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fromEmail = settingsMap.resend_from_email || "noreply@accrualflow.systems";
    const fromName = settingsMap.resend_from_name || "AccrualFlow";
    // Reply-To for platform-admin manual emails ONLY. Notifications never use this.
    const defaultReplyTo = settingsMap.platform_admin_reply_to_email;

    const { recipients, subject, body, isHtml, cc, bcc, replyTo, attachments }: AdminEmailRequest = await req.json();

    if (!recipients?.length || !subject || !body) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate attachments size (Resend caps total payload ~40MB; be conservative at 20MB total)
    if (attachments && attachments.length) {
      let totalBytes = 0;
      for (const att of attachments) {
        if (!att.filename || !att.content) {
          return new Response(JSON.stringify({ error: "Each attachment requires filename and base64 content" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // base64 length * 0.75 ≈ byte size
        totalBytes += Math.floor(att.content.length * 0.75);
      }
      if (totalBytes > 20 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: "Total attachments exceed 20MB limit" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Send email via Resend API
    const emailPayload: any = {
      from: `${fromName} <${fromEmail}>`,
      to: recipients,
      subject,
    };

    if (isHtml) {
      emailPayload.html = body;
    } else {
      emailPayload.text = body;
    }

    if (replyTo) {
      emailPayload.reply_to = replyTo;
    } else if (defaultReplyTo) {
      emailPayload.reply_to = defaultReplyTo;
    }

    if (cc?.length) emailPayload.cc = cc;
    if (bcc?.length) emailPayload.bcc = bcc;

    if (attachments?.length) {
      emailPayload.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: a.content, // Resend accepts base64 string
        ...(a.contentType ? { content_type: a.contentType } : {}),
      }));
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Resend error:", errorText);
      return new Response(JSON.stringify({ error: errorText }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const emailResult = await response.json();
    console.log("Admin email sent successfully:", emailResult);

    return new Response(JSON.stringify({ success: true, id: emailResult?.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Error in send-admin-email:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};

serve(handler);
