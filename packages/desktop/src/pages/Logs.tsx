import { useEffect, useRef, useState } from 'react';

/**
 * Logs viewer — live SSE tail of the agent's ring buffer.
 *
 * Phase 4.2 item 3. The agent exposes `GET /logs/stream` as
 * text/event-stream; each `log` event carries a structured NDJSON entry.
 * The ring buffer is replayed on connect so operators always see
 * immediate context, then live entries stream in.
 */
interface LogEntry { ts: string; level: string; msg: string; [k: string]: unknown }

// EventSource cannot carry Authorization headers, so we deliberately
// keep /logs/stream on the loopback listener (Host-pinned + origin-
// allowlisted). A signed installer will inject a bearer via a preload-
// mediated bridge once trust-store install lands (Phase 4.2 item 7).
const LOGS_STREAM_URL = 'http://127.0.0.1:8043/logs/stream';
const CAP = 500;

export function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    const connect = () => {
      try {
        es = new EventSource(LOGS_STREAM_URL);
        es.onopen = () => { setConnected(true); setErr(null); };
        es.addEventListener('log', (ev) => {
          try {
            const entry = JSON.parse((ev as MessageEvent).data) as LogEntry;
            setEntries((prev) => {
              const next = prev.concat(entry);
              return next.length > CAP ? next.slice(next.length - CAP) : next;
            });
          } catch { /* skip malformed */ }
        });
        es.onerror = () => {
          setConnected(false);
          setErr('Log stream disconnected — retrying…');
          es?.close();
          if (!closed) setTimeout(connect, 3_000);
        };
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        if (!closed) setTimeout(connect, 3_000);
      }
    };
    connect();
    return () => { closed = true; es?.close(); };
  }, []);

  useEffect(() => {
    if (viewRef.current) viewRef.current.scrollTop = viewRef.current.scrollHeight;
  }, [entries]);

  return (
    <>
      <div className="row-between" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 20 }}>Logs</h1>
          <span className={`pill ${connected ? 'ok' : 'warn'}`}>
            <span className="pill-dot" />{connected ? 'Live' : 'Reconnecting'}
          </span>
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
