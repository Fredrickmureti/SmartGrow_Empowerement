/**
 * Phase 4 P4 — Contextualised drill-down resolver.
 *
 * Wraps the pure `resolveDrillTarget` resolver with the two pieces of
 * runtime context the resolver itself stays free of:
 *   - `mode` ("admin" vs "portal") inferred from `SelfServiceContext`,
 *   - the current user's permissions (suppress the target when missing).
 *
 * Keeping permission + mode resolution outside the pure module lets the
 * resolver remain trivially unit-testable and lets the architecture
 * tests assert the country-agnostic invariant statically.
 */
import { useMemo } from "react";
import { useSelfService } from "@/contexts/SelfServiceContext";
import { usePermissions } from "@/hooks/usePermissions";
import type { Permission } from "@/lib/permissions";
import {
  resolveDrillTarget,
  type DrillTarget,
  type ResolveContext,
} from "@/lib/payroll/payslipDrillDown";
import type { InputRef } from "@/lib/payroll/inputRef";

export interface UseDrillDownOptions {
  /** Employee whose payslip is being viewed (admin-side only). */
  employeeId?: string | null;
}

export function usePayslipDrillDown(
  ref: InputRef | null | undefined,
  opts: UseDrillDownOptions = {},
): { target: DrillTarget | null } {
  const { isSelfService } = useSelfService();
  const perms = usePermissions();

  const target = useMemo<DrillTarget | null>(() => {
    if (!ref) return null;
    const ctx: ResolveContext = {
      mode: isSelfService ? "portal" : "admin",
      employeeId: opts.employeeId ?? null,
    };
    const resolved = resolveDrillTarget(ref, ctx);
    if (!resolved) return null;
    if (resolved.requiresPermission) {
      if (!perms.can(resolved.requiresPermission as Permission)) return null;
    }
    return resolved;
  }, [ref, isSelfService, opts.employeeId, perms]);

  return { target };
}
