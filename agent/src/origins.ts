/**
 * AccrualFlow Edge — Phase 4.2.5 tenant origin allowlist.
 *
 * The loopback CORS allowlist lives in the tenant's organization row
 * (organizations.edge_allowed_origins) and is fetched via the
 * edge-workstation-origins function using the workstation bearer secret.
 *
 * Layered behaviour:
 *   - `DEFAULT_ALLOWED_ORIGINS` — built-in developer + production ERP
 *     hosts that MUST always work regardless of tenant config.
 *   - `AGENT_ALLOWED_ORIGINS` env override — appended for internal
 *     preview/staging hosts.
 *   - Tenant-fetched list — merged on top so a custom domain
 *     (https://pos.tenant.example) works without a new agent release.
 *
 * The tenant list is cached to `~/.accrualflow/edge/origins.json` (mode
 * 0644 — no secrets in this file) so a cold start with the network down
 * still honours the last-known allowlist.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.js';
import { loadConfig, type RelayConfig } from './relay.js';

const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const RETRY_ON_ERROR_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'https://www.accrualflow.systems',
  'https://accrualflow.systems',
];

const ENV_ORIGINS = (process.env.AGENT_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);

interface CachedOrigins {
  origins: string[];
  version: string;
  fetched_at: string;
}

function cachePath(): string {
  const base = process.env.ACCRUALFLOW_EDGE_HOME || join(homedir(), '.accrualflow', 'edge');
  return join(base, 'origins.json');
}

function readCache(): CachedOrigins | null {
  const p = cachePath();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<CachedOrigins>;
    if (!parsed || !Array.isArray(parsed.origins)) return null;
    return {
      origins: parsed.origins.filter((s): s is string => typeof s === 'string'),
      version: typeof parsed.version === 'string' ? parsed.version : '',
      fetched_at: typeof parsed.fetched_at === 'string' ? parsed.fetched_at : '',
    };
  } catch {
    return null;
  }
}

function writeCache(entry: CachedOrigins): void {
  const p = cachePath();
  try {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(entry, null, 2), { mode: 0o644 });
  } catch (err) {
    logger.warn('origins.cache_write_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

let tenantOrigins: string[] = readCache()?.origins ?? [];
let cachedMerged: string[] = mergeOrigins(tenantOrigins);
let lastVersion: string = readCache()?.version ?? '';

function mergeOrigins(tenant: string[]): string[] {
  return Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...ENV_ORIGINS, ...tenant]));
}

/**
 * Snapshot of currently-authoritative allowlist. Cheap — called per request
 * from the loopback CORS handler; returns the pre-computed merged array.
 */
export function getAllowedOrigins(): string[] {
  return cachedMerged;
}

/**
 * Force an immediate refetch of the tenant origin allowlist. Wired to the
 * supervisor `reload_origins` IPC so operators can push a new origin from
 * the ERP without waiting for the 15-minute poll cycle.
 */
export async function refreshOriginsOnce(): Promise<{ ok: boolean; version?: string }> {
  const cfg = loadConfig();
  if (!cfg) return { ok: false };
  const result = await fetchOnce(cfg);
  if (!result) return { ok: false };
  if (result.version !== lastVersion) {
    tenantOrigins = result.origins;
    cachedMerged = mergeOrigins(tenantOrigins);
    lastVersion = result.version;
    writeCache({ origins: result.origins, version: result.version, fetched_at: new Date().toISOString() });
    logger.info('origins.refreshed_ondemand', { tenant_count: result.origins.length, version: result.version.slice(0, 12) });
  }
  return { ok: true, version: result.version };
}

async function fetchOnce(cfg: RelayConfig): Promise<{ origins: string[]; version: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.supabase_url}/functions/v1/edge/workstation/origins`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cfg.workstation_secret}`,
        'X-Workstation-Id': cfg.workstation_id,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn('origins.fetch_failed', { status: res.status });
      return null;
    }
    const body = await res.json() as { origins?: unknown; version?: unknown };
    const list = Array.isArray(body.origins) ? body.origins : [];
    const origins = list.filter((s): s is string => typeof s === 'string' && s.length > 0);
    const version = typeof body.version === 'string' ? body.version : '';
    return { origins, version };
  } catch (err) {
    logger.warn('origins.fetch_error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the fetcher. Safe no-op when no workstation.json is present —
 * a dev workstation without enrolment still uses DEFAULT + env origins.
 */
export function startOriginsRefresh(): () => void {
  const cfg = loadConfig();
  if (!cfg) {
    logger.info('origins.no_config', { defaults: DEFAULT_ALLOWED_ORIGINS.length, env: ENV_ORIGINS.length });
    return () => {};
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const result = await fetchOnce(cfg);
    let delay = REFRESH_INTERVAL_MS;
    if (result) {
      if (result.version !== lastVersion) {
        tenantOrigins = result.origins;
        cachedMerged = mergeOrigins(tenantOrigins);
        lastVersion = result.version;
        writeCache({ origins: result.origins, version: result.version, fetched_at: new Date().toISOString() });
        logger.info('origins.refreshed', { tenant_count: result.origins.length, version: result.version.slice(0, 12) });
      }
    } else {
      delay = RETRY_ON_ERROR_MS;
    }
    timer = setTimeout(tick, delay);
  };

  // Fire on next tick so callers can wire the server before the first fetch.
  timer = setTimeout(tick, 0);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
