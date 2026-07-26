import { useState } from 'react';
import type { WorkstationRead } from '../types';
import { invoke, signInWithPassword, currentSession } from '../lib/supabase';
import { IdChip } from '../components/IdChip';
import { BrowserPairing } from '../components/BrowserPairing';

interface Props { workstation: WorkstationRead; onChanged: () => void }

/**
 * Auth tab.
 *
 * Two operations:
 *   1. **Rotate credential** — calls `edge-workstation-rotate-secret`, then
 *      re-writes `workstation.json` with the new raw secret. The old
 *      secret is instantly invalid on the server side (single UPDATE);
 *      the running agent will re-load config on next poll.
 *   2. **Sign out this workstation** — clears the local `workstation.json`.
 *      The row on the server is untouched; a signed-in org member can
 *      permanently revoke it from the admin console (Phase 6).
 */
export function Auth({ workstation, onChanged }: Props) {
  const [email, setEmail] = useState(currentSession()?.user.email ?? '');
  const [password, setPassword] = useState('');
  const [rotating, setRotating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  async function rotate() {
    setErr(null); setRotating(true); setNewSecret(null);
    try {
      if (!currentSession()) {
        if (!email || !password) throw new Error('Sign in to rotate the credential.');
        await signInWithPassword(email, password);
      }
      const res = await invoke<{ workstation_id: string; secret: string; supabase_url: string }>(
        'edge/workstation/rotate-secret',
        { workstation_id: workstation.workstation_id },
      );
      const write = await window.edge.workstation.write({
        workstation_id: workstation.workstation_id!,
        organization_id: workstation.organization_id!,
        name: workstation.name!,
        supabase_url: res.supabase_url,
        workstation_secret: res.secret,
      });
      if (!write.ok) throw new Error(write.error ?? 'Failed to persist rotated secret.');
      setNewSecret(res.secret);
      // Restart the agent so it re-reads the config.
      await window.edge.agent.start();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setRotating(false); }
  }

  async function signOutWorkstation() {
    if (!confirm('Remove workstation.json from this device? The agent will stop polling until you re-enroll.')) return;
    await window.edge.agent.stop();
    await window.edge.workstation.clear();
    onChanged();
  }

  return (
    <>
      <div className="page-head">
        <div className="page-eyebrow">Security</div>
        <h1 className="page-title">Identity &amp; credentials</h1>
        <p className="page-sub">Who this device is, and the secret it uses to talk to AccrualFlow.</p>
      </div>

      <div className="panel">
        <h2>Workstation identity</h2>
        <p className="panel-sub">Issued once at enrolment and never changes. Quote the reference code to support.</p>
        <div className="grid-2">
          <div className="stat">
            <div className="stat-label">Workstation</div>
            <div className="stat-value">{workstation.name ?? 'Unnamed workstation'}</div>
            <div className="stat-hint"><IdChip kind="workstation" value={workstation.workstation_id} expandable /></div>
          </div>
          <div className="stat">
            <div className="stat-label">Organization</div>
            <div className="stat-value">Linked</div>
            <div className="stat-hint"><IdChip kind="organization" value={workstation.organization_id} expandable /></div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Rotate credential</h2>
        <p className="panel-sub">
          Generates a new workstation secret and overwrites <code className="mono">workstation.json</code>.
          The previous secret is invalidated server-side immediately.
        </p>
        {!currentSession() && (
          <>
            <label className="field"><span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field"><span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        )}
        {err && <div className="error-inline">{err}</div>}
        {newSecret && (
          <>
            <div className="ok-inline">New secret written. Save a copy — it will not be shown again.</div>
            <div className="wizard-secret">{newSecret}</div>
          </>
        )}
        <div className="button-row">
          <button className="btn" onClick={rotate} disabled={rotating}>
            {rotating ? 'Rotating…' : 'Rotate credential'}
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Sign out workstation</h2>
        <p className="panel-sub">
          Clears the local <code className="mono">workstation.json</code>. This desktop app will return to
          the enrolment wizard on next start.
        </p>
        <div className="button-row">
          <button className="btn danger" onClick={signOutWorkstation}>Remove workstation.json</button>
        </div>
      </div>
    </>
  );
}
