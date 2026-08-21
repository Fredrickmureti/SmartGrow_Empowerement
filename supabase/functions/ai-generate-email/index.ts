import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface GenerateEmailRequest {
  action: "generate" | "improve" | "translate" | "html_beautify" | "subject_suggestions";
  emailType?: "welcome" | "reengagement" | "announcement" | "maintenance" | "custom";
  currentContent?: string;
  prompt?: string;
  targetLanguage?: string;
  variables?: Record<string, string>;
  tone?: "professional" | "friendly" | "marketing" | "urgent";
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify platform admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: adminData } = await supabase
      .from("platform_admins")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .single();

    if (!adminData) {
      return new Response(JSON.stringify({ error: "Forbidden: Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action, emailType, currentContent, prompt, targetLanguage, variables, tone } = await req.json() as GenerateEmailRequest;

    // Get AI API key from providers with fallback.
    // Plaintext keys live in Supabase Vault — fetch only the row id, then
    // resolve the secret via the SECURITY DEFINER RPC (service role only).
    const { data: providers } = await supabase
      .from("ai_providers")
      .select(`
        id, provider_code, base_url, default_model,
        ai_api_keys!inner(id, vault_secret_id, priority)
      `)
      .eq("is_enabled", true)
      .order("priority", { ascending: true });

    if (!providers || providers.length === 0) {
      return new Response(JSON.stringify({ error: "No AI providers configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the first available provider and key
    const provider = providers[0];
    const keyRow = (provider.ai_api_keys as any[])?.[0];
    let apiKey: string | null = null;
    if (keyRow?.id) {
      const { data: secret, error: secretErr } = await supabase.rpc(
        "get_ai_api_key_secret",
        { p_id: keyRow.id },
      );
      if (!secretErr && secret) apiKey = secret as string;
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "No AI API key available" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build the appropriate prompt based on action
    let systemPrompt = "";
    let userPrompt = "";

    switch (action) {
      case "generate":
        systemPrompt = `You are an expert email marketing copywriter. Generate professional, engaging HTML emails for business communications.

Your emails should:
- Be visually appealing with proper HTML structure
- Use inline CSS for email client compatibility
- Include proper spacing, typography, and color
- Be mobile-responsive using max-width containers
- Have clear calls-to-action when appropriate
- Use placeholder variables in {{variable_name}} format

Available variables: ${Object.keys(variables || {}).map(k => `{{${k}}}`).join(", ") || "{{user_name}}, {{platform_name}}"}

Tone: ${tone || "professional"}`;

        userPrompt = prompt || `Generate a ${emailType} email. ${getEmailTypeGuidance(emailType)}`;
        break;

      case "improve":
        systemPrompt = `You are an expert email copywriter. Improve the provided email while maintaining its core message.

Improvements should focus on:
- Clearer, more compelling language
- Better structure and flow
- Professional tone (${tone || "professional"})
- Stronger opening and closing
- More engaging call-to-action

Return only the improved email content, maintaining the same format (plain text or HTML).`;

        userPrompt = `Improve this email:\n\n${currentContent}`;
        break;

      case "translate":
        systemPrompt = `You are a professional translator specializing in business communications. Translate the email while:
- Maintaining the original tone and formality
- Adapting cultural nuances appropriately
- Preserving all HTML formatting if present
- Keeping placeholder variables unchanged (e.g., {{user_name}})`;

        userPrompt = `Translate this email to ${targetLanguage || "Spanish"}:\n\n${currentContent}`;
        break;

      case "html_beautify":
        systemPrompt = `You are an expert email HTML designer. Convert the provided plain text email into a beautiful, professional HTML email.

Requirements:
- Use inline CSS only (no external stylesheets)
- Make it mobile-responsive (max-width: 600px container)
- Use a clean, modern design
- Include proper email-safe fonts (Arial, Georgia, etc.)
- Add subtle colors and spacing
- Make links and buttons prominent
- Preserve all content and placeholder variables`;

        userPrompt = `Convert this plain text email to beautiful HTML:\n\n${currentContent}`;
        break;

      case "subject_suggestions":
        systemPrompt = `You are an email marketing expert. Generate 5 compelling subject lines for the provided email content.

Requirements:
- Keep under 60 characters
- Include an emoji option for each
- One with urgency
- One with curiosity/intrigue
- One that's straightforward
- One with personalization (using {{user_name}})
- One with a number or statistic

Format your response as a JSON array of strings.`;

        userPrompt = `Generate subject line suggestions for this email:\n\n${currentContent}`;
        break;

      default:
        return new Response(JSON.stringify({ error: "Invalid action" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    // Call the AI provider
    const aiResponse = await fetch(provider.base_url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.default_model || "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: action === "subject_suggestions" ? 0.9 : 0.7,
        max_tokens: action === "subject_suggestions" ? 500 : 2000,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI API error:", errorText);
      return new Response(JSON.stringify({ error: "AI service error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    const content = aiData.choices?.[0]?.message?.content || "";

    // Parse subject suggestions if applicable
    let result: any = { content: content.trim() };
    if (action === "subject_suggestions") {
      try {
        // Try to extract JSON from the response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          result.subjects = JSON.parse(jsonMatch[0]);
        } else {
          // Fall back to line-by-line parsing
          result.subjects = content.split("\n").filter((line: string) => line.trim()).slice(0, 5);
        }
      } catch (e) {
        result.subjects = content.split("\n").filter((line: string) => line.trim()).slice(0, 5);
      }
    }

    // Log AI usage. This is a platform-admin surface, so there is no tenant
    // tuple to attach — but the spend must still be attributable to the admin
    // who caused it, derived from the verified JWT rather than the body.
    await supabase.from("ai_usage_logs").insert({
      provider_code: provider.provider_code,
      request_type: `email_${action}`,
      tokens_used: aiData.usage?.total_tokens || 0,
      model_used: provider.default_model,
      user_id: user.id,
      app_key: "platform_admin",
    });

    return new Response(JSON.stringify({ success: true, data: result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Error in ai-generate-email:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};

function getEmailTypeGuidance(emailType?: string): string {
  switch (emailType) {
    case "welcome":
      return "Create a warm welcome email for new users. Include: greeting, brief platform introduction, next steps, and a call-to-action to get started.";
    case "reengagement":
      return "Create a re-engagement email for inactive users. Include: personalized greeting, mention what they've been missing, highlight new features, and a compelling call-to-action to return.";
    case "announcement":
      return "Create a feature announcement email. Include: exciting intro, feature description, benefits, how to access it, and a call-to-action.";
    case "maintenance":
      return "Create a maintenance notification email. Include: clear timing, expected impact, apology for inconvenience, and contact information for questions.";
    default:
      return "Create a professional business email.";
  }
}

serve(handler);
