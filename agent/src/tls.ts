/**
 * Per-install loopback TLS — AccrualFlow Edge Phase 4.2, item 1.
 *
 * The published ERP at https://www.accrualflow.systems cannot fetch
 * plaintext http://127.0.0.1:8043 (mixed-content). We fix that by
 * binding a second listener on https://127.0.0.1:8443 with a per-install
 * self-signed certificate whose SHA-256 fingerprint is pinned by the
 * ERP client after enrolment.
 *
 * The cert is generated once on first run and persisted at
 * `~/.accrualflow/edge/tls/{cert.pem, key.pem}`. Key permissions are
 * enforced to mode 0600 on POSIX; the fingerprint is exposed via the
 * public /health endpoint so the ERP can retrieve it out-of-band.
 *
 * A production-grade rollout still needs an OS trust-store install
 * helper (Phase 4.2 item 7). Until that ships, browsers treat the cert
 * as untrusted; the relay path (Phase 2) remains the primary transport
 * and the loopback is a fallback for same-LAN latency-sensitive ops.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';
import { logger } from './logger.js';

export interface LoopbackTls {
  cert: string;
  key: string;
  fingerprintSha256: string;
  generatedAt: string;
  /** Workstation-secret rotation stamp this cert was minted against. */
  secretRotatedAt: string | null;
  path: string;
}

const CONFIG_ROOT = process.env.ACCRUALFLOW_EDGE_TLS_DIR
  ?? path.join(os.homedir(), '.accrualflow', 'edge', 'tls');

const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';
const META_FILE = 'meta.json';

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function fingerprintFromCertPem(pem: string): string {
  const cert = new crypto.X509Certificate(pem);
  // Node's fingerprint256 returns colon-separated hex; normalise to
  // lowercase-no-colons for stable pinning comparisons.
  return cert.fingerprint256.replace(/:/g, '').toLowerCase();
}

function generateNew(secretRotatedAt: string | null): LoopbackTls {
  logger.info('tls_cert_generating', { path: CONFIG_ROOT });
  const attrs = [
    { name: 'commonName', value: 'AccrualFlow Edge' },
    { name: 'organizationName', value: 'AccrualFlow' },
    { name: 'countryName', value: 'US' },
  ];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' }, // DNS
          { type: 7, ip: '127.0.0.1' },   // IP
          { type: 7, ip: '::1' },
        ],
      },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
      },
    ],
  });
  const fingerprintSha256 = fingerprintFromCertPem(pems.cert);
  const generatedAt = new Date().toISOString();

  ensureDir(CONFIG_ROOT);
  fs.writeFileSync(path.join(CONFIG_ROOT, CERT_FILE), pems.cert, { mode: 0o644 });
  fs.writeFileSync(path.join(CONFIG_ROOT, KEY_FILE), pems.private, { mode: 0o600 });
  fs.writeFileSync(
    path.join(CONFIG_ROOT, META_FILE),
    JSON.stringify(
      {
        fingerprintSha256,
        generatedAt,
        // The workstation-secret rotation stamp this cert was minted
        // against. When the ERP rotates the secret, `secret_rotated_at`
        // moves forward and the next manifest publish notices the drift
        // and re-mints — see `loopbackTlsNeedsRotation`.
        secretRotatedAt: secretRotatedAt ?? null,
        product: 'accrualflow-edge',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  return {
    cert: pems.cert,
    key: pems.private,
    fingerprintSha256,
    generatedAt,
    secretRotatedAt: secretRotatedAt ?? null,
    path: CONFIG_ROOT,
  };
}

interface CertMeta {
  generatedAt?: string;
  secretRotatedAt?: string | null;
}

function readMeta(): CertMeta {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(CONFIG_ROOT, META_FILE), 'utf8'));
    return (meta && typeof meta === 'object') ? meta as CertMeta : {};
  } catch {
    return {};
  }
}

function tryLoadExisting(): LoopbackTls | null {
  try {
    const cert = fs.readFileSync(path.join(CONFIG_ROOT, CERT_FILE), 'utf8');
    const key = fs.readFileSync(path.join(CONFIG_ROOT, KEY_FILE), 'utf8');
    // Validate the cert is still parseable + not expired within 30 days.
    const x = new crypto.X509Certificate(cert);
    const notAfter = new Date(x.validTo).getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    if (Number.isFinite(notAfter) && notAfter - Date.now() < thirtyDays) {
      logger.warn('tls_cert_near_expiry', { validTo: x.validTo });
      return null;
    }
    const meta = readMeta();
    return {
      cert,
      key,
      fingerprintSha256: fingerprintFromCertPem(cert),
      generatedAt: typeof meta.generatedAt === 'string' ? meta.generatedAt : new Date().toISOString(),
      secretRotatedAt: typeof meta.secretRotatedAt === 'string' ? meta.secretRotatedAt : null,
      path: CONFIG_ROOT,
    };
  } catch {
    return null;
  }
}

/**
 * Load an existing per-install loopback cert or generate one atomically.
 * Idempotent — safe to call on every process start.
 */
export function loadOrGenerateLoopbackTls(): LoopbackTls {
  const existing = tryLoadExisting();
  if (existing) return existing;
  return generateNew(null);
}

/**
 * Pure decision function — exported for unit tests.
 *
 * The loopback cert is bound to the workstation identity. When an
 * operator rotates the workstation secret (a credential-compromise
 * response), the old cert must not keep vouching for the new identity:
 * anyone who captured the previous key could otherwise keep terminating
 * loopback TLS. We therefore re-mint whenever the server-side
 * `secret_rotated_at` is newer than the stamp recorded in `meta.json`.
 *
 * `null` on the server side means "never rotated" — nothing to do.
 * `null` locally with a non-null server stamp means the cert predates
 * the first rotation, so it must be replaced.
 */
export function loopbackTlsNeedsRotation(
  localSecretRotatedAt: string | null | undefined,
  serverSecretRotatedAt: string | null | undefined,
): boolean {
  if (!serverSecretRotatedAt) return false;
  const server = Date.parse(serverSecretRotatedAt);
  if (!Number.isFinite(server)) return false;
  if (!localSecretRotatedAt) return true;
  const local = Date.parse(localSecretRotatedAt);
  if (!Number.isFinite(local)) return true;
  return server > local;
}

/**
 * Force a fresh cert. Called when the workstation secret has rotated
 * (Phase 4.2.7a) or on an explicit `rotate_cert` supervisor op. The
 * caller is responsible for pushing the new context into the live TLS
 * listener via `tls.Server#setSecureContext` — no restart required.
 */
export function rotateLoopbackTls(secretRotatedAt?: string | null): LoopbackTls {
  return generateNew(secretRotatedAt ?? new Date().toISOString());
}

/** Absolute path to the PEM the OS trust-store helpers install. */
export const LOOPBACK_CERT_PATH = path.join(CONFIG_ROOT, CERT_FILE);
