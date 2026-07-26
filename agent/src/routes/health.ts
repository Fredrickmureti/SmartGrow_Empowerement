/**
 * /health — machine-readable liveness endpoint distinct from /status.
 *
 * /status returns the discovered-device inventory (used by the ERP).
 * /health returns runtime health signals used by supervisors,
 * installers, and the desktop shell.
 */

import { getUptime } from '../server.js';
import { recentLogs } from '../logger.js';

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
}

export function handleHealth(): HealthResponse {
  const errs = recentLogs().filter((e) => e.level === 'error').length;
  return {
    ok: true,
    product: 'accrualflow-edge',
    version: '1.1.0-edge.p1',
    uptime_s: getUptime(),
    node_version: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    recent_error_count: errs,
  };
}
