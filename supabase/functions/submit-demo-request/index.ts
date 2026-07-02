import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Sanitize values used inside attribute URIs (mailto:, tel:) — strip CR/LF
// and quote characters so they cannot break out of the attribute.
function escapeAttr(s: unknown): string {
  return escapeHtml(String(s ?? "").replace(/[\r\n"'<>]/g, ""));
}

interface DemoRequest {
  fullName: string;
  email: string;
  companyName?: string;
  phone?: string;
  message?: string;
}

// Simple rate limiting using in-memory store (resets on function cold start)
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 5; // max requests
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour in ms

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);
  
  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return false;
  }
  
  if (record.count >= RATE_LIMIT) {
    return true;
  }
  
  record.count++;
  return false;
}

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Rate limiting
    const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown";
    if (isRateLimited(clientIp)) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { fullName, email, companyName, phone, message }: DemoRequest = await req.json();

    // Validate required fields
    if (!fullName || fullName.length < 2 || fullName.length > 100) {
      return new Response(
        JSON.stringify({ error: "Full name is required and must be 2-100 characters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email) || email.length > 255) {
      return new Response(
        JSON.stringify({ error: "A valid email address is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initialize Supabase client with service role for inserting
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Insert demo request into database
    const { data: demoRequest, error: insertError } = await supabase
      .from("demo_requests")
      .insert({
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        company_name: companyName?.trim() || null,
        phone: phone?.trim() || null,
        message: message?.trim() || null,
        status: "pending",
      })
      .select()
      .single();

    if (insertError) {
      console.error("Error inserting demo request:", insertError);
      throw new Error("Failed to save demo request");
    }

    console.log("Demo request saved:", demoRequest.id);

    // Fetch email settings from platform_settings (dynamic configuration)
    const { data: settings } = await supabase
      .from("platform_settings")
      .select("setting_key, setting_value")
      .in("setting_key", [
        "resend_api_key",
        "resend_from_email", 
        "resend_from_name",
        "support_reply_to_email",
        "website_url",
        "platform_name"
      ]);

    const settingsMap = (settings || []).reduce((acc: Record<string, string>, s) => {
      if (s.setting_value) acc[s.setting_key] = s.setting_value;
      return acc;
    }, {});

    const resendApiKey = settingsMap.resend_api_key;
    const fromEmail = settingsMap.resend_from_email || "noreply@accrualflow.systems";
    const fromName = settingsMap.resend_from_name || "AccrualFlow";
    // Demo requests are support inquiries — use scoped support Reply-To.
    const replyTo = settingsMap.support_reply_to_email;
    const appUrl = settingsMap.website_url || "https://accrualflow.systems";
    const platformName = settingsMap.platform_name || "AccrualFlow";

    if (!resendApiKey) {
      console.log("Email provider not configured, skipping emails");
      return new Response(
        JSON.stringify({ success: true, message: "Demo request submitted successfully" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get platform admin emails
    const { data: admins } = await supabase
      .from("platform_admins")
      .select("user_id")
      .eq("is_active", true);

    let adminEmails: string[] = [];
    if (admins && admins.length > 0) {
      const adminUserIds = admins.map(a => a.user_id);
      
      // Get admin emails from profiles table
      const { data: profiles } = await supabase
        .from("profiles")
        .select("email")
        .in("id", adminUserIds);
      
      if (profiles) {
        adminEmails = profiles.map(p => p.email).filter(Boolean) as string[];
      }
    }

    // Send notification to platform admins
    if (adminEmails.length > 0) {
      const safeFullName = escapeHtml(fullName);
      const safeEmail = escapeHtml(email);
      const safeEmailAttr = escapeAttr(email);
      const safeCompany = escapeHtml(companyName ?? "");
      const safePhone = escapeHtml(phone ?? "");
      const safePhoneAttr = escapeAttr(phone ?? "");
      const safeMessage = escapeHtml(message ?? "");
      const safePlatformName = escapeHtml(platformName);
      const safeAppUrl = escapeAttr(appUrl);

      const adminEmailPayload: any = {
        from: `${fromName} <${fromEmail}>`,
        to: adminEmails,
        subject: `New Demo Request from ${safeFullName}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 24px;">New Demo Request</h1>
            </div>
            
            <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
              <p style="margin: 0 0 20px; color: #374151;">You have received a new demo request:</p>
              
              <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Name:</td>
                    <td style="padding: 8px 0; color: #111827; font-weight: 500;">${safeFullName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Email:</td>
                    <td style="padding: 8px 0; color: #111827; font-weight: 500;">
                      <a href="mailto:${safeEmailAttr}" style="color: #667eea;">${safeEmail}</a>
                    </td>
                  </tr>
                  ${companyName ? `
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Company:</td>
                    <td style="padding: 8px 0; color: #111827; font-weight: 500;">${safeCompany}</td>
                  </tr>
                  ` : ""}
                  ${phone ? `
                  <tr>
                    <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Phone:</td>
                    <td style="padding: 8px 0; color: #111827; font-weight: 500;">
                      <a href="tel:${safePhoneAttr}" style="color: #667eea;">${safePhone}</a>
                    </td>
                  </tr>
                  ` : ""}
                </table>
                
                ${message ? `
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
                  <p style="margin: 0 0 8px; color: #6b7280; font-size: 14px;">Message:</p>
                  <p style="margin: 0; color: #111827; white-space: pre-wrap;">${safeMessage}</p>
                </div>
                ` : ""}
              </div>
              
              <div style="margin-top: 24px; text-align: center;">
                <a href="${safeAppUrl}/admin-management/demo-requests" 
                   style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 500;">
                  View in Admin Panel
                </a>
              </div>
            </div>
            
            <div style="padding: 20px; text-align: center; color: #9ca3af; font-size: 12px;">
              This is an automated message from ${safePlatformName}.
            </div>
          </div>
        `,
      };

      if (replyTo) {
        adminEmailPayload.reply_to = replyTo;
      }


      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(adminEmailPayload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("Failed to send admin notification:", errorText);
        } else {
          console.log("Admin notification email sent");
        }
      } catch (emailError) {
        console.error("Error sending admin email:", emailError);
      }
    }

    // Send confirmation to the requester
    const safeFullNameUser = escapeHtml(fullName);
    const safePlatformNameUser = escapeHtml(platformName);
    const safeAppUrlUser = escapeAttr(appUrl);
    const userEmailPayload: any = {
      from: `${fromName} <${fromEmail}>`,
      to: [email],
      subject: `Thanks for your interest in ${platformName}!`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 24px;">Thank You, ${safeFullNameUser}!</h1>
          </div>
          
          <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
            <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.6;">
              We've received your demo request and our team will reach out to you within 24-48 hours to schedule a personalized walkthrough.
            </p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 24px 0;">
              <p style="margin: 0 0 16px; color: #374151;">In the meantime, you can:</p>
              <ul style="margin: 0; padding-left: 20px; color: #374151;">
                <li style="margin-bottom: 8px;">
                  <a href="${safeAppUrlUser}/demo" style="color: #667eea;">Watch our product overview video</a>
                </li>
                <li style="margin-bottom: 8px;">
                  <a href="${safeAppUrlUser}/signup" style="color: #667eea;">Start a free trial</a>
                </li>
              </ul>
            </div>
            
            <p style="margin: 0; color: #374151; font-size: 16px; line-height: 1.6;">
              We look forward to showing you how ${safePlatformNameUser} can transform your business accounting!
            </p>
            
            <p style="margin: 24px 0 0; color: #374151;">
              Best regards,<br/>
              <strong>The ${safePlatformNameUser} Team</strong>
            </p>
          </div>
          
          <div style="padding: 20px; text-align: center; color: #9ca3af; font-size: 12px;">
            If you didn't request this demo, please ignore this email.
          </div>
        </div>
      `,
    };


    if (replyTo) {
      userEmailPayload.reply_to = replyTo;
    }

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(userEmailPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Failed to send confirmation email:", errorText);
      } else {
        console.log("Confirmation email sent to requester");
      }
    } catch (emailError) {
      console.error("Error sending confirmation email:", emailError);
    }

    return new Response(
      JSON.stringify({ success: true, message: "Demo request submitted successfully" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error in submit-demo-request:", error);
    return new Response(
      JSON.stringify({ error: error.message || "An unexpected error occurred" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

serve(handler);
