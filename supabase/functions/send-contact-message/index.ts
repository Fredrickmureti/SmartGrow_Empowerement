import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ContactMessageRequest {
  name: string;
  email: string;
  company?: string;
  topic: string;
  message: string;
}

interface PlatformSetting {
  setting_key: string;
  setting_value: string | null;
}

const topicLabels: Record<string, string> = {
  general: "General Inquiry",
  sales: "Sales & Pricing",
  support: "Technical Support",
  billing: "Billing & Payments",
  partnership: "Partnership Opportunities",
  feedback: "Product Feedback",
};

async function getPlatformSettings(supabaseClient: any): Promise<Map<string, string | null>> {
  const { data, error } = await supabaseClient
    .from("platform_settings")
    .select("setting_key, setting_value");

  if (error) {
    console.error("Error fetching platform settings:", error);
    throw new Error("Failed to fetch email configuration");
  }

  const settings = new Map<string, string | null>();
  (data as PlatformSetting[]).forEach((s) => {
    settings.set(s.setting_key, s.setting_value);
  });
  return settings;
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  // For href/mailto values: drop quotes/CR/LF and percent-encode minimally
  return escapeHtml(String(s ?? "").replace(/[\r\n"]/g, ""));
}

function generateNotificationEmailHtml(data: ContactMessageRequest): string {
  const topicLabel = topicLabels[data.topic] || data.topic;
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Contact Form Submission</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
      <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        <div style="background: linear-gradient(135deg, #7c3aed, #06b6d4); color: white; padding: 24px; text-align: center;">
          <h1 style="margin: 0; font-size: 24px;">New Contact Form Submission</h1>
        </div>
        
        <div style="padding: 24px;">
          <div style="background: #f9f9f9; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #666; font-weight: 600;">Name:</td>
                <td style="padding: 8px 0;">${escapeHtml(data.name)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666; font-weight: 600;">Email:</td>
                <td style="padding: 8px 0;"><a href="mailto:${escapeAttr(data.email)}" style="color: #7c3aed;">${escapeHtml(data.email)}</a></td>
              </tr>
              ${data.company ? `
              <tr>
                <td style="padding: 8px 0; color: #666; font-weight: 600;">Company:</td>
                <td style="padding: 8px 0;">${escapeHtml(data.company)}</td>
              </tr>
              ` : ""}
              <tr>
                <td style="padding: 8px 0; color: #666; font-weight: 600;">Topic:</td>
                <td style="padding: 8px 0;"><span style="background: #7c3aed; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">${escapeHtml(topicLabel)}</span></td>
              </tr>
            </table>
          </div>
          
          <h3 style="margin: 0 0 12px; color: #333;">Message:</h3>
          <div style="background: #f9f9f9; border-radius: 6px; padding: 16px; white-space: pre-wrap; color: #333; line-height: 1.6;">
${escapeHtml(data.message)}
          </div>
          
          <div style="margin-top: 24px; text-align: center;">
            <a href="mailto:${escapeAttr(data.email)}?subject=Re: ${escapeAttr(topicLabel)}" style="display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
              Reply to ${escapeHtml(data.name)}
            </a>
          </div>
        </div>
        
        <div style="background: #f9f9f9; padding: 16px 24px; text-align: center; color: #999; font-size: 12px;">
          <p style="margin: 0;">This message was sent from the AccrualFlow contact form</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function generateConfirmationEmailHtml(data: ContactMessageRequest): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>We've received your message</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
      <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        <div style="background: linear-gradient(135deg, #7c3aed, #06b6d4); color: white; padding: 24px; text-align: center;">
          <h1 style="margin: 0; font-size: 24px;">Thanks for reaching out!</h1>
        </div>
        
        <div style="padding: 24px;">
          <p style="color: #333; font-size: 16px; line-height: 1.6;">
            Hi ${escapeHtml(data.name)},
          </p>
          <p style="color: #666; line-height: 1.6;">
            We've received your message and our team will get back to you within 24 hours. 
            Here's a copy of what you sent:
          </p>
          
          <div style="background: #f9f9f9; border-radius: 6px; padding: 16px; margin: 20px 0; border-left: 4px solid #7c3aed;">
            <p style="color: #333; white-space: pre-wrap; margin: 0; line-height: 1.6;">${escapeHtml(data.message)}</p>
          </div>
          
          <p style="color: #666; line-height: 1.6;">
            In the meantime, feel free to explore our <a href="https://accrualflow.com/features" style="color: #7c3aed;">features</a> 
            or check out our <a href="https://accrualflow.com/help" style="color: #7c3aed;">help center</a>.
          </p>
          
          <p style="color: #333; margin-top: 24px;">
            Best regards,<br>
            <strong>The AccrualFlow Team</strong>
          </p>
        </div>
        
        <div style="background: #f9f9f9; padding: 16px 24px; text-align: center; color: #999; font-size: 12px;">
          <p style="margin: 0;">AccrualFlow - Modern Financial Management</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);

    const { name, email, company, topic, message }: ContactMessageRequest = await req.json();

    // Validate required fields
    if (!name || !email || !topic || !message) {
      throw new Error("Missing required fields: name, email, topic, and message are required");
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new Error("Invalid email address");
    }

    // Validate message length
    if (message.length > 5000) {
      throw new Error("Message is too long (max 5000 characters)");
    }

    // Get platform settings
    const settings = await getPlatformSettings(supabaseClient);
    const resendApiKey = settings.get("resend_api_key");
    const fromEmail = settings.get("resend_from_email") || "noreply@accrualflow.systems";
    const fromName = settings.get("resend_from_name") || "AccrualFlow";
    const supportEmail = settings.get("support_email") || "support@accrualflow.systems";

    if (!resendApiKey) {
      throw new Error("Email provider is not configured");
    }

    const resend = new Resend(resendApiKey);
    const topicLabel = topicLabels[topic] || topic;

    // Send notification email to support team
    const notificationResult = await resend.emails.send({
      from: `${fromName} Contact Form <${fromEmail}>`,
      to: [supportEmail],
      reply_to: email,
      subject: `[Contact Form] ${topicLabel} from ${name}`,
      html: generateNotificationEmailHtml({ name, email, company, topic, message }),
    });

    console.log("Notification email sent:", notificationResult);

    // Send confirmation email to user
    const confirmationResult = await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to: [email],
      subject: "We've received your message - AccrualFlow",
      html: generateConfirmationEmailHtml({ name, email, company, topic, message }),
    });

    console.log("Confirmation email sent:", confirmationResult);

    // Log the contact submission (optional - table may not exist)
    try {
      await supabaseClient.from("contact_submissions").insert({
        name,
        email,
        company: company || null,
        topic,
        message,
        status: "new",
      });
    } catch (err) {
      // Table might not exist, that's ok - just log the error
      console.log("Could not log contact submission:", err);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Message sent successfully" 
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  } catch (error: unknown) {
    console.error("Error in send-contact-message function:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
