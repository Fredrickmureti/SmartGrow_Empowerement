import { useState } from 'react';
import type { WorkstationRead } from '../types';

interface Props { workstation: WorkstationRead }

/**
 * Diagnostics — self-test suite. Each check runs a small probe and reports
 * pass/fail with a plain-English remediation hint. This is deliberately
 * minimal in the scaffold; Phase 4 follow-ups wire it into real capability
 * probes (test-page print, USB tree, scale read) via the loopback API on
 * https://127.0.0.1:8043 once the local-TLS work in Phase 4 lands.
 */
type Result = { name: string; status: 'pending' | 'ok' | 'fail'; detail?: string };

export function Diagnostics({ workstation }: Props) {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);

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
      ? { name: next[0].name, status: 'ok', detail: `id=${ws.workstation_id}` }
      : { name: next[0].name, status: 'fail', detail: ws.error ?? 'file missing' };
    setResults([...next]);

    // 2. Agent alive
    const status = await window.edge.agent.status();
    next[1] = status.running
      ? { name: next[1].name, status: 'ok', detail: `pid=${status.pid}` }
      : { name: next[1].name, status: 'fail', detail: 'agent not running — start it from the Dashboard' };
    setResults([...next]);

    // 3. Supabase HEAD
    try {
      const res = await fetch(`${workstation.supabase_url}/auth/v1/health`);
      next[2] = res.ok
        ? { name: next[2].name, status: 'ok', detail: `HTTP ${res.status}` }
        : { name: next[2].name, status: 'fail', detail: `HTTP ${res.status}` };
    } catch (e) {
      next[2] = { name: next[2].name, status: 'fail', detail: e instanceof Error ? e.message : String(e) };
    }
    setResults([...next]);

    setRunning(false);
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
        <h2>Coming in Phase 4.2</h2>
        <p className="panel-sub">
          Full device probes — printer test page, cash-drawer kick, scale read, biometric enroll,
          USB tree — land once the loopback listener is upgraded to local TLS. They will call the
          existing route handlers already shipped with the agent.
        </p>
      </div>
    </>
  );
}
