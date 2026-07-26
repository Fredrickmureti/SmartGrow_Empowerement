import { useCallback, useEffect, useState } from 'react';
import type { AgentPairing } from '../types';

/**
 * Browser pairing panel.
 *
 * Surfaces the LOOPBACK shared secret (`~/.pos-agent-token`) that a browser
 * must send to reach protected agent routes. This is deliberately separate
 * from the cloud workstation secret: operators were pasting the workstation
 * credential into the ERP's "IoT Box Agent" field and getting a 401.
 *
 * The token is masked by default, revealed only on explicit disclosure, and
 * never logged.
 */
function mask(token: string): string {
  const tail = token.slice(-4);
  return `${'\u2022'.repeat(24)}${tail}`;
}

function CopyButton({ value, label, disabled }: { value: string; label: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn secondary"
      disabled={disabled || !value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch { /* clipboard unavailable — reveal still works */ }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function BrowserPairing() {
  const [pairing, setPairing] = useState<AgentPairing | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPairing(await window.edge.agent.pairing());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function rotate() {
    if (!confirm('Rotate the pairing token? Every browser already paired with this machine must be re-paired.')) return;
    setErr(null); setRotating(true); setRevealed(false);
    try {
      const res = await window.edge.agent.rotateToken();
      if (!res.ok) throw new Error(res.detail || res.error || 'Rotation failed.');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setRotating(false); }
  }

  const token = pairing?.token ?? '';

  return (
    <div className="panel">
      <h2>Browser pairing</h2>
      <p className="panel-sub">
        Local hardware token used by web browsers on this machine. Different from the
        workstation credential above — that one talks to AccrualFlow, this one talks to
        the agent on loopback.
      </p>

      <div className="pairing-steps">
        <span>Open <strong>Platform &rarr; Hardware &rarr; Devices</strong></span>
        <span>Find the <strong>IoT Box Agent</strong> card</span>
        <span>Paste the agent URL and the pairing token below</span>
      </div>

      <div className="stat">
        <div className="stat-label">Agent URL</div>
        <div className="pairing-row">
          <code className="pairing-value mono">{pairing?.baseUrl ?? '—'}</code>
          <CopyButton value={pairing?.baseUrl ?? ''} label="Copy URL" />
        </div>
        <div className="stat-hint">
          Encrypted loopback, when a trusted certificate is installed: <code className="mono">{pairing?.tlsUrl ?? '—'}</code>
        </div>
      </div>

      <div className="stat" style={{ marginTop: 12 }}>
        <div className="stat-label">Pairing token</div>
        {pairing?.authDisabled ? (
          <p className="panel-sub" style={{ margin: '6px 0 0' }}>
            This runtime is started with <code className="mono">AGENT_AUTH_DISABLED=1</code>, so no token is
            required — leave the field in the browser blank. Development only; never ship a
            workstation with auth disabled.
          </p>
        ) : token ? (
          <>
            <div className="pairing-row">
              <code className="pairing-value mono">{revealed ? token : mask(token)}</code>
              <CopyButton value={token} label="Copy pairing token" />
              <button type="button" className="btn secondary" onClick={() => setRevealed((v) => !v)}>
                {revealed ? 'Hide' : 'Reveal'}
              </button>
            </div>
            <div className="stat-hint">
              Stored at <code className="mono">{pairing?.tokenPath}</code>. Pairing is per browser profile —
              each browser that prints from this machine needs the token once.
            </div>
          </>
        ) : (
          <p className="panel-sub" style={{ margin: '6px 0 0' }}>
            No token yet — the agent generates one on first successful start. Start the runtime
            from the Overview tab, then refresh.
          </p>
        )}
      </div>

      {err && <div className="error-inline">{err}</div>}

      <div className="button-row">
        <button className="btn secondary" onClick={() => void load()}>Refresh</button>
        <button className="btn danger" onClick={rotate} disabled={rotating || pairing?.authDisabled}>
          {rotating ? 'Rotating…' : 'Rotate pairing token'}
        </button>
      </div>
    </div>
  );
}
