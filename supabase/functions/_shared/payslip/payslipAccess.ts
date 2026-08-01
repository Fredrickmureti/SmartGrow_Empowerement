/**
 * Payslip access control — one gate, two callers.
 *
 * Both the payslip document-record builder (`ensure-payslip-document`) and
 * the legacy direct PDF endpoint (`generate-payslip-pdf`) must answer the
 * same question: may this caller see this employee's pay data? Enterprise
 * rule: the employee themself always may; anyone else needs
 * `payroll.read` in the owning organization. The payroll app must also be
 * entitled for that organization.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

export interface PayslipAccessDenial {
  denied: Response;
}

export type PayslipAccessResult = { ok: true; userId: string } | PayslipAccessDenial;

export function isDenied(r: PayslipAccessResult): r is PayslipAccessDenial {
  return (r as PayslipAccessDenial).denied !== undefined;
}

export async function authorizePayslipAccess(args: {
  supabase: SupabaseClient;
  req: Request;
  organizationId: string | null;
  employeeId: string | null;
  corsHeaders: Record<string, string>;
}): Promise<PayslipAccessResult> {
  const { supabase, req, organizationId, employeeId, corsHeaders } = args;
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return { denied: json({ error: "unauthorized: missing authorization header" }, 401) };
  }
  const token = authHeader.replace("Bearer ", "");
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userErr || !userId) return { denied: json({ error: "unauthorized" }, 401) };

  if (!organizationId) return { ok: true, userId };

  // ─── Subscription entitlement ───
  const { checkAppEntitlement, entitlementDeniedResponse } = await import("../entitlementCheck.ts");
  const entResult = await checkAppEntitlement(supabase, organizationId, "payroll", {
    requireInstalled: true,
  });
  if (!entResult.allowed) return { denied: entitlementDeniedResponse(entResult, corsHeaders) };

  // ─── Self-service bypass ───
  if (employeeId) {
    const { data: selfRow } = await supabase
      .from("employees")
      .select("user_id")
      .eq("id", employeeId)
      .maybeSingle();
    if ((selfRow as any)?.user_id === userId) return { ok: true, userId };
  }

  const { requireModulePermission } = await import("../permissionCheck.ts");
  const denied = await requireModulePermission(
    supabase, userId, organizationId, "payroll", "read", corsHeaders,
  );
  if (denied) return { denied };
  return { ok: true, userId };
}
