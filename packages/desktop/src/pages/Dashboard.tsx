import { useEffect, useState } from 'react';
import type { WorkstationRead } from '../types';
import { select } from '../lib/supabase';
import { subscribeTable } from '../lib/realtime';

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

      {err && <div className="panel" style={{ borderColor: 'var(--edge-err)' }}>
        <div className="error-inline">{err}</div>
      </div>}
    </>
  );
}
