/**
 * useDeviceForWorkflow — resolves the device_assignments row bound to a
 * printer_workflow at the current org/branch/warehouse scope.
 *
 * Phase 2b: switched from `resolve_workflow_printer` (which returned a
 * legacy `device_assignment_id`) to `resolve_device_for_workflow`, which
 * returns the canonical `device_assignment_id`. This is the runtime that
 * powers `printLabelByTemplate` and every UI surface that answers "which
 * device is bound to this workflow?".
 */
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useBusinesses } from '@/hooks/useBusinesses';
import { useDeviceAssignments, type DeviceAssignment } from '@/hooks/useDeviceAssignments';
import type { PrinterWorkflow } from '@/services/printing/labelDispatch';

interface Resolved {
  device_assignment_id: string;
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
      const { data, error: rpcErr } = await supabase.rpc('resolve_device_for_workflow', {
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

  const device =
    (resolved && assignments.find((a) => a.id === resolved.device_assignment_id)) || null;

  return { device, resolved, isLoading: isLoading || assignmentsLoading, error };
}
