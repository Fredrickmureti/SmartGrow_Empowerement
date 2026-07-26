/**
 * Update checker (Phase 4.2.8).
 *
 * Design note — why not `electron-updater`:
 *   Artifacts are produced by `@electron/packager` (electron-builder's
 *   7zip/AppImage toolchain is not usable in our build environment), so
 *   there is no electron-builder `latest.yml` to feed `electron-updater`.
 *   Instead we publish a small signed-at-rest channel manifest and check
 *   it here. The check is READ-ONLY: it never downloads or executes an
 *   installer. When an update applies, the operator is shown the version
 *   and opens the vendor download link explicitly.
 *
 * Channel manifest shape (served over HTTPS):
 *   {
 *     "channel": "stable",
 *     "version": "1.2.0",
 *     "pub_date": "2026-07-01T00:00:00Z",
 *     "rollout": 0.25,                 // 0..1 staged rollout fraction
 *     "minimum_version": "1.0.0",      // below this, rollout is ignored
 *     "notes": "…",
 *     "artifacts": {
 *       "win32-x64":  { "url": "https://…/AccrualFlowEdge-1.2.0-win-x64.zip",  "sha256": "…" },
 *       "darwin-arm64": { "url": "…", "sha256": "…" },
 *       "linux-x64":  { "url": "…", "sha256": "…" }
 *     }
 *   }
 */

const crypto = require('node:crypto');

const DEFAULT_CHANNEL_URL =
  process.env.EDGE_UPDATE_URL ||
  'https://updates.accrualflow.app/edge/{channel}.json';

/** Compare dotted numeric versions. Returns >0 when `a` is newer than `b`. */
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Deterministic rollout bucket in [0,1) derived from a stable install id.
 * The same machine always lands in the same bucket, so a staged rollout
 * expands monotonically instead of flapping between checks.
 */
function rolloutBucket(installId) {
  const h = crypto.createHash('sha256').update(String(installId || 'unknown')).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/**
 * @param {object} opts
 * @param {string} opts.currentVersion
 * @param {string} opts.installId    stable per-install identifier (workstation id)
 * @param {string} [opts.channel]    'stable' | 'beta'
 * @param {number} [opts.timeoutMs]
 */
async function checkForUpdate(opts) {
  const channel = opts.channel || 'stable';
  const url = DEFAULT_CHANNEL_URL.replace('{channel}', encodeURIComponent(channel));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return { ok: false, error: `channel_http_${res.status}`, channel, url };
    const manifest = await res.json();

    const newer = compareVersions(manifest.version, opts.currentVersion) > 0;
    const artifact = (manifest.artifacts || {})[platformKey()] || null;
    const bucket = rolloutBucket(opts.installId);
    const rollout = typeof manifest.rollout === 'number' ? manifest.rollout : 1;
    const forced =
      manifest.minimum_version
        ? compareVersions(manifest.minimum_version, opts.currentVersion) > 0
        : false;
    const inRollout = forced || bucket < rollout;

    return {
      ok: true,
      channel,
      current_version: opts.currentVersion,
      latest_version: manifest.version ?? null,
      update_available: Boolean(newer && artifact),
      applies_to_this_device: Boolean(newer && artifact && inRollout),
      mandatory: forced,
      rollout,
      rollout_bucket: Number(bucket.toFixed(4)),
      platform: platformKey(),
      notes: manifest.notes ?? null,
      pub_date: manifest.pub_date ?? null,
      download_url: artifact?.url ?? null,
      sha256: artifact?.sha256 ?? null,
      unsupported_platform: Boolean(newer && !artifact),
    };
  } catch (e) {
    return { ok: false, channel, url, error: e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkForUpdate, compareVersions, rolloutBucket, platformKey };
