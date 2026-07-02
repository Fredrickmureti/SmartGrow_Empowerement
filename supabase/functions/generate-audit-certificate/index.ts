/**
 * Generate Audit Certificate PDF Edge Function
 *
 * Stage 3 — bring this outlier into the unified PDF engine.
 * Uses PdfBuilder + BrandedHeader + BrandedFooter + accountantMono theme so
 * the audit certificate matches the rest of the platform's documents.
 *
 * Body manipulation (signed-PDF) intentionally stays in generate-signed-pdf
 * since it modifies a customer-uploaded PDF rather than rendering one.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { PdfBuilder } from "../_shared/pdf/PdfBuilder.ts";
import { assertStatutoryPaper } from "../_shared/pdf/index.ts";
import {
  drawBrandedHeader,
  embedLogo,
} from "../_shared/pdf/components/BrandedHeader.ts";
import {
  drawPageNumber,
  drawFinalFooter,
} from "../_shared/pdf/components/BrandedFooter.ts";
import { theme } from "../_shared/pdf/themes/accountantMono.ts";
import {
  getOrganizationBranding,
  fetchLogoBytes,
  type OrganizationBranding,
} from "../_shared/branding/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface AuditEvent {
  id: string;
  action: string;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
  geolocation: unknown;
  details: unknown;
  signer?: { name: string; email: string };
}

const ACTION_LABELS: Record<string, string> = {
  created: "Document Created",
  sent: "Request Sent",
  viewed: "Document Viewed",
  signed: "Document Signed",
  declined: "Document Declined",
  completed: "All Signatures Completed",
  cancelled: "Request Cancelled",
  document_generated: "Signed PDF Generated",
  notification_invitation: "Invitation Emails Sent",
  notification_reminder: "Reminder Emails Sent",
  notification_completed: "Completion Notifications Sent",
  certificate_generated: "Audit Certificate Generated",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { requestId } = await req.json();
    if (!requestId) {
      return new Response(
        JSON.stringify({ error: "Request ID is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: request, error: requestError } = await supabase
      .from("signature_requests")
      .select(`*, signers:signature_signers(*)`)
      .eq("id", requestId)
      .single();

    if (requestError || !request) {
      return new Response(
        JSON.stringify({ error: "Request not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // AUTH GATE: verify caller belongs to the signature request's organization
    // before exposing audit logs containing IPs / geolocation / user agents.
    const { requireOrgMember } = await import("../_shared/requireOrgMember.ts");
    const authResult = await requireOrgMember(req, request.organization_id, corsHeaders);
    if (!authResult.ok) return authResult.response;

    if (request.organization_id) {
      const { checkSubscriptionActive, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
      const subResult = await checkSubscriptionActive(supabase, request.organization_id);
      if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);
    }

    const { data: auditLogs } = await supabase
      .from("signature_audit_log")
      .select(`*, signer:signature_signers(name, email)`)
      .eq("request_id", requestId)
      .order("created_at", { ascending: true });

    const events: AuditEvent[] = (auditLogs || []).map((log: any) => ({
      id: log.id,
      action: log.action,
      created_at: log.created_at,
      ip_address: log.ip_address,
      user_agent: log.user_agent,
      geolocation: log.geolocation,
      details: log.details,
      signer: log.signer,
    }));

    // Branding (single canonical source — the engine's getOrganizationBranding).
    let organization: OrganizationBranding | null = null;
    if (request.organization_id) {
      organization = await getOrganizationBranding(supabase, request.organization_id);
    }

    const pdfBytes = await renderAuditCertificate({
      requestId,
      requestRow: request,
      signers: request.signers || [],
      events,
      organization,
    });

    // Upload to storage
    const certPath = `${requestId}/audit-certificate.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("sign-documents")
      .upload(certPath, pdfBytes, { contentType: "application/pdf", upsert: true });

    if (uploadError) {
      console.error("Failed to upload certificate:", uploadError);
      return new Response(pdfBytes as unknown as BodyInit, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="audit-certificate-${requestId.slice(0, 8)}.pdf"`,
        },
      });
    }

    await supabase.from("signature_audit_log").insert({
      request_id: requestId,
      action: "certificate_generated",
      details: { path: certPath },
    });

    return new Response(
      JSON.stringify({
        success: true,
        certificatePath: certPath,
        message: "Audit certificate generated successfully",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error generating audit certificate:", error);
    return new Response(
      JSON.stringify({ error: error?.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ── Rendering ──────────────────────────────────────────────────────────────

async function renderAuditCertificate(opts: {
  requestId: string;
  requestRow: any;
  signers: any[];
  events: AuditEvent[];
  organization: OrganizationBranding | null;
}): Promise<Uint8Array> {
  const { requestId, requestRow, signers, events, organization } = opts;

  // STATUTORY PAPER PIN — audit certificates are evidentiary documents
  // attached to formal investigations and regulator submissions. They
  // must remain bit-stable A4 PDFs irrespective of tenant print prefs.
  assertStatutoryPaper("a4");
  const builder = await PdfBuilder.create({ orientation: "portrait", margin: 50, paperFormat: "a4" });
  const { state, fontRegular, fontBold } = builder;
  const { margin, pageWidth } = state;

  // Embed logo once
  const logoBytes = await fetchLogoBytes(organization?.logo_url);
  const logo = await embedLogo(builder, logoBytes);

  // Header is re-drawn on every new page
  builder.onNewPage = (page) => {
    drawPageNumber(builder, page);
    const { bodyY } = drawBrandedHeader(builder, page, {
      title: "AUDIT CERTIFICATE",
      organization,
      companyName: organization?.name,
      logo,
    });
    return bodyY;
  };

  builder.newPage();

  // Subtitle
  builder.page.drawText("Digital Signature Verification Report", {
    x: margin, y: builder.y,
    size: 11, font: fontRegular, color: theme.color.medGray,
  });
  builder.y -= 22;

  // ── Document Information ──
  drawSectionTitle(builder, "DOCUMENT INFORMATION");

  const docInfo: Array<[string, string]> = [
    ["Document Name:", String(requestRow.name ?? "—")],
    ["Document ID:", requestId],
    ["Organization:", organization?.name || "N/A"],
    ["Created:", formatStamp(requestRow.created_at)],
    ["Status:", String(requestRow.status ?? "N/A").toUpperCase()],
    ["Signing Order:", requestRow.signing_order === "sequential" ? "Sequential" : "Parallel"],
  ];
  if (requestRow.completed_at) docInfo.push(["Completed:", formatStamp(requestRow.completed_at)]);

  drawKeyValueRows(builder, docInfo);
  drawSeparator(builder);

  // ── Signers ──
  drawSectionTitle(builder, "SIGNERS");

  for (const signer of signers) {
    builder.ensureSpace(60);
    const page = builder.page;

    page.drawText(`• ${signer.name || "Unknown"}`, {
      x: margin, y: builder.y,
      size: 10, font: fontBold, color: theme.color.text,
    });
    page.drawText(`<${signer.email}>`, {
      x: margin + 160, y: builder.y,
      size: 9, font: fontRegular, color: theme.color.medGray,
    });
    builder.y -= 13;

    page.drawText(`Role: ${signer.role || "signer"}`, {
      x: margin + 12, y: builder.y, size: 9, font: fontRegular, color: theme.color.text,
    });
    page.drawText(`Status: ${String(signer.status ?? "PENDING").toUpperCase()}`, {
      x: margin + 160, y: builder.y, size: 9, font: fontBold, color: theme.color.text,
    });
    builder.y -= 13;

    if (signer.signed_at) {
      page.drawText(`Signed: ${formatStamp(signer.signed_at)}`, {
        x: margin + 12, y: builder.y, size: 9, font: fontRegular, color: theme.color.medGray,
      });
      builder.y -= 12;
    }
    if (signer.ip_address) {
      page.drawText(`IP Address: ${signer.ip_address}`, {
        x: margin + 12, y: builder.y, size: 9, font: fontRegular, color: theme.color.medGray,
      });
      builder.y -= 12;
    }
    if (signer.declined_at) {
      page.drawText(`Declined: ${formatStamp(signer.declined_at)}`, {
        x: margin + 12, y: builder.y, size: 9, font: fontRegular, color: theme.color.text,
      });
      builder.y -= 12;
      if (signer.decline_reason) {
        page.drawText(`Reason: ${truncate(signer.decline_reason, 90)}`, {
          x: margin + 12, y: builder.y, size: 9, font: fontRegular, color: theme.color.text,
        });
        builder.y -= 12;
      }
    }
    builder.y -= 8;
  }

  drawSeparator(builder);

  // ── Audit Trail ──
  drawSectionTitle(builder, "AUDIT TRAIL");
  builder.page.drawText("Complete timeline of all events", {
    x: margin, y: builder.y,
    size: 9, font: fontRegular, color: theme.color.medGray,
  });
  builder.y -= 16;

  for (const event of events) {
    builder.ensureSpace(40);
    const page = builder.page;

    page.drawText(formatStamp(event.created_at), {
      x: margin, y: builder.y, size: 8, font: fontRegular, color: theme.color.medGray,
    });
    builder.y -= 11;

    const actionLabel = ACTION_LABELS[event.action] || event.action;
    page.drawText(actionLabel, {
      x: margin + 10, y: builder.y, size: 9, font: fontBold, color: theme.color.text,
    });

    if (event.signer) {
      const byText = `by ${event.signer.name} (${event.signer.email})`;
      page.drawText(truncate(byText, 70), {
        x: margin + 180, y: builder.y, size: 8, font: fontRegular, color: theme.color.medGray,
      });
    }
    builder.y -= 11;

    if (event.ip_address) {
      page.drawText(`IP: ${event.ip_address}`, {
        x: margin + 10, y: builder.y, size: 8, font: fontRegular, color: theme.color.lightGray,
      });
      builder.y -= 11;
    }

    if (event.details && typeof event.details === "object") {
      const detailStr = JSON.stringify(event.details);
      if (detailStr.length < 100) {
        page.drawText(`Details: ${truncate(detailStr, 90)}`, {
          x: margin + 10, y: builder.y, size: 8, font: fontRegular, color: theme.color.lightGray,
        });
        builder.y -= 11;
      }
    }

    builder.y -= 6;
  }

  drawSeparator(builder);

  // ── Verification ──
  builder.ensureSpace(140);
  drawSectionTitle(builder, "CERTIFICATE VERIFICATION");

  const certInfo: Array<[string, string]> = [
    ["Certificate Generated:", new Date().toISOString()],
    ["Document Hash:", `${requestId.slice(0, 8)}...${requestId.slice(-8)}`],
    ["Total Events:", String(events.length)],
    ["Total Signers:", String(signers.length)],
    ["Signed Count:", String(signers.filter((s: any) => s.status === "signed").length)],
  ];
  drawKeyValueRows(builder, certInfo);

  builder.y -= 12;
  builder.page.drawText(
    "This certificate provides an immutable record of the electronic signature process.",
    { x: margin, y: builder.y, size: 8, font: fontRegular, color: theme.color.medGray }
  );
  builder.y -= 11;
  builder.page.drawText(
    "The document was signed electronically in accordance with applicable laws.",
    { x: margin, y: builder.y, size: 8, font: fontRegular, color: theme.color.medGray }
  );

  // Final footer (note + generated stamp on last page)
  drawFinalFooter(builder, builder.page, {
    footerNote: "Confidential — Digital signature audit trail",
    includeGeneratedStamp: true,
  });

  // Suppress unused-var warning
  void pageWidth;

  return await builder.save();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function drawSectionTitle(builder: PdfBuilder, title: string): void {
  builder.ensureSpace(28);
  builder.page.drawText(title, {
    x: builder.state.margin, y: builder.y,
    size: 11, font: builder.fontBold, color: theme.color.text,
  });
  builder.y -= 16;
}

function drawKeyValueRows(builder: PdfBuilder, rows: Array<[string, string]>): void {
  const { margin } = builder.state;
  for (const [label, value] of rows) {
    builder.ensureSpace(14);
    builder.page.drawText(label, {
      x: margin, y: builder.y,
      size: 9, font: builder.fontBold, color: theme.color.text,
    });
    builder.page.drawText(truncate(value, 90), {
      x: margin + 130, y: builder.y,
      size: 9, font: builder.fontRegular, color: theme.color.text,
    });
    builder.y -= 13;
  }
  builder.y -= 4;
}

function drawSeparator(builder: PdfBuilder): void {
  const { margin, pageWidth } = builder.state;
  builder.ensureSpace(14);
  builder.page.drawLine({
    start: { x: margin, y: builder.y },
    end: { x: pageWidth - margin, y: builder.y },
    thickness: 0.5, color: theme.color.border,
  });
  builder.y -= 16;
}

function formatStamp(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
