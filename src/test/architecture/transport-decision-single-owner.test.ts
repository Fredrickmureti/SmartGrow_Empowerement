import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Wave 9d Phase 5 Step C guard.
 *
 * `TransportRouter.route()` is the ONLY place allowed to decide which
 * transport a device uses. `transport/index.ts` may instantiate the
 * concrete transport from that decision, but no driver, service, or UI
 * component may branch on connection shape (connectionType / isPrivateIP /
 * isElectron) to pick a transport.
 */
const ROOT = join(process.cwd(), 'src');
const ALLOWED = [
  'src/services/hardware/transport/TransportRouter.ts',
  'src/services/hardware/transport/HostRouter.ts',
  'src/services/hardware/transport/index.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('transport decision has a single owner', () => {
  const files = walk(ROOT).filter(f => !f.includes(`${'src'}/test/`));

  it('no file outside the transport layer instantiates a transport directly', () => {
    const offenders = files.filter(f => {
      const rel = f.slice(f.indexOf('src/'));
      if (ALLOWED.includes(rel)) return false;
      const src = readFileSync(f, 'utf8');
      return /new\s+(LocalAgentNetworkTransport|LocalAgentUSBTransport|WebUSBTransport)\s*\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('resolveTransport takes a persisted transport intent, never a connectionType', () => {
    const src = readFileSync(join(ROOT, 'services/hardware/transport/index.ts'), 'utf8');
    expect(src).not.toMatch(/connectionType:\s*'network'\s*\|/);
    expect(src).toMatch(/routeWithRuntimeHost/);
  });

  it('no caller passes connectionType into resolveTransport', () => {
    const offenders = files.filter(f => {
      const src = readFileSync(f, 'utf8');
      if (!src.includes('resolveTransport')) return false;
      return /resolveTransport\([\s\S]{0,300}?connectionType\s*:/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
