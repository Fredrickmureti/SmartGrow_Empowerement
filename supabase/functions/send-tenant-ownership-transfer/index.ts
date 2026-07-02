/**
 * send-tenant-ownership-transfer
 *
 * Sends the verification-link email to the incoming workspace owner.
 * Caller (front-end client) provides the org info, recipient details,
 * and the verification token returned by `initiate_tenant_ownership_transfer`.
 *
 * We re-use the existing send-email function pattern. The link goes to
 * /accept-ownership/:token in the SPA.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface Body {
  organizationId: string;
  organizationName?: string;
  toEmail: string;
  toName?: string;
  fromName?: string;
  token: string;
  notes?: string | null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Authn: caller must be logged in.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: claims, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claims?.claims) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = (await req.json()) as Body;
    if (!body?.organizationId || !body?.toEmail || !body?.token) {
      return json({ error: "Missing required fields" }, 400);
    }

    // Authz: caller must be the current owner of that org.
    const admin = createClient(supabaseUrl, supabaseServiceKey);
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("id, name, owner_user_id")
      .eq("id", body.organizationId)
      .maybeSingle();
    if (orgErr || !org) return json({ error: "Organization not found" }, 404);
    if (org.owner_user_id !== claims.claims.sub) {
      return json({ error: "Only the current owner can request transfer" }, 403);
    }

    const origin =
      req.headers.get("origin") ??
      Deno.env.get("PUBLIC_APP_URL") ??
      "https://app.example.com";
    const acceptUrl = `${origin.replace(/\/$/, "")}/accept-ownership/${encodeURIComponent(body.token)}`;
    const orgName = body.organizationName ?? org.name ?? "your workspace";
    const fromName = body.fromName ?? "The workspace owner";
    const subject = `Ownership of ${orgName} is being transferred to you`;

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #111;">
  <h2 style="margin: 0 0 16px;">You're being made owner of ${escapeHtml(orgName)}</h2>
  <p style="line-height: 1.55;">
    ${escapeHtml(fromName)} has initiated a workspace ownership transfer to you${
      body.toName ? `, ${escapeHtml(body.toName)}` : ""
    }.
  </p>
  ${
    body.notes
      ? `<blockquote style="margin: 16px 0; padding: 12px 16px; background: #f6f6f6; border-left: 3px solid #d4d4d4;">${escapeHtml(
          body.notes,
        )}</blockquote>`
      : ""
  }
  <p style="line-height: 1.55;">
    Click the button below to accept ownership. The link expires in 7 days.
    Once you accept, you become the owner and the previous owner loses
    owner privileges (but keeps their account and other roles).
  </p>
  <p style="margin: 28px 0;">
    <a href="${acceptUrl}" style="display: inline-block; padding: 12px 20px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">Accept ownership</a>
  </p>
  <p style="font-size: 12px; color: #666; line-height: 1.55;">
    Or paste this link into your browser:<br>
    <span style="word-break: break-all;">${acceptUrl}</span>
  </p>
  <p style="font-size: 12px; color: #666; margin-top: 24px;">
    If you weren't expecting this, you can safely ignore this email — the
    transfer will not happen until you click the link.
  </p>
</body>
</html>`.trim();

    // Re-use the existing send-email function (it owns the provider config).
    const { error: sendErr } = await admin.functions.invoke("send-email", {
      body: {
        to: body.toEmail,
        subject,
        html,
      },
    });
    if (sendErr) {
      console.error("[send-tenant-ownership-transfer] send-email failed:", sendErr);
      return json({ error: "Email send failed", details: sendErr.message }, 500);
    }

    return json({ ok: true });
  } catch (e) {
    console.error("[send-tenant-ownership-transfer] error:", e);
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
