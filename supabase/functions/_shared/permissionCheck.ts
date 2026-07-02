/**
 * Shared Permission Check Utility for Edge Functions
 *
 * Single source of truth for module-level authorization in edge functions.
 * Delegates to the `user_has_module_permission` SQL function which is the
 * SAME authority used by RLS policies on payroll, employees, etc.
 *
 * Why this exists:
 *   Re-implementing permission logic inside edge functions causes drift
 *   from the database schema (e.g. querying non-existent columns on
 *   permission_group_rules). Always call this helper instead.
 *
 * Operations:
 *   - "read"   → can view records
 *   - "create" → can create new records (and run dry-run/preview)
 *   - "write"  → can update / approve / post records
 *   - "delete" → can void / reverse / delete records
 *
 * Modules (must match permission_modules enum):
 *   payroll, financials, contacts, products, sales, purchases, hr, …
 */

interface PermissionResult {
  allowed: boolean;
  reason?: string;
  status?: number;
}

/**
 * Check whether the calling user has the requested permission on a module
 * within an organization. Also verifies the user has an active membership.
 */
export async function checkModulePermission(
  supabaseAdmin: any,
  userId: string,
  orgId: string,
  module: string,
  op: "read" | "create" | "write" | "delete",
): Promise<PermissionResult> {
  if (!userId) return { allowed: false, reason: "Unauthorized", status: 401 };
  if (!orgId) return { allowed: false, reason: "No organization specified", status: 400 };

  // 1. Verify the user has an ACTIVE role in this org. A soft-deleted
  //    member must never pass authorization.
  const { data: roleRow, error: roleErr } = await supabaseAdmin
    .from("user_roles")
    .select("role, is_active")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .maybeSingle();

  if (roleErr) {
    console.error("[permissionCheck] role lookup error:", roleErr);
    return { allowed: false, reason: "Permission lookup failed", status: 500 };
  }

  if (!roleRow) {
    return { allowed: false, reason: "No active access to this organization", status: 403 };
  }

  // 2. Delegate the actual permission decision to the DB RPC. This is the
  //    same function RLS uses, so frontend, RLS and edge functions stay
  //    aligned automatically.
  const { data: allowed, error: rpcErr } = await supabaseAdmin.rpc(
    "user_has_module_permission",
    {
      _user_id: userId,
      _org_id: orgId,
      _module: module,
      _operation: op,
    },
  );

  if (rpcErr) {
    console.error("[permissionCheck] RPC error:", rpcErr);
    return { allowed: false, reason: "Permission check failed", status: 500 };
  }

  if (!allowed) {
    return {
      allowed: false,
      reason: `You don't have permission to ${op} ${module}. Ask an admin to grant your Access Group the "${module}.${op}" permission.`,
      status: 403,
    };
  }

  return { allowed: true };
}

/**
 * Helper: build a standard 401/403/500 Response for a denied check.
 */
export function permissionDeniedResponse(
  result: PermissionResult,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: result.reason ?? "Permission denied",
      code: "PERMISSION_DENIED",
    }),
    {
      status: result.status ?? 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

/**
 * Convenience wrapper: check + return an early Response if denied.
 *
 * Usage:
 *   const denied = await requireModulePermission(
 *     supabaseAdmin, userId, orgId, "payroll", "create", corsHeaders,
 *   );
 *   if (denied) return denied;
 */
export async function requireModulePermission(
  supabaseAdmin: any,
  userId: string,
  orgId: string,
  module: string,
  op: "read" | "create" | "write" | "delete",
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const result = await checkModulePermission(supabaseAdmin, userId, orgId, module, op);
  if (result.allowed) return null;
  return permissionDeniedResponse(result, corsHeaders);
}
