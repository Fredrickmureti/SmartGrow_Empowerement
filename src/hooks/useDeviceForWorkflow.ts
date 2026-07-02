/**
 * useDeviceForWorkflow — workflow-aware sibling of useDeviceForRole.
 *
 * Resolves the printer (via printer_workflow_bindings → printer_profiles
 * → device_assignments) that should serve a given workflow at the current
 * scope. Use this in admin/binding UI to render "which printer prints
 * what" — runtime printing goes through `printLabelByTemplate`, which
 * calls the same resolver server-side.
 *
 * Returns `device: null` when no binding exists or the resolver could
 * not match a profile to an assignment.
 */
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useBusinesses } from '@/hooks/useBusinesses';
import { useDeviceAssignments, type DeviceAssignment } from '@/hooks/useDeviceAssignments';
import type { PrinterWorkflow } from '@/services/printing/labelDispatch';

interface Resolved {
  printer_profile_id: string;
  binding_id: string;
  scope: string;
}

export interface DeviceForWorkflowResult {
  device: DeviceAssignment | null;
  resolved: Resolved | null;
  isLoading: boolean;
  error: Error | null;
}

export interface DeviceForWorkflowOptions {
  branchId?: string | null;
  warehouseId?: string | null;
}

export function useDeviceForWorkflow(
  workflow: PrinterWorkflow,
  opts: DeviceForWorkflowOptions = {},
): DeviceForWorkflowResult {
  const { currentBusiness } = useBusinesses();
  const orgId = currentBusiness?.id ?? null;
  const { assignments, isLoading: assignmentsLoading } = useDeviceAssignments();

  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!orgId) { setResolved(null); return; }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      const { data, error: rpcErr } = await supabase.rpc('resolve_workflow_printer', {
        p_org_id: orgId,
        p_workflow: workflow,
        p_branch_id: opts.branchId ?? null,
        p_warehouse_id: opts.warehouseId ?? null,
      });
      if (cancelled) return;
      if (rpcErr) { setError(new Error(rpcErr.message)); setResolved(null); }
      else {
        const row = Array.isArray(data) ? data[0] : data;
        setResolved((row as Resolved | undefined) ?? null);
      }
      setIsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [orgId, workflow, opts.branchId, opts.warehouseId]);

  // Map printer_profile_id → DeviceAssignment via `source_config_id`
  // (the field that links an assignment back to its printer-config row).
  // The actual print dispatch is server-side via printLabelByTemplate,
  // which uses the resolver RPC directly — this hook is for UI surfaces
  // ("which device is bound to this workflow?"). Returns null when no
  // assignment row mirrors the resolved profile id.
  const device =
    (resolved && assignments.find((a) => a.source_config_id === resolved.printer_profile_id)) ||
    null;

  return { device, resolved, isLoading: isLoading || assignmentsLoading, error };
}
