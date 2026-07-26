import { useEffect, useState } from 'react';
import type { ProbeOp, ProbeRequest, ProbeResponse, WorkstationRead } from '../types';
import { select } from '../lib/supabase';
import { SUPABASE_ANON_KEY } from '../lib/config';

interface Props { workstation: WorkstationRead }

interface DeviceRow {
  id: string;
  device_key: string;
  role: string;
  transport: string;
  driver: string | null;
  name: string | null;
  capabilities: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Diagnostics — self-test suite plus per-device probes.
 *
 * Environment section runs the three cheap checks (workstation.json,
 * agent liveness, Supabase reachability). Device probes read the live
 * `workstation_devices` inventory and offer role-specific actions
 * (test page, drawer kick, USB tree, network ping) that hit the agent's
 * `POST /probe` endpoint via the preload IPC bridge. The bearer token
 * is injected in main, so the renderer never sees it.
 */
type Result = { name: string; status: 'pending' | 'ok' | 'fail'; detail?: string };

export function Diagnostics({ workstation }: Props) {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [probeState, setProbeState] = useState<Record<string, { running: boolean; last?: ProbeResponse }>>({});

  async function runAll() {
    setRunning(true);
    const next: Result[] = [
      { name: 'workstation.json readable', status: 'pending' },
      { name: 'Agent process alive', status: 'pending' },
      { name: 'Supabase reachable', status: 'pending' },
    ];
    setResults([...next]);

    // 1. workstation.json readable
    const ws = await window.edge.workstation.read();
    next[0] = ws.exists && ws.has_secret
      ? { name: next[0].name, status: 'ok', detail: shortId('workstation', ws.workstation_id) }
      : { name: next[0].name, status: 'fail', detail: ws.error ?? 'file missing' };
    setResults([...next]);

    // 2. Agent alive
    const status = await window.edge.agent.status();
    next[1] = status.running
      ? { name: next[1].name, status: 'ok', detail: `pid=${status.pid}` }
      : { name: next[1].name, status: 'fail', detail: 'agent not running — start it from the Dashboard' };
    setResults([...next]);

    // 3. Supabase REST reachability. /auth/v1/health can return 401 on
    // hosted Supabase; an OPTIONS preflight against PostgREST proves the
    // gateway is reachable without requiring a table-specific request.
    try {
      const res = await fetch(`${workstation.supabase_url}/rest/v1/`, {
        method: 'OPTIONS',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      });
      next[2] = res.ok
        ? { name: next[2].name, status: 'ok', detail: `HTTP ${res.status}` }
        : { name: next[2].name, status: 'fail', detail: `HTTP ${res.status}` };
    } catch (e) {
      next[2] = { name: next[2].name, status: 'fail', detail: e instanceof Error ? e.message : String(e) };
    }
    setResults([...next]);

    setRunning(false);
  }

  useEffect(() => {
    if (!workstation.workstation_id) return;
    select<DeviceRow>(
      'workstation_devices',
      `workstation_id=eq.${workstation.workstation_id}` +
      `&select=id,device_key,role,transport,driver,name,capabilities,metadata` +
      `&order=role.asc,name.asc`,
    ).then(setDevices).catch(() => setDevices([]));
  }, [workstation.workstation_id]);

  async function runProbe(device: DeviceRow, op: ProbeOp) {
    const key = `${device.id}::${op}`;
    setProbeState((s) => ({ ...s, [key]: { running: true, last: s[key]?.last } }));
    const req: ProbeRequest = { deviceId: device.id, role: device.role, op, target: buildTarget(device) };
    const resp = await window.edge.agent.probe(req);
    setProbeState((s) => ({ ...s, [key]: { running: false, last: resp } }));
  }

  return (
    <>
      <div className="row-between" style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Diagnostics</h1>
        <button className="btn" onClick={runAll} disabled={running}>
          {running ? 'Running…' : 'Run self-test'}
        </button>
      </div>

      <div className="panel">
        <h2>Environment</h2>
        <p className="panel-sub">Verifies the local prerequisites for AccrualFlow Edge to broker hardware calls.</p>
        {results.length === 0 && <p className="muted">Click <em>Run self-test</em> to check the workstation.</p>}
        {results.length > 0 && (
          <table className="edge-table">
            <thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>{r.status === 'ok'
                    ? <span className="pill ok"><span className="pill-dot" />pass</span>
                    : r.status === 'fail'
                      ? <span className="pill err"><span className="pill-dot" />fail</span>
                      : <span className="pill warn"><span className="pill-dot" />pending</span>}
                  </td>
                  <td className="mono muted">{r.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Device probes</h2>
        <p className="panel-sub">
          Run a curated action against a device. Each probe has a 5&nbsp;s server-side cooldown per
          (device, op) so click-happy testing can't hammer the transport.
        </p>
        {devices.length === 0 && (
          <p className="muted">No devices published yet — plug in and connect on the Devices tab.</p>
        )}
        {devices.length > 0 && (
          <table className="edge-table">
            <thead><tr><th>Device</th><th>Role</th><th>Actions</th><th>Last result</th></tr></thead>
            <tbody>
              {devices.map((d) => {
                const ops = availableOps(d);
                return (
                  <tr key={d.id}>
                    <td>{d.name ?? <span className="muted mono">{d.id.slice(0, 8)}</span>}</td>
                    <td>{d.role}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {ops.length === 0 && <span className="muted">—</span>}
                        {ops.map((op) => {
                          const key = `${d.id}::${op}`;
                          const st = probeState[key];
                          return (
                            <button
                              key={op}
                              className="btn secondary"
                              disabled={st?.running}
                              onClick={() => runProbe(d, op)}
                            >
                              {st?.running ? '…' : opLabel(op)}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="mono muted" style={{ maxWidth: 280 }}>
                      {renderLast(probeState, d)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function opLabel(op: ProbeOp): string {
  switch (op) {
    case 'printer.test_page': return 'Print test page';
    case 'drawer.kick': return 'Kick drawer';
    case 'network.ping': return 'Ping';
    case 'usb.list': return 'List USB';
  }
}

function availableOps(d: DeviceRow): ProbeOp[] {
  const ops: ProbeOp[] = [];
  if (d.role === 'receipt_printer' || d.role === 'kitchen_printer' || d.role === 'label_printer') {
    ops.push('printer.test_page');
  }
  if (d.role === 'cash_drawer') ops.push('drawer.kick');
  if (d.transport === 'network' || d.transport === 'tcp') ops.push('network.ping');
  if (d.transport === 'usb') ops.push('usb.list');
  return ops;
}

function buildTarget(d: DeviceRow): ProbeRequest['target'] {
  const c = (d.metadata ?? {}) as Record<string, unknown>;
  const parsed = parseTcpKey(d.device_key);
  const transport = d.transport === 'tcp' || d.transport === 'network'
    ? 'network'
    : d.transport === 'usb'
      ? 'usb'
      : undefined;
  return {
    transport,
    driver: d.driver ?? undefined,
    ipAddress: typeof c.ipAddress === 'string' ? c.ipAddress : typeof c.host === 'string' ? c.host : parsed?.ipAddress,
    port: typeof c.port === 'number' ? c.port : parsed?.port,
    vendorId: typeof c.vendorId === 'number' ? c.vendorId : undefined,
    productId: typeof c.productId === 'number' ? c.productId : undefined,
  };
}

function parseTcpKey(key: string): { ipAddress: string; port: number } | null {
  const m = /^tcp:(.+):(\d+)$/.exec(key);
  if (!m) return null;
  return { ipAddress: m[1], port: Number(m[2]) };
}

function renderLast(state: Record<string, { running: boolean; last?: ProbeResponse }>, d: DeviceRow): string {
  const entries = Object.entries(state).filter(([k]) => k.startsWith(`${d.id}::`));
  if (entries.length === 0) return '—';
  const [key, val] = entries[entries.length - 1];
  if (!val.last) return val.running ? 'running…' : '—';
  const op = key.split('::')[1];
  if (val.last.success) {
    const extras: string[] = [];
    if (val.last.responseTimeMs != null) extras.push(`${val.last.responseTimeMs}ms`);
    if (val.last.bytesWritten != null) extras.push(`${val.last.bytesWritten}B`);
    if (val.last.cached) extras.push(`cached ${Math.round((val.last.cooldownMs ?? 0) / 100) / 10}s`);
    return `✓ ${op}${extras.length ? ' — ' + extras.join(', ') : ''}`;
  }
  return `✗ ${op} — ${val.last.error ?? 'failed'}`;
}
