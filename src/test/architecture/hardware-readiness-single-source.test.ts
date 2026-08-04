/**
 * Guard: readiness has exactly one source, and hardware connections have
 * exactly one owner.
 *
 * Two regressions this locks down:
 *
 *  1. Deriving "can we print?" from `hardwareClient.devices.getStatuses()`.
 *     That is a LOCAL runtime probe. A printer owned by another machine's
 *     IoT agent and reached over the `edge_jobs` relay is never "connected"
 *     locally, which is what made POS say "No printer connected" while
 *     invoice/label printing worked. Readiness must come from
 *     `services/hardware/readiness.ts` (registry + workstation heartbeat).
 *
 *  2. Two components writing the renderer adapter registry and calling
 *     `connectAll()`. `EdgeRelayMount` and `useHardwareProxy` both did; the
 *     later mount overwrote the earlier device list, and opening hardware
 *     settings on one machine disturbed another session.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

/** Files allowed to read the local runtime probe directly. */
const GET_STATUSES_ALLOWLIST = [
  'src/services/hardware/readiness.ts',       // the one readiness source
  'src/services/hardware/HardwareClient.ts',  // the chokepoint itself
  'src/apps/platform/hardware/HardwareTopology.tsx', // diagnostics surface
  'src/hooks/hardware/useHardwareProxy.ts',   // per-device status projection
];

/** Files allowed to own hardware connections. */
const CONNECTION_OWNER_ALLOWLIST = [
  'src/components/hardware/EdgeRelayMount.tsx',
  'src/services/hardware/HardwareClient.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'test' || entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip line comments and block comments so prose can mention the APIs. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}

const FILES = walk(SRC).map((path) => ({
  rel: path.slice(process.cwd().length + 1).replace(/\\/g, '/'),
  code: stripComments(readFileSync(path, 'utf8')),
}));

describe('hardware readiness has a single source', () => {
  it('no file outside the allowlist reads devices.getStatuses()', () => {
    const offenders = FILES.filter(
      (f) => /devices\.getStatuses\(\)/.test(f.code) && !GET_STATUSES_ALLOWLIST.includes(f.rel),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('printer readiness in the printing/POS layer goes through the readiness service', () => {
    const status = FILES.find((f) => f.rel === 'src/hooks/hardware/usePrinterStatus.ts');
    expect(status).toBeDefined();
    expect(status!.code).toContain('resolveIntentReadiness');
    expect(status!.code).not.toMatch(/devices\.getStatuses\(\)/);
  });

  it('readiness applies a workstation liveness window', () => {
    const readiness = FILES.find((f) => f.rel === 'src/services/hardware/readiness.ts');
    expect(readiness).toBeDefined();
    expect(readiness!.code).toContain('WORKSTATION_LIVENESS_WINDOW_MS');
    expect(readiness!.code).toContain('last_seen_at');
  });
});

describe('hardware connections have a single owner', () => {
  it('only the relay mount loads assignments / connects devices', () => {
    const offenders = FILES.filter(
      (f) =>
        /devices\.(connectAll|loadAssignments)\(/.test(f.code) &&
        !CONNECTION_OWNER_ALLOWLIST.includes(f.rel),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the relay mount selects workstations with a liveness window', () => {
    const mount = FILES.find((f) => f.rel === 'src/components/hardware/EdgeRelayMount.tsx');
    expect(mount).toBeDefined();
    expect(mount!.code).toContain('WORKSTATION_LIVENESS_WINDOW_MS');
  });
});
