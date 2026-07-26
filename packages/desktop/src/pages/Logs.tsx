import { useEffect, useRef, useState } from 'react';

/**
 * Logs viewer — thin follower for the agent's structured NDJSON stream.
 *
 * The agent already ships an in-memory ring buffer (`agent/src/logger.ts`)
 * exposed via `/support-bundle`; a follow-up will publish a Server-Sent
 * Events stream so this viewer can tail live. For now we fetch the ring
 * buffer on demand and pretty-print it.
 */
interface LogEntry { ts: string; level: string; msg: string; [k: string]: unknown }

export function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    setErr(null);
    try {
      // Loopback endpoint the agent exposes for authenticated diagnostic
      // pulls. In dev we call it unauthenticated against localhost; a
      // signed installer will inject a per-install bearer.
      const res = await fetch('http://127.0.0.1:8043/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const log = Array.isArray(body.log) ? body.log as LogEntry[] : [];
      setEntries(log);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (viewRef.current) viewRef.current.scrollTop = viewRef.current.scrollHeight;
  }, [entries]);

  return (
    <>
      <div className="row-between" style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Logs</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn secondary" onClick={refresh}>Refresh</button>
          <button className="btn" onClick={() => downloadBundle(entries)}>Download support bundle</button>
        </div>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <div className="log-view" ref={viewRef}>
          {err && <div className="log-err">{err}</div>}
          {!err && entries.length === 0 && <div className="muted">No log entries yet.</div>}
          {entries.map((e, i) => (
            <div key={i} className={levelClass(e.level)}>
              {e.ts} [{e.level}] {e.msg}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function levelClass(level: string): string {
  if (level === 'error' || level === 'fatal') return 'log-err';
  if (level === 'warn') return 'log-warn';
  if (level === 'info') return 'log-ok';
  return '';
}

function downloadBundle(entries: LogEntry[]) {
  const blob = new Blob([JSON.stringify({ generated_at: new Date().toISOString(), entries }, null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `accrualflow-edge-support-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
