import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const STORAGE_BUCKET = "documents";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fileNameFromPath(path: string) {
  return path.split("/").filter(Boolean).pop() || "certificate.pdf";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return jsonResponse({ error: "unauthenticated" }, 401);

    const body = await req.json().catch(() => ({}));
    const certificateId = typeof body?.certificate_id === "string" ? body.certificate_id : null;
    const pdfPath = typeof body?.pdf_path === "string" ? body.pdf_path : null;
    if (!certificateId && !pdfPath) {
      return jsonResponse({ error: "certificate_id or pdf_path required" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    let query = admin
      .from("payroll_tax_certificates")
      .select("id, organization_id, business_id, employee_id, pdf_path, serial_number, status")
      .limit(1);
    query = certificateId ? query.eq("id", certificateId) : query.eq("pdf_path", pdfPath);

    const { data: cert, error: certErr } = await query.maybeSingle();
    if (certErr) return jsonResponse({ error: `failed to load certificate: ${certErr.message}` }, 500);
    if (!cert?.pdf_path) return jsonResponse({ error: "certificate PDF is missing" }, 404);

    // Self-service bypass: if the requesting user owns the employee row this
    // certificate belongs to, skip the payroll.read permission check. Mirrors
    // generate-payslip-pdf's contract so employees can pull their own P9 /
    // IRP5 / Lohnsteuerbescheinigung / etc. from /me/tax-certificates.
    const { data: ownEmp } = await admin
      .from("employees")
      .select("id")
      .eq("user_id", userData.user.id)
      .eq("id", cert.employee_id)
      .maybeSingle();

    if (!ownEmp) {
      const { data: allowed, error: permErr } = await admin.rpc("user_has_module_permission", {
        _user_id: userData.user.id,
        _org_id: cert.organization_id,
        _business_id: cert.business_id,
        _module: "payroll",
        _operation: "read",
      });
      if (permErr) return jsonResponse({ error: `permission check failed: ${permErr.message}` }, 500);
      if (!allowed) return jsonResponse({ error: "permission denied" }, 403);
    }

    const filename = fileNameFromPath(cert.pdf_path);
    const { data: signed, error: signErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(cert.pdf_path, 60, { download: filename });
    if (signErr || !signed?.signedUrl) {
      return jsonResponse({ error: `certificate file not found in storage: ${signErr?.message ?? "no signed URL"}` }, 404);
    }

    // Lifecycle ledger (Step 1): record the download. Best-effort — a
    // logging failure must never block the user from getting their PDF.
    try {
      await admin.from("payroll_tax_certificate_events").insert({
        certificate_id: cert.id,
        organization_id: cert.organization_id,
        business_id: cert.business_id,
        event_type: "downloaded",
        actor_user_id: userData.user.id,
        details: { self_service: !!ownEmp },
      });
    } catch { /* swallow */ }

    return jsonResponse({ signedUrl: signed.signedUrl, filename, certificate_id: cert.id });
  } catch (e: any) {
    return jsonResponse({ error: e?.message ?? String(e) }, 500);
  }
});