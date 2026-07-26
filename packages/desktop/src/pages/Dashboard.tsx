import { useEffect, useState } from 'react';
import type { WorkstationRead, SupervisorStatus } from '../types';
import { select } from '../lib/supabase';
import { subscribeTable } from '../lib/realtime';
import { CertificatePanel } from '../components/CertificatePanel';

interface Props { workstation: WorkstationRead }

interface WorkstationRow { id: string; name: string; version: string | null; last_seen_at: string | null }
interface TlsInfo { enabled: boolean; fingerprint_sha256?: string; port?: number }

/**
 * Dashboard — at-a-glance workstation health.
 *
 * Data sources:
 *   - Agent process state from IPC (`edge.agent.status`).
 *   - Workstation heartbeat and version from `public.workstations` via
 *     PostgREST. We poll on a 10s interval; a Realtime subscription would
 *     be cleaner but would require the JS client + ws upgrade support,
 *     which is more surface area than the dashboard needs.
 */
export function Dashboard({ workstation }: Props) {
  const [agentRunning, setAgentRunning] = useState<boolean | null>(null);
  const [agentPid, setAgentPid] = useState<number | null>(null);
  const [row, setRow] = useState<WorkstationRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tls, setTls] = useState<TlsInfo | null>(null);
  const [supStatus, setSupStatus] = useState<SupervisorStatus | null>(null);
  const [supBusy, setSupBusy] = useState<string | null>(null);
  const [supMsg, setSupMsg] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const status = await window.edge.agent.status();
      setAgentRunning(status.running);
      setAgentPid(status.pid);
      if (workstation.workstation_id) {
        const rows = await select<WorkstationRow>(
          'workstations',
          `id=eq.${workstation.workstation_id}&select=id,name,version,last_seen_at`,
        );
        setRow(rows[0] ?? null);
      }
      // Poll the agent's /tls-info so the "Local loopback" stat reflects
      // reality. Auth-free by design (only the SHA-256 fingerprint is
      // exposed — no private material).
      try {
        const r = await fetch('http://127.0.0.1:8043/tls-info', { cache: 'no-store' });
        if (r.ok) setTls(await r.json());
      } catch { setTls({ enabled: false }); }
      try { setSupStatus(await window.edge.supervisor.status()); }
      catch (e) { setSupStatus({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    refresh();
    // Realtime-first (Phase 4.2 item 2). Poll every 30s as a safety net
    // in case the ws connection is silently dropped.
    let sub: { close(): void } | null = null;
    if (workstation.workstation_id) {
      sub = subscribeTable({
        table: 'workstations',
        event: 'UPDATE',
        filter: `id=eq.${workstation.workstation_id}`,
        onChange: () => refresh(),
      });
    }
    const t = setInterval(refresh, 30_000);
    return () => { clearInterval(t); sub?.close(); };
  }, [workstation.workstation_id]);

  const relayFresh = row?.last_seen_at
    ? (Date.now() - new Date(row.last_seen_at).getTime()) < 120_000
    : false;

  const runSup = async (op: 'install' | 'uninstall' | 'start' | 'stop' | 'reload') => {
    setSupBusy(op); setSupMsg(null);
    try {
      const r = op === 'reload'
        ? await window.edge.supervisor.reload()
        : await window.edge.supervisor[op]();
      setSupMsg(r.ok ? `${op}: ok` : `${op} failed: ${r.error ?? ('stderr' in r ? r.stderr : 'unknown')}`);
      await refresh();
    } finally { setSupBusy(null); }
  };

  return (
    <>
      <div className="row-between" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>{workstation.name}</h1>
          <div className="muted mono" style={{ fontSize: 12 }}>{workstation.workstation_id}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {agentRunning
            ? <span className="pill ok"><span className="pill-dot" />Agent running · pid {agentPid}</span>
            : <span className="pill err"><span className="pill-dot" />Agent stopped</span>}
          {relayFresh
            ? <span className="pill ok"><span className="pill-dot" />Relay fresh</span>
            : <span className="pill warn"><span className="pill-dot" />Relay stale</span>}
        </div>
      </div>

      <div className="panel">
        <h2>Connection</h2>
        <p className="panel-sub">Live status of the two transports that connect this workstation to AccrualFlow.</p>
        <div className="grid-2">
          <div className="stat">
            <div className="stat-label">Relay heartbeat</div>
            <div className="stat-value">{row?.last_seen_at ? new Date(row.last_seen_at).toLocaleTimeString() : '—'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Agent version</div>
            <div className="stat-value mono">{row?.version ?? '—'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Local loopback</div>
            <div className="stat-value">
              {tls?.enabled
                ? `https://127.0.0.1:${tls.port ?? 8443}`
                : 'http://127.0.0.1:8043'}
            </div>
            {tls?.enabled && tls.fingerprint_sha256 && (
              <div className="muted mono" style={{ fontSize: 10, wordBreak: 'break-all', marginTop: 4 }}>
                fp: {tls.fingerprint_sha256}
              </div>
            )}
          </div>
          <div className="stat">
            <div className="stat-label">Organization</div>
            <div className="stat-value mono">{workstation.organization_id}</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Agent runtime</h2>
        <p className="panel-sub">Start, stop, or restart the AccrualFlow Edge runtime on this device.</p>
        <div className="button-row">
          <button className="btn" onClick={() => window.edge.agent.start().then(refresh)}>
            {agentRunning ? 'Restart agent' : 'Start agent'}
          </button>
          <button className="btn secondary" disabled={!agentRunning}
            onClick={() => window.edge.agent.stop().then(refresh)}>Stop agent</button>
        </div>
      </div>

      <CertificatePanel onChanged={refresh} />

      {err && <div className="panel" style={{ borderColor: 'var(--edge-err)' }}>
        <div className="error-inline">{err}</div>
      </div>}


      <div className="panel">
        <h2>Service supervisor</h2>
        <p className="panel-sub">
          Host the runtime under a platform-native service so it survives
          reboot, logout, and laptop-lid-close. The tray app connects to it
          over a local named pipe / unix socket.
        </p>
        <div className="grid-2">
          <div className="stat">
            <div className="stat-label">Supervisor</div>
            <div className="stat-value">
              {supStatus?.ok
                ? <span className="pill ok"><span className="pill-dot" />online · pid {supStatus.pid}</span>
                : <span className="pill warn"><span className="pill-dot" />{supStatus?.error ?? 'offline'}</span>}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Uptime</div>
            <div className="stat-value mono">
              {supStatus?.ok && typeof supStatus.uptime_s === 'number'
                ? `${Math.floor(supStatus.uptime_s / 60)}m ${supStatus.uptime_s % 60}s`
                : '—'}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Runtime</div>
            <div className="stat-value mono">{supStatus?.version ?? '—'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Platform</div>
            <div className="stat-value mono">{supStatus?.platform ?? '—'}</div>
          </div>
        </div>
        <div className="button-row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={supBusy !== null}
            onClick={() => runSup('install')}>Install as service</button>
          <button className="btn secondary" disabled={supBusy !== null}
            onClick={() => runSup('start')}>Start</button>
          <button className="btn secondary" disabled={supBusy !== null}
            onClick={() => runSup('stop')}>Stop</button>
          <button className="btn secondary" disabled={supBusy !== null || !supStatus?.ok}
            onClick={() => runSup('reload')}>Reload origins</button>
          <button className="btn secondary" disabled={supBusy !== null}
            onClick={() => runSup('uninstall')}>Uninstall</button>
        </div>
        {supMsg && <div className="muted mono" style={{ marginTop: 8, fontSize: 12 }}>{supMsg}</div>}
      </div>
    </>
  );
}
