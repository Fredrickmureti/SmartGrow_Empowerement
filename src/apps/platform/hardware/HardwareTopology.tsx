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
    <div style={{ padding: 24 }}>
      <h1 style={{ marginBottom: 8 }}>Hardware Topology</h1>
      <p style={{ color: '#666', marginBottom: 24 }}>
        Live binding map for every device registered to this organization. Connection state
        is refreshed by the device ping loop — open Diagnostics to drive a recheck.
      </p>
      {Array.from(byBusiness.entries()).map(([bizKey, group]) => (
        <section key={bizKey} style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>
            {bizKey === '__tenant__' ? 'Tenant defaults' : `Business ${bizKey}`}
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                <th style={{ padding: 8 }}>Scope</th>
                <th style={{ padding: 8 }}>Role</th>
                <th style={{ padding: 8 }}>Driver</th>
                <th style={{ padding: 8 }}>Transport</th>
                <th style={{ padding: 8 }}>Name</th>
                <th style={{ padding: 8 }}>Enabled</th>
                <th style={{ padding: 8 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {group.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8 }}>{r.scopeKind}{r.scopeId ? `:${r.scopeId.slice(0, 8)}` : ''}</td>
                  <td style={{ padding: 8 }}>{r.role}</td>
                  <td style={{ padding: 8 }}>{r.driver}</td>
                  <td style={{ padding: 8 }}>{r.transport}</td>
                  <td style={{ padding: 8 }}>{r.displayName ?? '—'}</td>
                  <td style={{ padding: 8 }}>{r.enabled ? 'yes' : 'no'}</td>
                  <td style={{ padding: 8, color: r.connected ? '#0a7' : '#a30' }}>
                    {r.connected ? 'online' : 'offline'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
