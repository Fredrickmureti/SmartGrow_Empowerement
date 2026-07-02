/**
 * PIN Login Edge Function (Optimized)
 * Authenticates users via email + PIN without requiring a prior session.
 * 
 * Flow (3 calls instead of 5):
 * 1. verify_pin_full RPC — combines profile lookup + prefs check + PIN verify
 * 2. generateLink — creates magic link token
 * 3. verifyOtp — exchanges token for session
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, pin } = await req.json();

    if (!email || !pin) {
      return new Response(
        JSON.stringify({ error: "Email and PIN are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!/^\d{4,6}$/.test(pin)) {
      return new Response(
        JSON.stringify({ error: "Invalid PIN format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Step 1: Combined profile lookup + prefs check + PIN verification (single DB call)
    const { data: verifyResult, error: verifyError } = await adminClient.rpc(
      "verify_pin_full",
      { p_email: email.toLowerCase(), p_pin: pin }
    );

    if (verifyError) {
      console.error("PIN verification RPC error:", verifyError);
      return new Response(
        JSON.stringify({ error: "Verification failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = verifyResult as {
      success: boolean;
      error?: string;
      locked?: boolean;
      locked_until?: string;
      attempts_remaining?: number;
    };

    if (!result.success) {
      const status = result.locked ? 429 : 401;
      return new Response(
        JSON.stringify({
          error: result.error || "Invalid PIN",
          locked: result.locked || false,
          locked_until: result.locked_until,
          attempts_remaining: result.attempts_remaining,
        }),
        { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 2: Generate magic link token
    const { data: authData, error: authError } =
      await adminClient.auth.admin.generateLink({
        type: "magiclink",
        email: email.toLowerCase(),
      });

    if (authError || !authData) {
      console.error("Failed to generate auth link:", authError);
      return new Response(
        JSON.stringify({ error: "Authentication failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const tokenHash = authData.properties?.hashed_token;
    if (!tokenHash) {
      console.error("No hashed_token in generateLink response");
      return new Response(
        JSON.stringify({ error: "Authentication failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 3: Exchange token for session
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: sessionData, error: sessionError } = await anonClient.auth.verifyOtp({
      token_hash: tokenHash,
      type: "magiclink",
    });

    if (sessionError || !sessionData.session) {
      console.error("Failed to verify OTP for session:", sessionError);
      return new Response(
        JSON.stringify({ error: "Authentication failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        session: {
          access_token: sessionData.session.access_token,
          refresh_token: sessionData.session.refresh_token,
          expires_in: sessionData.session.expires_in,
          expires_at: sessionData.session.expires_at,
          token_type: sessionData.session.token_type,
          user: sessionData.session.user,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("PIN login error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
