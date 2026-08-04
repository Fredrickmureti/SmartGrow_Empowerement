import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/hooks/useOrganization';
import { supabase } from '@/integrations/supabase/client';
import { hardwareClient } from '@/services/hardware/HardwareClient';
import { WORKSTATION_LIVENESS_WINDOW_MS } from '@/services/hardware/readiness';

interface WorkstationRow {
  id: string;
  organization_id: string;
  name: string;
  version: string | null;
  last_seen_at: string | null;
}

/**
 * Production web relay mount — relay configuration only.
 *
 * On https://accrualflow.systems the browser cannot call the local agent's
 * plaintext loopback listener. This mount selects the freshest *live*
 * enrolled Edge workstation and enables Supabase relay dispatch for it.
 *
 * It deliberately no longer loads a device list into the renderer adapter.
 * Execution is keyed by the resolved `device_assignments` row
 * (`assignmentDispatch`), which carries its own endpoint and its own
 * owning workstation. The renderer's role-keyed registry was a second,
 * always-stale copy of the registry and is no longer a routing authority.
 */
export function EdgeRelayMount() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;

  const workstations = useQuery({
    queryKey: ['edge-workstations', orgId],
    enabled: Boolean(orgId) && !hardwareClient.devices.isElectron(),
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async (): Promise<WorkstationRow[]> => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from('workstations')
        .select('id,organization_id,name,version,last_seen_at')
        .eq('organization_id', orgId)
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as WorkstationRow[];
    },
  });

  /**
   * Pick the workstation this browser should route through.
   *
   * Previously this took the freshest row org-wide with no liveness window,
   * so a workstation that stopped polling days ago could still capture
   * routing for everyone and every dispatch would burn its full deadline.
   * Only workstations actually polling inside
   * `WORKSTATION_LIVENESS_WINDOW_MS` are eligible; the freshest wins.
   */
  const workstation = useMemo(() => {
    const rows = workstations.data ?? [];
    const live = rows.filter(
      (row) =>
        row.last_seen_at &&
        Date.now() - new Date(row.last_seen_at).getTime() <= WORKSTATION_LIVENESS_WINDOW_MS,
    );
    return live[0] ?? null;
  }, [workstations.data]);

  useEffect(() => {
    if (hardwareClient.devices.isElectron()) return;

    // Never tear down the relay while the query is merely in flight.
    if (workstations.isLoading) return;

    if (!orgId || !workstation?.id) {
      hardwareClient.agent.disableRelay();
      return;
    }

    hardwareClient.agent.enableRelay({
      organizationId: orgId,
      workstationId: workstation.id,
      defaultDeadlineMs: 45_000,
    });
  }, [orgId, workstation?.id, workstations.isLoading]);

  return null;
}
