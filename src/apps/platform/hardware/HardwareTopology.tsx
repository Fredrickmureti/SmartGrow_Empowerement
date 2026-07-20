/**
 * HardwareTopology — read-only operational view (Audit Wave 9d.7 P5).
 *
 * Renders the full live registry:
 *   business → branch → terminal → role → device → driver → transport → status
 *
 * Source of truth is the canonical `device_assignments` table joined with
 * live per-role status from `hardwareClient.devices.getStatuses()`. No
 * mutations — operators use the existing Devices page for binding changes.
 */
import { useMemo } from 'react';
import { useDeviceAssignments } from '@/hooks/useDeviceAssignments';
import { useHardwareProxy } from '@/hooks/hardware/useHardwareProxy';

type TopoNode = {
  businessId: string | null;
  scopeKind: string;
  scopeId: string | null;
  role: string;
  driver: string;
  transport: string;
  displayName: string | null;
  enabled: boolean;
  connected: boolean;
};

export default function HardwareTopology() {
  const { assignments } = useDeviceAssignments();
  const { deviceStatuses } = useHardwareProxy();

  const rows: TopoNode[] = useMemo(() => {
    return (assignments ?? []).map((a) => {
      const status = deviceStatuses.get(a.id);
      return {
        businessId: a.business_id,
        scopeKind: a.scope_kind,
        scopeId: a.scope_id,
        role: a.role,
        driver: a.driver,
        transport: a.transport,
        displayName: a.display_name ?? null,
        enabled: a.enabled,
        connected: status?.connected ?? false,
      };
    });
  }, [assignments, deviceStatuses]);

  // Group by business then by scope kind/id so the operator can scan the
  // tenant from the top down.
  const byBusiness = useMemo(() => {
    const m = new Map<string, TopoNode[]>();
    for (const r of rows) {
      const key = r.businessId ?? '__tenant__';
      const bucket = m.get(key) ?? [];
      bucket.push(r);
      m.set(key, bucket);
    }
    return m;
  }, [rows]);

  return (
    <div className="space-y-8 p-4 md:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Hardware Topology</h1>
        <p className="text-sm text-muted-foreground">
        Live binding map for every device registered to this organization. Connection state
        is refreshed by the device ping loop — open Diagnostics to drive a recheck.
      </p>
      </div>
      {Array.from(byBusiness.entries()).map(([bizKey, group]) => (
        <section key={bizKey} className="space-y-3">
          <h2 className="text-lg font-semibold">
            {bizKey === '__tenant__' ? 'Tenant defaults' : `Business ${bizKey}`}
          </h2>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                  <th className="p-2 font-medium">Scope</th>
                  <th className="p-2 font-medium">Role</th>
                  <th className="p-2 font-medium">Driver</th>
                  <th className="p-2 font-medium">Transport</th>
                  <th className="p-2 font-medium">Name</th>
                  <th className="p-2 font-medium">Enabled</th>
                  <th className="p-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {group.map((r, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="p-2">{r.scopeKind}{r.scopeId ? `:${r.scopeId.slice(0, 8)}` : ''}</td>
                    <td className="p-2">{r.role}</td>
                    <td className="p-2">{r.driver}</td>
                    <td className="p-2">{r.transport}</td>
                    <td className="p-2">{r.displayName ?? '—'}</td>
                    <td className="p-2">{r.enabled ? 'yes' : 'no'}</td>
                    <td className={"p-2 " + (r.connected ? "text-success" : "text-destructive")}>
                      {r.connected ? 'online' : 'offline'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
