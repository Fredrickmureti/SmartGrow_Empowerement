import { useEffect, useState } from 'react';
import type { WorkstationRead, SupervisorStatus, InstallerResult } from '../types';
import { select } from '../lib/supabase';
import { subscribeTable } from '../lib/realtime';
import { CertificatePanel } from '../components/CertificatePanel';
import { UpdatesPanel } from '../components/UpdatesPanel';
import { IdChip } from '../components/IdChip';
import { clockTime, relativeTime, uptimeLabel } from '../lib/identity';

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
  const [svc, setSvc] = useState<(InstallerResult & { installerAvailable?: boolean }) | null>(null);
  const [agentMsg, setAgentMsg] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);

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
      try { setSvc(await window.edge.supervisor.serviceStatus()); }
      catch { setSvc(null); }
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

  const startAgent = async () => {
    setAgentBusy(true); setAgentMsg(null);
    try {
      const r = await window.edge.agent.start();
      if (r.ok) setAgentMsg(r.external ? 'A runtime is already listening on this workstation.' : `Runtime started (pid ${r.pid ?? '—'}).`);
      else setAgentMsg(`Start failed: ${r.error}${r.detail ? ` — ${r.detail}` : ''}. See the Logs tab for the runtime output.`);
      await refresh();
    } finally { setAgentBusy(false); }
  };

  return (
    <>
      <div className="page-head row-between">
        <div>
          <div className="page-eyebrow">Workstation</div>
          <h1 className="page-title">{workstation.name ?? 'Unnamed workstation'}</h1>
          <div className="identity-row">
            <IdChip kind="workstation" value={workstation.workstation_id} />
            <span className="muted" style={{ fontSize: 12 }}>in</span>
            <IdChip kind="organization" value={workstation.organization_id} />
          </div>
        </div>
        <div className="page-head-actions">
          {agentRunning
            ? <span className="pill ok"><span className="pill-dot" />Runtime online</span>
            : <span className="pill err"><span className="pill-dot" />Runtime offline</span>}
          {relayFresh
            ? <span className="pill ok"><span className="pill-dot" />Cloud link healthy</span>
            : <span className="pill warn"><span className="pill-dot" />Cloud link stale</span>}
        </div>
      </div>

      <div className="panel">
        <h2>Connection</h2>
        <p className="panel-sub">How this workstation reaches AccrualFlow, and how the browser reaches it.</p>
        <div className="grid-3">
          <div className="stat">
            <div className="stat-label">Last cloud heartbeat</div>
            <div className="stat-value">{relativeTime(row?.last_seen_at)}</div>
            <div className="stat-hint">{clockTime(row?.last_seen_at) || 'No heartbeat received yet'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Runtime version</div>
            <div className="stat-value mono">{row?.version ?? '—'}</div>
            <div className="stat-hint">{agentRunning ? `Process ${agentPid ?? '—'}` : 'Not running on this device'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Local address</div>
            <div className="stat-value mono">
              {tls?.enabled ? `127.0.0.1:${tls.port ?? 8443}` : '127.0.0.1:8043'}
            </div>
            <div className="stat-hint">
              {tls?.enabled ? 'Encrypted (HTTPS)' : 'Unencrypted (HTTP) — issue a certificate below'}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Runtime control</h2>
        <p className="panel-sub">Start, stop, or restart the AccrualFlow Edge runtime on this device.</p>
        <div className="button-row">
          <button className="btn" disabled={agentBusy} onClick={startAgent}>
            {agentBusy ? 'Starting…' : agentRunning ? 'Restart runtime' : 'Start runtime'}
          </button>
          <button className="btn secondary" disabled={!agentRunning}
            onClick={() => window.edge.agent.stop().then(refresh)}>Stop runtime</button>
        </div>
        {agentMsg && <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>{agentMsg}</div>}
      </div>

      <CertificatePanel onChanged={refresh} />

      <UpdatesPanel />

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
        <div className="grid-4">
          <div className="stat">
            <div className="stat-label">Supervisor</div>
            <div className="stat-value">
              {supStatus?.ok
                ? <span className="pill ok"><span className="pill-dot" />Running</span>
                : <span className="pill warn"><span className="pill-dot" />
                    {svc && svc.installerAvailable === false
                      ? 'Not available'
                      : svc && !svc.ok
                        ? 'Not installed'
                        : supStatus?.error === 'supervisor_not_running'
                          ? 'Installed · stopped'
                          : supStatus?.error ?? 'Offline'}
                  </span>}
            </div>
            {supStatus?.ok && <div className="stat-hint">Process {supStatus.pid}</div>}
            {svc?.installerAvailable === false && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                This build was packaged without the Edge runtime. Repackage with the agent bundled as an extra resource.
              </div>
            )}
          </div>
          <div className="stat">
            <div className="stat-label">Uptime</div>
            <div className="stat-value">{supStatus?.ok ? uptimeLabel(supStatus.uptime_s) : '—'}</div>
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
        {supMsg && <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>{supMsg}</div>}
      </div>
    </>
  );
}
