import { useEffect, useState } from 'react';
import type { WorkstationRead } from '../types';
import { select } from '../lib/supabase';

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
        `&select=id,device_key,role,transport,driver,name,health,last_seen_at,capabilities` +
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
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [workstation.workstation_id]);

  return (
    <>
      <div className="row-between" style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Devices</h1>
        <button className="btn secondary" onClick={refresh}>Refresh</button>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        {loading && <div style={{ padding: 20 }} className="muted">Loading devices…</div>}
        {!loading && devices.length === 0 && (
          <div style={{ padding: 20 }} className="muted">
            No devices published yet. The agent probes on start and every 60&nbsp;seconds — plug in a
            printer or connect a scanner and it will appear here.
          </div>
        )}
        {devices.length > 0 && (
          <table className="edge-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Transport</th>
                <th>Driver</th>
                <th>Capabilities</th>
                <th>Health</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>{d.name ?? <span className="muted mono">{d.device_key}</span>}</td>
                  <td>{d.role}</td>
                  <td>{d.transport}</td>
                  <td className="mono">{d.driver ?? '—'}</td>
                  <td className="mono" style={{ maxWidth: 260 }}>
                    {formatCaps(d.capabilities)}
                  </td>
                  <td><HealthPill health={d.health} /></td>
                  <td className="muted">{d.last_seen_at ? new Date(d.last_seen_at).toLocaleTimeString() : '—'}</td>
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
  return <span className={`pill ${cls}`}><span className="pill-dot" />{health}</span>;
}

function formatCaps(caps: Record<string, unknown> | null): string {
  if (!caps || Object.keys(caps).length === 0) return '—';
  return Object.entries(caps)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(', ');
}
