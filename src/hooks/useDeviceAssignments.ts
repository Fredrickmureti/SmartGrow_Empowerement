/**
 * useDeviceAssignments — Phase 2 single-registry hook.
 *
 * Reads from `device_assignments` (platform-scoped). Wave 9b dropped the
 * legacy `pos_hardware_configs` mirror; this is now the sole source.
 *
 * Scope filter:
 *   { kind: 'register', id }  → just-this-register rows + tenant defaults
 *   { kind: 'station', id }   → just-this-station rows  + tenant defaults
 *   { kind: 'user', id }      → just-this-user rows     + tenant defaults
 *   { kind: 'tenant' }        → tenant-wide rows only
 *   undefined                 → every row visible to the user
 *
 * Realtime: subscribes to the table for the current organization so the
 * Electron-side hydrator and any open browser tab stay coherent.
 */
import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/hooks/useOrganization';
import { subscribeAssignments } from '@/services/hardware/assignmentsRealtime';
import { toast } from 'sonner';

export type DeviceScope =
  | { kind: 'register' | 'station' | 'user'; id: string }
  | { kind: 'tenant' };

export interface DeviceAssignment {
  id: string;
  organization_id: string;
  business_id: string | null;
  scope_kind: 'register' | 'station' | 'user' | 'tenant';
  scope_id: string | null;
  role: string;
  transport: string;
  driver: string;
  display_name: string;
  config: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  enabled: boolean;
  is_default: boolean;
  status: string;
  last_seen_at: string | null;
  last_error: string | null;
  source_config_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertAssignmentInput {
  id?: string;
  scope_kind: DeviceAssignment['scope_kind'];
  scope_id?: string | null;
  role: string;
  transport: string;
  driver: string;
  display_name?: string;
  config?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  enabled?: boolean;
  is_default?: boolean;
  business_id?: string | null;
}

const QK = (orgId: string | undefined, scope?: DeviceScope) =>
  ['device-assignments', orgId ?? null, scope ?? null] as const;

export function useDeviceAssignments(scope?: DeviceScope) {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: QK(orgId, scope),
    enabled: Boolean(orgId),
    queryFn: async (): Promise<DeviceAssignment[]> => {
      if (!orgId) return [];
      let q = supabase
        .from('device_assignments')
        .select('*')
        .eq('organization_id', orgId)
        .order('is_default', { ascending: false })
        .order('role', { ascending: true });

      if (scope) {
        if (scope.kind === 'tenant') {
          q = q.eq('scope_kind', 'tenant');
        } else {
          // include both the targeted scope row AND tenant defaults
          q = q.or(
            `and(scope_kind.eq.${scope.kind},scope_id.eq.${scope.id}),scope_kind.eq.tenant`,
          );
        }
      }

      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as unknown as DeviceAssignment[]).map((r) => ({
        ...r,
        config: (r.config as Record<string, unknown>) ?? {},
        capabilities: (r.capabilities as Record<string, unknown>) ?? {},
      }));
    },
  });

  // Realtime — invalidate when any row for this org changes.
  // Wave 9d.9 (P4 #22): consumers share ONE channel per org via
  // `subscribeAssignments`; the per-hook UUID-named channel pattern was
  // costing 5–8 duplicate WebSocket subscriptions on Platform/POS views
  // and hitting realtime quota.
  useEffect(() => {
    if (!orgId) return;
    return subscribeAssignments(orgId, () => {
      qc.invalidateQueries({ queryKey: ['device-assignments'] });
    });
  }, [orgId, qc]);

  const upsert = useMutation({
    mutationFn: async (input: UpsertAssignmentInput): Promise<DeviceAssignment> => {
      if (!orgId) throw new Error('No active organization');
      const payload = {
        organization_id: orgId,
        business_id: input.business_id ?? null,
        scope_kind: input.scope_kind,
        scope_id: input.scope_id ?? null,
        role: input.role,
        transport: input.transport,
        driver: input.driver,
        display_name: input.display_name ?? input.role,
        config: input.config ?? {},
        capabilities: input.capabilities ?? {},
        enabled: input.enabled ?? true,
        is_default: input.is_default ?? false,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const table = supabase.from('device_assignments') as any;
      const builder = input.id
        ? table.update(payload).eq('id', input.id).select().single()
        : table.insert(payload).select().single();
      const { data, error } = await builder;
      if (error) throw error;
      return data as unknown as DeviceAssignment;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device-assignments'] });
      toast.success('Device assignment saved');
    },
    onError: (e) => toast.error(`Save failed: ${(e as Error).message}`),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('device_assignments').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device-assignments'] });
      toast.success('Device assignment removed');
    },
    onError: (e) => toast.error(`Delete failed: ${(e as Error).message}`),
  });

  const byRole = useMemo(() => {
    const map = new Map<string, DeviceAssignment[]>();
    for (const r of query.data ?? []) {
      const list = map.get(r.role) ?? [];
      list.push(r);
      map.set(r.role, list);
    }
    return map;
  }, [query.data]);

  return {
    assignments: query.data ?? [],
    byRole,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    upsert,
    remove,
  };
}
