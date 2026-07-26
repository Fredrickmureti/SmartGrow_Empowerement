import { useCallback, useEffect, useState } from 'react';
import type { UpdateCheck } from '../types';

/**
 * Updates panel (Phase 4.2.8).
 *
 * Shows the result of a read-only channel check. Because artifacts are
 * packaged (not electron-builder self-updating), applying an update is an
 * explicit operator action: we surface the version, the staged-rollout
 * decision, and the signed artifact's SHA-256 so it can be verified before
 * it is run.
 */
export function UpdatesPanel() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try { setCheck(await window.edge.updates.check()); }
    catch (e) { setCheck({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { run(); }, [run]);

  const state = !check
    ? 'Checking…'
    : check.state === 'not_configured'
      ? 'Update channel not configured'
      : check.state === 'no_release'
        ? 'No release published on this channel'
        : check.state === 'unreachable'
          ? 'Update channel unreachable — will retry'
          : !check.ok
            ? `Check failed: ${check.error}`
            : check.unsupported_platform
              ? `No artifact published for ${check.platform}`
              : !check.update_available
                ? 'Up to date'
                : check.applies_to_this_device
                  ? (check.mandatory ? 'Required update available' : 'Update available')
                  : 'Update staged — not yet released to this device';

  const tone = !check
    ? 'pill'
    : check.ok && check.applies_to_this_device
      ? (check.mandatory ? 'pill err' : 'pill warn')
      : !check.ok
        ? 'pill err'
        : check.state === 'not_configured' || check.state === 'no_release' || check.state === 'unreachable'
          ? 'pill warn'
          : 'pill ok';

  return (
    <div className="panel">
      <h2>Updates</h2>
      <p className="panel-sub">
        Release channel status for this workstation. Rollouts are staged by a
        stable per-device bucket, so a partial release reaches the same
        machines on every check.
      </p>

      <div className="grid-2">
        <div className="stat">
          <div className="stat-label">Status</div>
          <div className="stat-value">
            <span className={tone}><span className="pill-dot" />{state}</span>
          </div>
          {check?.state === 'not_configured' && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Set a channel manifest URL (EDGE_UPDATE_URL or the update_channel_url setting) to enable checks.
            </div>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">Installed / latest</div>
          <div className="stat-value mono">
            {check?.current_version ?? '—'} → {check?.latest_version ?? '—'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Channel</div>
          <div className="stat-value mono">{check?.channel ?? '—'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Rollout</div>
          <div className="stat-value mono">
            {typeof check?.rollout === 'number'
              ? `${Math.round(check.rollout * 100)}% · bucket ${check.rollout_bucket}`
              : '—'}
          </div>
        </div>
      </div>

      {check?.notes && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{check.notes}</p>
      )}

      {check?.sha256 && (
        <div className="muted mono" style={{ fontSize: 10, wordBreak: 'break-all', marginTop: 8 }}>
          sha256: {check.sha256}
        </div>
      )}

      <div className="button-row" style={{ marginTop: 12 }}>
        <button className="btn secondary" disabled={busy} onClick={run}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
        {check?.applies_to_this_device && check.download_url && (
          <button className="btn" onClick={() => window.edge.shell.openExternal(check.download_url as string)}>
            Download {check.latest_version}
          </button>
        )}
      </div>
    </div>
  );
}
