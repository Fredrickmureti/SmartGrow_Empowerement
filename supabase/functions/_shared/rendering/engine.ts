/**
 * Rendering Engine — orchestrator (Wave 3, ADR-0084).
 *
 * The single choke point for every server-side render. Flow:
 *
 *   1. Resolve the AST template (scope precedence, override, version).
 *   2. Build a `RenderContext` from the persisted document (or preview).
 *   3. Compose header + body + footer blocks.
 *   4. Dispatch to the medium renderer (pdf/escpos/zpl/html).
 *   5. Hash bytes, persist an artifact (unless `persist=false`).
 *
 * Legacy per-format edge functions (`generate-document`,
 * `generate-payslip-pdf`, thermal-only PDF paths, hard-coded ZPL) will
 * become thin adapters that call `renderDocument` and then handle
 * transport (download/email/print). Wave 9 removes them.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { RenderRequest, RenderResult } from "./types.ts";
import { resolveTemplateAst } from "./resolveTemplate.ts";
import { buildContext } from "./resolveContext.ts";
import { composeBlocks, getMediumRenderer } from "./mediumRegistry.ts";
import { persistArtifact, shouldPersistArtifact } from "../documents/persistArtifact.ts";

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export async function renderDocument(
  req: RenderRequest,
  supabase: SupabaseClient = serviceClient(),
): Promise<RenderResult> {
  const kindCode = req.document_id
    ? await lookupKindForDocument(supabase, req.document_id)
    : req.preview?.kind_code;
  if (!kindCode) throw new Error("render_request_missing_kind");

  const orgId = req.document_id
    ? await lookupOrgForDocument(supabase, req.document_id)
    : req.preview!.organization_id;
  const branchId = req.document_id
    ? await lookupBranchForDocument(supabase, req.document_id)
    : req.preview?.branch_id ?? null;

  const template = await resolveTemplateAst(supabase, {
    kindCode,
    organizationId: orgId,
    branchId,
    templateId: req.template_id,
  });

  const context = await buildContext(
    supabase,
    req,
    template.theme_id,
    template.header_id,
    template.footer_id,
  );

  const renderer = getMediumRenderer(req.medium);
  const blocks = composeBlocks(template, context);
  const bytes = await renderer.render({ template, context, blocks });
  const contentSha256 = await sha256(bytes);

  const result: RenderResult = {
    bytes,
    mime_type: renderer.mime_type,
    extension: renderer.extension,
    medium: req.medium,
    template_id: template.id,
    template_version: template.version,
    content_sha256: contentSha256,
    metadata: {
      kind: template.kind_code,
      scope: template.scope,
      label: template.label,
      block_count: blocks.length,
    },
  };

  if (
    req.persist !== false &&
    req.document_id &&
    shouldPersistArtifact(context.document.kind_code)
  ) {
    try {
      const persisted = await persistArtifact({
        supabase,
        bytes,
        organizationId: context.document.organization_id,
        businessId: context.document.business_id,
        branchId: context.document.branch_id,
        documentType: context.document.kind_code,
        documentId: context.document.id,
        documentNumber: context.document.number,
        intent: (context.options["intent"] as string | null) ?? null,
        templateId: template.id,
        templateVersion: template.version,
        policyId: (context.options["policy_id"] as string | null) ?? null,
        mimeType: renderer.mime_type,
        renderMode: renderer.medium,
        paperFormat: (context.options["paper_format"] as string) ?? template.media_class,
        copies: (context.options["copies"] as number) ?? 1,
        renderedBy: (context.options["rendered_by"] as string | null) ?? null,
        renderedVia: "rendering_engine",
        metadata: result.metadata,
      });
      result.artifact_id = persisted?.id ?? undefined;
    } catch (err) {
      console.warn("[rendering-engine] persistArtifact non-fatal error", err);
    }
  }

  return result;
}

async function lookupKindForDocument(supabase: SupabaseClient, id: string): Promise<string> {
  const { data, error } = await supabase.from("document_records").select("kind_code").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`document_not_found:${id}`);
  return data.kind_code as string;
}
async function lookupOrgForDocument(supabase: SupabaseClient, id: string): Promise<string> {
  const { data, error } = await supabase.from("document_records").select("organization_id").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`document_not_found:${id}`);
  return data.organization_id as string;
}
async function lookupBranchForDocument(supabase: SupabaseClient, id: string): Promise<string | null> {
  const { data, error } = await supabase.from("document_records").select("branch_id").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data?.branch_id as string | null) ?? null;
}
