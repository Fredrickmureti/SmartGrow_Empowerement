import { useEffect, useState } from 'react';
import type { WorkstationRead } from '../types';
import { select } from '../lib/supabase';
import { subscribeTable } from '../lib/realtime';
import { IdChip } from '../components/IdChip';
import { clockTime, humanize, relativeTime, roleLabel, transportLabel } from '../lib/identity';

interface Props { workstation: WorkstationRead }

interface DeviceRow {
  id: string;
  device_key: string;
  role: string;
  transport: string;
  driver: string | null;
  name: string | null;
  health: string;
  last_seen_at: string | null;
  capabilities: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Live device inventory backed by `public.workstation_devices` (Phase 3
 * capability model). We render whatever the agent last published via
 * `edge-workstation-manifest`; there is no local caching so a stale row
 * means the agent stopped publishing (surfaces as `health = offline`
 * once the 60s heartbeat is missed).
 */
export function Devices({ workstation }: Props) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    if (!workstation.workstation_id) return;
    try {
      const rows = await select<DeviceRow>(
        'workstation_devices',
        `workstation_id=eq.${workstation.workstation_id}` +
        `&select=id,device_key,role,transport,driver,name,health,last_seen_at,capabilities,metadata` +
        `&order=role.asc,name.asc`,
      );
      setDevices(rows);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };

  useEffect(() => {
    refresh();
    // Phase 4.2 item 2 — Realtime-first; poll every 45s as a safety net.
    let sub: { close(): void } | null = null;
    if (workstation.workstation_id) {
      sub = subscribeTable({
        table: 'workstation_devices',
        event: '*',
        filter: `workstation_id=eq.${workstation.workstation_id}`,
        onChange: () => refresh(),
      });
    }
    const t = setInterval(refresh, 45_000);
    return () => { clearInterval(t); sub?.close(); };
  }, [workstation.workstation_id]);

  return (
    <>
      <div className="page-head row-between">
        <div>
          <div className="page-eyebrow">Inventory</div>
          <h1 className="page-title">Devices</h1>
          <p className="page-sub">
            Hardware this workstation has published to AccrualFlow. Re-probed automatically every 60 seconds.
          </p>
        </div>
        <div className="page-head-actions">
          <span className="tag">{devices.length} connected</span>
          <button className="btn secondary" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        {loading && <div style={{ padding: 20 }} className="muted">Loading devices…</div>}
        {!loading && devices.length === 0 && (
          <div className="empty-state">
            <h3>No devices yet</h3>
            <p>
              Plug in a printer, scanner, or drawer. The runtime probes on start and every
              60&nbsp;seconds, and anything it finds appears here automatically.
            </p>
          </div>
        )}
        {devices.length > 0 && (
          <table className="edge-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Role</th>
                <th>Connection</th>
                <th>Capabilities</th>
                <th>Status</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className="cell-primary">{d.name ?? roleLabel(d.role)}</div>
                    <div className="cell-secondary"><IdChip kind="device" value={d.id} /></div>
                  </td>
                  <td><span className="tag">{roleLabel(d.role)}</span></td>
                  <td>
                    <div className="cell-primary">{transportLabel(d.transport)}</div>
                    <div className="cell-secondary">{d.driver ? `${humanize(d.driver)} driver` : 'Generic driver'}</div>
                  </td>
                  <td style={{ maxWidth: 260 }}>
                    <div className="cell-secondary" style={{ marginTop: 0 }}>{formatCaps(d.capabilities)}</div>
                  </td>
                  <td><HealthPill health={d.health} /></td>
                  <td>
                    <div className="cell-primary">{relativeTime(d.last_seen_at)}</div>
                    <div className="cell-secondary">{clockTime(d.last_seen_at)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {err && <div className="panel" style={{ borderColor: 'var(--edge-err)' }}>
        <div className="error-inline">{err}</div>
      </div>}
    </>
  );
}

function HealthPill({ health }: { health: string }) {
  const cls = health === 'ok' ? 'ok' : health === 'offline' || health === 'error' ? 'err' : 'warn';
  const label = health === 'ok' ? 'Ready' : health === 'offline' ? 'Offline' : health === 'error' ? 'Error' : humanize(health);
  return <span className={`pill ${cls}`}><span className="pill-dot" />{label}</span>;
}

function formatCaps(caps: Record<string, unknown> | null): string {
  if (!caps || Object.keys(caps).length === 0) return 'No reported capabilities';
  return Object.entries(caps)
    .slice(0, 3)
    .map(([k, v]) => `${humanize(k)}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}
