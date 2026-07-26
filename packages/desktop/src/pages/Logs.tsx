import { useEffect, useRef, useState } from 'react';

/**
 * Logs viewer — authenticated snapshot tail of the agent's ring buffer.
 * The renderer cannot attach Authorization headers to EventSource, so the
 * main process fetches `/support-bundle` with the bearer token and returns
 * the redacted log ring over IPC.
 */
interface LogEntry { ts: string; level: string; msg: string; [k: string]: unknown }

const CAP = 500;

export function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let closed = false;
    const poll = async () => {
      try {
        const res = await window.edge.agent.logs();
        if (closed) return;
        if (!res.ok) {
          setConnected(false);
          setErr(res.error ?? 'Agent logs unavailable');
          return;
        }
        setConnected(true);
        setErr(null);
        setEntries(res.entries.slice(-CAP) as LogEntry[]);
      } catch (e) {
        if (closed) return;
        setConnected(false);
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    poll();
    const timer = window.setInterval(poll, 3_000);
    return () => { closed = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (viewRef.current) viewRef.current.scrollTop = viewRef.current.scrollHeight;
  }, [entries]);

  return (
    <>
      <div className="page-head row-between">
        <div>
          <div className="page-eyebrow">Support</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 className="page-title">Activity log</h1>
            <span className={`pill ${connected ? 'ok' : 'warn'}`}>
              <span className="pill-dot" />{connected ? 'Live' : 'Reconnecting'}
            </span>
          </div>
          <p className="page-sub">The runtime's most recent {CAP} events on this workstation.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn secondary" onClick={() => setEntries([])}>Clear</button>
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
