// @ts-nocheck — Deno runtime
/**
 * generate-annual-earnings-statement
 *
 * Country-neutral edge function that renders the Annual Earnings Statement
 * for one (employee, fiscal_year). Thin dispatcher — all business logic
 * lives in `_shared/annualEarningsResolver.ts` (single writer of the DTO)
 * and the v3 certificate compiler. ADR-0063.
 *
 * Contract:
 *   POST { organization_id, business_id, employee_id, fiscal_year }
 *   → { ok, dto_version, content_hash, html, provenance }
 *
 * Self-service bypass: if `auth.uid()` equals `employees.user_id` for the
 * target employee, the `payroll.read` check is skipped. Mirrors
 * `generate-payslip-pdf` and `download-tax-certificate`.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { compile as compileCertificateHtml } from "../_shared/certificate-engine/compile.ts";
import { getOrganizationBranding } from "../_shared/branding/index.ts";
import { resolveAnnualEarnings } from "../_shared/annualEarningsResolver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE_TEMPLATE_CODE = "ANNUAL_EARNINGS_STATEMENT";

interface Body {
  organization_id: string;
  business_id: string;
  employee_id: string;
  fiscal_year: number;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Recursively expand `extension_region` nodes in the template body by
 * splicing in the pack-provided appendix bodies. Unknown extension
 * regions are elided so an uninstalled pack disappears cleanly.
 */
function expandExtensionRegions(
  nodes: any[],
  extensions: Record<string, any>,
): any[] {
  const out: any[] = [];
  for (const n of nodes) {
    if (n?.type === "extension_region") {
      const region = String(n.region ?? "");
      for (const packCode of Object.keys(extensions).sort()) {
        const packBody = extensions[packCode] as any;
        const regionBody = packBody?.[region];
        if (Array.isArray(regionBody)) out.push(...regionBody);
        else if (regionBody && typeof regionBody === "object" && Array.isArray(regionBody.nodes)) out.push(...regionBody.nodes);
      }
      continue;
    }
    out.push(n);
  }
  return out;
}

function makeSerial(orgId: string, employeeId: string, year: number): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = `${orgId.slice(0, 4)}${employeeId.slice(0, 4)}`.toUpperCase();
  return `AES-${year}-${suffix}-${stamp}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  try {
    const body = (await req.json()) as Body;
    if (!body?.organization_id || !body?.business_id || !body?.employee_id || !body?.fiscal_year) {
      return json(400, { error: "invalid_body", required: ["organization_id","business_id","employee_id","fiscal_year"] });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // AuthN
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json(401, { error: "unauthenticated" });
    const { data: userRes, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userRes?.user) return json(401, { error: "unauthenticated" });
    const userId = userRes.user.id;

    // Load employee
    const { data: emp, error: empErr } = await admin
      .from("employees")
      .select("id, user_id, first_name, last_name, employee_number, department_id, job_position_id, employment_status, hire_date, termination_date, organization_id, business_id")
      .eq("id", body.employee_id)
      .maybeSingle();
    if (empErr || !emp) return json(404, { error: "employee_not_found" });
    if (emp.organization_id !== body.organization_id || emp.business_id !== body.business_id) {
      return json(403, { error: "tenant_mismatch" });
    }

    // Self-service bypass
    const isSelf = emp.user_id === userId;
    if (!isSelf) {
      // Non-self: enforce payroll.read via user_roles + payroll admin membership.
      // Kept minimal here — a caller without self-access must also route through
      // an authorised admin surface which pre-checks; we defensively check for
      // an admin membership row on the tenant.
      const { data: roleRow } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("organization_id", body.organization_id)
        .in("role", ["admin", "hr_admin", "payroll_admin"])
        .maybeSingle();
      if (!roleRow) return json(403, { error: "forbidden", reason: "payroll_read_required" });
    }

    // Resolve department/position labels
    let departmentLabel: string | null = null;
    let positionLabel: string | null = null;
    if (emp.department_id) {
      const { data: dept } = await admin.from("departments").select("name").eq("id", emp.department_id).maybeSingle();
      departmentLabel = (dept as any)?.name ?? null;
    }
    if (emp.job_position_id) {
      const { data: pos } = await admin.from("job_positions").select("title").eq("id", emp.job_position_id).maybeSingle();
      positionLabel = (pos as any)?.title ?? null;
    }

    // Branding
    const branding = await getOrganizationBranding(admin, body.organization_id, body.business_id);

    // Currency
    const { data: orgRow } = await admin
      .from("organizations")
      .select("currency")
      .eq("id", body.organization_id)
      .maybeSingle();
    const currency = (orgRow as any)?.currency ?? "USD";

    // Load template body
    const { data: template, error: tplErr } = await admin
      .from("localization_pack_certificate_templates")
      .select("code, display_name, body")
      .eq("code", BASE_TEMPLATE_CODE)
      .is("pack_id", null)
      .maybeSingle();
    if (tplErr || !template) return json(500, { error: "base_template_missing" });

    const serial = makeSerial(body.organization_id, body.employee_id, body.fiscal_year);
    const fullName = [emp.first_name, emp.last_name].filter(Boolean).join(" ") || "—";

    // Build DTO through the single-writer resolver.
    const dto = await resolveAnnualEarnings({
      admin,
      organizationId: body.organization_id,
      businessId: body.business_id,
      employeeId: body.employee_id,
      fiscalYear: body.fiscal_year,
      branding: {
        name: (branding as any)?.name ?? null,
        legal_name: (branding as any)?.legal_name ?? null,
        address: (branding as any)?.address ?? null,
        phone: (branding as any)?.phone ?? null,
        email: (branding as any)?.email ?? null,
      },
      employee: {
        id: emp.id,
        full_name: fullName,
        employee_number: emp.employee_number,
        department: departmentLabel,
        position: positionLabel,
        employment_status: emp.employment_status,
        hire_date: emp.hire_date,
        termination_date: emp.termination_date,
      },
      currency,
      serialNumber: serial,
      baseTemplateCode: BASE_TEMPLATE_CODE,
      issuer: null,
    });

    // Expand pack extension regions in the template body.
    const baseDoc: any[] = Array.isArray((template.body as any).document) ? (template.body as any).document : [];
    const perPackRegions: Record<string, any> = {};
    for (const [packCode, packBody] of Object.entries(dto.extensions)) {
      perPackRegions[packCode] = packBody;
    }
    const expandedDoc = expandExtensionRegions(baseDoc, perPackRegions);

    const v3Template = {
      schema_version: 3,
      code: template.code,
      display_name: template.display_name,
      paper_format: (template.body as any).paper_format,
      page_master: (template.body as any).page_master,
      document: expandedDoc,
    };

    const { html } = compileCertificateHtml(v3Template as any, dto as any, { currency });

    return json(200, {
      ok: true,
      dto_version: dto.dto_version,
      content_hash: dto.provenance.content_hash,
      provenance: dto.provenance,
      serial_number: dto.serial_number,
      generated_at: dto.generated_at,
      html,
    });
  } catch (e) {
    console.error("[generate-annual-earnings-statement]", e);
    return json(500, { error: "internal_error", message: String((e as any)?.message ?? e) });
  }
});