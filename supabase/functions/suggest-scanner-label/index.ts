/**
 * suggest-scanner-label — Wave-5 close-out.
 *
 * Asks Lovable AI Gateway for 3 short scanner labels (≤28 chars each)
 * given a register name, the phone's UA-derived device label, and the
 * most-frequent recent workflow on that channel.
 *
 * Auth: JWT-verified by Supabase platform (verify_jwt default true).
 * Falls back to deterministic suggestions on any gateway error so the
 * "Suggest" chip in DevicePresenceList never breaks the rename UX.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GATEWAY_MODEL = "google/gemini-3-flash-preview";

/**
 * Attributes this gateway call to the caller's tenant. The scope tuple is
 * derived from the verified JWT (`user_roles`), never from the request body, so
 * a suggestion made from one workspace can never be billed to another.
 */
async function logUsage(
  req: Request,
  outcome: { responseTimeMs: number; error?: string | null; rateLimited?: boolean },
): Promise<void> {
  try {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return;
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: userData } = await admin.auth.getUser(token);
    const userId = userData?.user?.id ?? null;
    if (!userId) return;
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();

    await admin.from("ai_usage_logs").insert({
      provider_code: "lovable_gateway",
      request_type: "scanner_label_suggestion",
      model_used: GATEWAY_MODEL,
      response_time_ms: outcome.responseTimeMs,
      was_rate_limited: outcome.rateLimited ?? false,
      error_message: outcome.error ?? null,
      organization_id: roleRow?.organization_id ?? null,
      user_id: userId,
      app_key: "wms",
    });
  } catch (error) {
    // Telemetry must never break the rename UX.
    console.error("[suggest-scanner-label] usage log failed", error);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Body {
  register_name?: string | null;
  device_label?: string | null;
  top_workflow?: string | null;
}

function clamp(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 28);
}

function fallback({ register_name, device_label, top_workflow }: Body): string[] {
  const reg = (register_name || "Register").trim();
  const dev = (device_label || "Phone").trim();
  const wf = top_workflow
    ? top_workflow.replace(/(^|\s)\S/g, (s) => s.toUpperCase())
    : null;
  const out = new Set<string>();
  if (wf) out.add(`${wf} · ${dev}`);
  out.add(`${reg} · ${dev}`);
  if (wf) out.add(`${reg} ${wf}`);
  out.add(dev);
  return Array.from(out).slice(0, 3).map(clamp);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  let body: Body = {};
  try { body = await req.json(); } catch { body = {}; }

  const reg = clamp(String(body.register_name ?? ""));
  const dev = clamp(String(body.device_label ?? "Phone"));
  const wf  = body.top_workflow ? clamp(String(body.top_workflow)) : null;

  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) {
    return Response.json(
      { suggestions: fallback(body), source: "fallback", reason: "no_key" },
      { headers: { ...corsHeaders, "content-type": "application/json" } },
    );
  }

  const sys = "You name handheld barcode scanners in a warehouse / retail context. Return ONLY a JSON object {\"suggestions\":[\"...\",\"...\",\"...\"]} with exactly 3 short labels, each at most 28 characters, no quotes inside, no emojis, no trailing punctuation. Mix register name, device, and workflow when useful. Prefer concrete operator-friendly names like 'Receiving · iPhone' or 'Till 2 Backup'.";
  const user = `register_name=${reg || "(unknown)"}, device_label=${dev}, top_workflow=${wf ?? "(none)"}`;

  const startedAt = Date.now();
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GATEWAY_MODEL,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.4,
      }),
    });

    if (r.status === 429 || r.status === 402) {
      await logUsage(req, {
        responseTimeMs: Date.now() - startedAt,
        error: r.status === 429 ? "rate_limit" : "credits",
        rateLimited: r.status === 429,
      });
      return Response.json(
        { suggestions: fallback(body), source: "fallback", reason: r.status === 429 ? "rate_limit" : "credits" },
        { headers: { ...corsHeaders, "content-type": "application/json" } },
      );
    }
    if (!r.ok) throw new Error(`gateway ${r.status}`);

    const j = await r.json();
    await logUsage(req, { responseTimeMs: Date.now() - startedAt });
    const raw = j?.choices?.[0]?.message?.content ?? "{}";
    let parsed: { suggestions?: unknown } = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    const arr = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    const cleaned = arr
      .filter((s): s is string => typeof s === "string")
      .map(clamp)
      .filter((s) => s.length > 0)
      .slice(0, 3);

    if (cleaned.length === 0) {
      return Response.json(
        { suggestions: fallback(body), source: "fallback", reason: "empty" },
        { headers: { ...corsHeaders, "content-type": "application/json" } },
      );
    }

    return Response.json(
      { suggestions: cleaned, source: "ai" },
      { headers: { ...corsHeaders, "content-type": "application/json" } },
    );
  } catch (e) {
    await logUsage(req, {
      responseTimeMs: Date.now() - startedAt,
      error: (e as Error).message?.slice(0, 500) ?? "unknown_error",
    });
    return Response.json(
      { suggestions: fallback(body), source: "fallback", reason: (e as Error).message },
      { headers: { ...corsHeaders, "content-type": "application/json" } },
    );
  }
});