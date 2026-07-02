// Public, rate-limited endpoint that tells the auth-callback / forgot-password
// pages whether a given email was recently reaped via the self-serve
// "Start over with this email" recovery flow.
//
// Returns: { reaped: boolean, reaped_at?: string, reason?: string }
//
// Why this is safe for enumeration purposes:
//   - The reaped state is only set after the user themselves clicked
//     "Start over with this email" (or an admin reset their orphaned
//     account). An attacker cannot induce this state for an arbitrary
//     email they do not control, so revealing it does not let them
//     discover whether arbitrary emails ever had accounts.
//   - We DO NOT return the original user id or any other PII.
//   - Rate-limited to 10 / minute / IP.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  b.count += 1;
  return b.count > MAX_PER_WINDOW;
}

function isValidEmail(s: unknown): s is string {
  return typeof s === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) &&
    s.length <= 254;
}

// "Recently" = within the last 30 days. Older reaps are no longer relevant
// to the user's current confusion (stale email link).
const REAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const email = body.email?.trim().toLowerCase();
  if (!isValidEmail(email)) {
    return new Response(JSON.stringify({ error: "invalid_email" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const cutoff = new Date(Date.now() - REAP_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from("signup_cleanup_log")
    .select("created_at, reason")
    .eq("reaped_email", email)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[was-email-reaped] query error:", error.message);
    return new Response(JSON.stringify({ error: "lookup_failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!data) {
    return new Response(JSON.stringify({ reaped: false }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      reaped: true,
      reaped_at: data.created_at,
      reason: data.reason,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});