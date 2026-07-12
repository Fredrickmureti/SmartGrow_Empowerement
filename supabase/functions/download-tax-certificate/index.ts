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
    const artifactPath = typeof body?.artifact_path === "string" ? body.artifact_path : null;
    const overrideFilename = typeof body?.filename === "string" ? body.filename : null;
    const format = (typeof body?.format === "string" ? body.format : "pdf").toLowerCase();
    if (!certificateId && !pdfPath && !artifactPath) {
      return jsonResponse({ error: "certificate_id, pdf_path, or artifact_path required" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    let query = admin
      .from("payroll_tax_certificates")
      .select("id, organization_id, business_id, employee_id, pdf_path, xlsx_path, artifacts, serial_number, status, stale, stale_reason")
      .limit(1);
    if (certificateId) {
      query = query.eq("id", certificateId);
    } else if (pdfPath) {
      query = query.eq("pdf_path", pdfPath);
    } else if (artifactPath) {
      // Resolve the parent certificate row via any artifact path so the
      // permission check + lifecycle ledger still apply.
      query = query.contains("artifacts", [{ path: artifactPath }] as any);
    }

    const { data: cert, error: certErr } = await query.maybeSingle();
    if (certErr) return jsonResponse({ error: `failed to load certificate: ${certErr.message}` }, 500);
    if (!cert) return jsonResponse({ error: "certificate not found" }, 404);
    if ((cert as any).stale === true) {
      return jsonResponse({
        error: "This certificate file is stale. Regenerate the certificate to download the current A4 landscape version.",
        stale_reason: (cert as any).stale_reason ?? null,
      }, 409);
    }

    // Path resolution order:
    //  1) explicit `artifact_path` (canonical, from `artifacts[].path`)
    //  2) legacy `format` scalar → xlsx_path / pdf_path
    let storagePath: string | null = null;
    if (artifactPath) {
      const match = Array.isArray((cert as any).artifacts)
        ? ((cert as any).artifacts as any[]).find((a) => a?.path === artifactPath)
        : null;
      if (!match) {
        return jsonResponse({ error: "artifact_path does not belong to this certificate" }, 404);
      }
      storagePath = artifactPath;
    } else {
      const wantXlsx = format === "xlsx";
      storagePath = wantXlsx ? (cert as any).xlsx_path : cert.pdf_path;
    }
    if (!storagePath) {
      return jsonResponse({ error: "requested certificate file is missing" }, 404);
    }

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

    const filename = overrideFilename ?? fileNameFromPath(storagePath);
    const { data: signed, error: signErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, 60, { download: filename });
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