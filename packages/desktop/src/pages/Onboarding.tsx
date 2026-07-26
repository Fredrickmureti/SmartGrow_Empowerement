import { useState } from 'react';
import { signInWithPassword, listMyOrganizations, invoke, signOut } from '../lib/supabase';

interface Props { onEnrolled: () => void }

type Step = 'signin' | 'org' | 'name' | 'writing' | 'done' | 'error';

/**
 * Phase-4 enrolment wizard.
 *
 * Flow (each step blocks progression until it succeeds):
 *
 *   1. **signin**  — email/password against Supabase Auth. Session is held
 *      in-memory ONLY; it is never persisted to disk (durable credential is
 *      the workstation secret written at the end).
 *   2. **org**     — pick which organization the workstation belongs to.
 *   3. **name**    — human-readable workstation name (e.g. "Front counter — Kiambu").
 *   4. **writing** — call `edge-workstation-register`, then write the raw
 *      secret to `~/.accrualflow/edge/workstation.json` at mode 0600 via
 *      the main-process IPC bridge. The secret is displayed once for the
 *      operator to record in a password manager.
 *   5. **done**    — kick the agent runtime so relay polling starts.
 */
export function Onboarding({ onEnrolled }: Props) {
  const [step, setStep] = useState<Step>('signin');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [orgs, setOrgs] = useState<{ organization_id: string; name?: string }[]>([]);
  const [orgId, setOrgId] = useState<string>('');
  const [name, setName] = useState('');

  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function doSignIn() {
    setError(null); setBusy(true);
    try {
      await signInWithPassword(email.trim(), password);
      const orgList = await listMyOrganizations();
      if (orgList.length === 0) throw new Error('This account is not a member of any organization.');
      setOrgs(orgList);
      setOrgId(orgList[0].organization_id);
      setStep(orgList.length === 1 ? 'name' : 'org');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function doEnroll() {
    setError(null); setBusy(true); setStep('writing');
    try {
      const res = await invoke<{ workstation: { id: string }; secret: string; supabase_url: string }>(
        'edge-workstation-register',
        { organization_id: orgId, name: name.trim() },
      );
      const write = await window.edge.workstation.write({
        workstation_id: res.workstation.id,
        organization_id: orgId,
        name: name.trim(),
        supabase_url: res.supabase_url,
        workstation_secret: res.secret,
      });
      if (!write.ok) throw new Error(write.error ?? 'Failed to write workstation.json');
      setIssuedSecret(res.secret);
      // Fire-and-forget agent startup — if it fails the user can retry from
      // the Dashboard, we don't want the enrolment success to hinge on it.
      window.edge.agent.start().catch(() => { /* surfaced on Dashboard */ });
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    } finally { setBusy(false); }
  }

  return (
    <div className="wizard">
      <h1>Enroll this workstation</h1>
      <p className="lead">
        AccrualFlow Edge lives on this device and brokers every hardware call from your ERP.
        Enrolment happens once — after that, the workstation identity persists across reboots.
      </p>

      {step === 'signin' && (
        <>
          <label className="field"><span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com" autoFocus />
          </label>
          <label className="field"><span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="error-inline">{error}</div>}
          <div className="button-row">
            <button className="btn" disabled={busy || !email || !password} onClick={doSignIn}>
              {busy ? 'Signing in…' : 'Continue'}
            </button>
          </div>
        </>
      )}

      {step === 'org' && (
        <>
          <label className="field"><span>Organization</span>
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {orgs.map((o) => (
                <option key={o.organization_id} value={o.organization_id}>
                  {o.name ?? o.organization_id}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button className="btn secondary" onClick={() => { signOut(); setStep('signin'); }}>Back</button>
            <button className="btn" onClick={() => setStep('name')}>Continue</button>
          </div>
        </>
      )}

      {step === 'name' && (
        <>
          <label className="field">
            <span>Workstation name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Front counter — Kiambu" autoFocus maxLength={120} />
          </label>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
            Shown in the admin console and on receipts. Change any time from Auth.
          </p>
          {error && <div className="error-inline">{error}</div>}
          <div className="button-row">
            <button className="btn secondary" onClick={() => setStep(orgs.length > 1 ? 'org' : 'signin')}>Back</button>
            <button className="btn" disabled={busy || name.trim().length < 2} onClick={doEnroll}>
              {busy ? 'Enrolling…' : 'Enroll workstation'}
            </button>
          </div>
        </>
      )}

      {step === 'writing' && <p className="muted">Registering with AccrualFlow cloud…</p>}

      {step === 'done' && issuedSecret && (
        <>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Enrolment complete</h2>
          <p className="muted">
            The workstation secret has been written to
            <code className="mono"> ~/.accrualflow/edge/workstation.json</code> (mode 0600).
            Save a copy in your password manager — <strong>it is not shown again.</strong>
          </p>
          <div className="wizard-secret">{issuedSecret}</div>
          <div className="button-row">
            <button className="btn secondary" onClick={() => {
              navigator.clipboard?.writeText(issuedSecret).then(() => setCopied(true));
            }}>{copied ? 'Copied' : 'Copy secret'}</button>
            <button className="btn" onClick={onEnrolled}>Open dashboard</button>
          </div>
        </>
      )}

      {step === 'error' && (
        <>
          <h2 style={{ fontSize: 16, color: 'var(--edge-err)' }}>Enrolment failed</h2>
          <p className="mono" style={{ fontSize: 12 }}>{error}</p>
          <div className="button-row">
            <button className="btn secondary" onClick={() => setStep('name')}>Try again</button>
          </div>
        </>
      )}
    </div>
  );
}
