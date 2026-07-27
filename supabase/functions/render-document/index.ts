/**
 * render-document — the ONE render endpoint (Wave 3, ADR-0084).
 *
 * Every server-side render (invoice PDF, ESC/POS receipt, ZPL label,
 * HTML preview, email body) is expected to converge on this function.
 * It is a thin HTTP wrapper around `renderDocument()`; all business
 * logic lives in the shared Rendering Engine.
 *
 * Legacy endpoints (`generate-document`, `generate-payslip-pdf`, …)
 * remain during Waves 4–8 and are progressively rewritten as adapters
 * that call this function. Wave 9 removes them.
 *
 * Request body:
 *   {
 *     medium: "pdf" | "escpos" | "zpl" | "html",
 *     document_id?: string,          // persisted document
 *     preview?: {...},               // inline snapshot for previews
 *     template_id?: string,          // override scope resolution
 *     options?: {...},               // renderer-specific knobs
 *     persist?: boolean              // default true when document_id set
 *   }
 *
 * Response: either the raw artifact bytes (default) or a JSON envelope
 * when `Accept: application/json` is sent (used by the browser preview
 * surface which needs metadata alongside bytes).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { renderDocument, serviceClient } from "../_shared/rendering/engine.ts";
import { requireOrgMember } from "../_shared/requireOrgMember.ts";
import type { RenderRequest } from "../_shared/rendering/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function contentDisposition(kind: string, number: string | null, ext: string): string {
  const raw = `${kind}-${number ?? "document"}.${ext}`;
  const ascii = raw.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  let body: RenderRequest;
  try {
    body = (await req.json()) as RenderRequest;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  const supabase = serviceClient();

  // Authorization: the caller must be a member of the target org.
  const orgId = body.document_id
    ? (await supabase.from("documents").select("organization_id").eq("id", body.document_id).maybeSingle())
        .data?.organization_id
    : body.preview?.organization_id;
  if (!orgId) {
    return new Response(JSON.stringify({ error: "missing_organization" }), {
      status: 400,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
  const authResult = await requireOrgMember(req, orgId, corsHeaders);
  if (!authResult.ok) return authResult.response;

  try {
    const result = await renderDocument(body, supabase);
    const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
    if (wantsJson) {
      return new Response(
        JSON.stringify({
          medium: result.medium,
          mime_type: result.mime_type,
          extension: result.extension,
          template_id: result.template_id,
          template_version: result.template_version,
          content_sha256: result.content_sha256,
          artifact_id: result.artifact_id,
          metadata: result.metadata,
          bytes_base64: btoa(String.fromCharCode(...result.bytes)),
        }),
        { headers: { ...corsHeaders, "content-type": "application/json" } },
      );
    }
    const kind = (result.metadata["kind"] as string) ?? "document";
    return new Response(result.bytes, {
      headers: {
        ...corsHeaders,
        "content-type": result.mime_type,
        "content-disposition": contentDisposition(kind, null, result.extension),
        "x-template-id": result.template_id,
        "x-template-version": String(result.template_version),
        "x-content-sha256": result.content_sha256,
      },
    });
  } catch (err) {
    console.error("[render-document] failure", err);
    return new Response(
      JSON.stringify({ error: "render_failed", detail: String(err instanceof Error ? err.message : err) }),
      { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } },
    );
  }
});
