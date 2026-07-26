/**
 * /support-bundle — one-shot diagnostic snapshot.
 *
 * Returns log ring buffer + health + redacted config so support can
 * triage without shell access. Never emits tokens or request bodies.
 */

import { recentLogs } from '../logger.js';
import { handleHealth } from './health.js';
import { handleStatus } from './status.js';

export interface SupportBundle {
  generated_at: string;
  health: ReturnType<typeof handleHealth>;
  status: ReturnType<typeof handleStatus>;
  config: {
    port: number;
    allowed_origins: string[];
    auth_disabled: boolean;
  };
  logs: ReturnType<typeof recentLogs>;
}

export function buildSupportBundle(config: {
  port: number;
  allowed_origins: string[];
  auth_disabled: boolean;
}): SupportBundle {
  return {
    generated_at: new Date().toISOString(),
    health: handleHealth(),
    status: handleStatus(),
    config,
    logs: recentLogs(),
  };
}
