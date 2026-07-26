import { useCallback, useEffect, useState } from 'react';
import type { CertStatus, TrustResult } from '../types';

/**
 * Local certificate panel (Phase 4.2.7c).
 *
 * Surfaces the loopback TLS certificate lifecycle to the operator:
 *   - live trusted / untrusted state (`supervisor: cert_status`)
 *   - force re-mint (`rotate_cert`) without restarting the agent
 *   - OS trust-store install / uninstall, but ONLY after the operator has
 *     seen the exact argv the supervisor will execute. Nothing here runs
 *     implicitly — mounting the panel performs a read-only status query.
 */
export function CertificatePanel({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<CertStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [steps, setSteps] = useState<TrustResult['steps']>(undefined);
  const [showCommands, setShowCommands] = useState(false);

  const refresh = useCallback(async () => {
    try { setStatus(await window.edge.supervisor.certStatus()); }
    catch (e) { setStatus({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (op: 'rotate' | 'install' | 'uninstall') => {
    setBusy(op); setMsg(null); setSteps(undefined);
    try {
      if (op === 'rotate') {
        const r = await window.edge.supervisor.rotateCert();
        setMsg(r.ok
          ? `Certificate re-minted · fp ${r.fingerprint_sha256 ?? 'unknown'}`
          : `Rotation failed: ${r.error ?? 'unknown error'}`);
      } else {
        const r = op === 'install'
          ? await window.edge.supervisor.installCert()
          : await window.edge.supervisor.uninstallCert();
        setSteps(r.steps);
        setMsg(r.ok ? `Trust store ${op} completed.` : `Trust store ${op} failed: ${r.error ?? 'unknown error'}`);
      }
      await refresh();
      onChanged?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const trusted = status?.trusted;
  const commands = status?.commands ?? [];

  return (
    <div className="panel">
      <h2>Local certificate</h2>
      <p className="panel-sub">
        The agent serves loopback HTTPS with a per-install self-signed
        certificate. Browsers only accept it once it is present in this
        machine&rsquo;s trust store. Installing requires administrator rights.
      </p>

      <div className="grid-2">
        <div className="stat">
          <div className="stat-label">Trust state</div>
          <div className="stat-value">
            {trusted === true
              ? <span className="pill ok"><span className="pill-dot" />Trusted</span>
              : trusted === false
                ? <span className="pill warn"><span className="pill-dot" />Not trusted</span>
                : <span className="pill warn"><span className="pill-dot" />Unknown</span>}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Detail</div>
          <div className="stat-value mono" style={{ fontSize: 12 }}>
            {status?.detail ?? status?.error ?? '—'}
          </div>
        </div>
      </div>

      <div className="button-row" style={{ marginTop: 12 }}>
        <button className="btn secondary" disabled={busy !== null}
          onClick={() => run('rotate')}>Rotate certificate</button>
        <button className="btn secondary" disabled={busy !== null || commands.length === 0}
          onClick={() => setShowCommands((v) => !v)}>
          {showCommands ? 'Hide commands' : 'Review commands'}
        </button>
        <button className="btn" disabled={busy !== null || trusted === true}
          onClick={() => run('install')}>Trust local certificate</button>
        <button className="btn secondary" disabled={busy !== null || trusted === false}
          onClick={() => run('uninstall')}>Remove trust</button>
      </div>

      {showCommands && commands.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="stat-label">Exact commands that will run</div>
          {commands.map((c) => (
            <div key={c.command} style={{ marginTop: 8 }}>
              <div className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{c.command}</div>
              <div className="muted" style={{ fontSize: 11 }}>
                {c.explain}{c.elevates ? ' · requires elevation' : ''}
              </div>
            </div>
          ))}
        </div>
      )}

      {msg && <div className="muted mono" style={{ marginTop: 8, fontSize: 12 }}>{msg}</div>}

      {steps && steps.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {steps.map((s, i) => (
            <div key={`${i}-${s.command}`} className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
              <span className={s.ok ? 'pill ok' : 'pill err'} style={{ marginRight: 6 }}>
                {s.ok ? 'ok' : 'fail'}
              </span>
              {s.command}
              {s.output && <div className="muted" style={{ fontSize: 11 }}>{s.output}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
