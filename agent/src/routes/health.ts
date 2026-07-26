/**
 * /health — machine-readable liveness endpoint distinct from /status.
 *
 * /status returns the discovered-device inventory (used by the ERP).
 * /health returns runtime health signals used by supervisors,
 * installers, and the desktop shell.
 */

import { getUptime } from '../server.js';
import { recentLogs } from '../logger.js';
import type { LoopbackTls } from '../tls.js';

export interface HealthResponse {
  ok: boolean;
  product: 'accrualflow-edge';
  version: string;
  uptime_s: number;
  node_version: string;
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
  memory_mb: number;
  recent_error_count: number;
  tls: {
    enabled: boolean;
    fingerprint_sha256?: string;
    generated_at?: string;
  };
}

export function handleHealth(tls: LoopbackTls | null = null): HealthResponse {
  const errs = recentLogs().filter((e) => e.level === 'error').length;
  return {
    ok: true,
    product: 'accrualflow-edge',
    version: '1.4.0-edge.p4.2',
    uptime_s: getUptime(),
    node_version: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    recent_error_count: errs,
    tls: tls
      ? { enabled: true, fingerprint_sha256: tls.fingerprintSha256, generated_at: tls.generatedAt }
      : { enabled: false },
  };
}
