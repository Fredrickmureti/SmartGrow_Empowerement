/**
 * Track H4c — repo-wide lock-the-surface guard.
 *
 * After Track H4 deleted the legacy renderer-side hardware shells
 * (`PrinterService`, `CashDrawerService`, `ScaleService`,
 * `CustomerDisplayService`, `IoTBoxClient`, `ElectronBridge`, plus the
 * dead `transport/ElectronTransport`), all POS UI code must go through
 * `hardwareClient` + its three sub-namespaces (`devices`, `customerDisplay`,
 * `agent`). This guard scans `src/{components,hooks,pages,apps}/` and
 * fails CI on any direct import of:
 *
 *   - the six deleted modules (defensive — they should not be recreated)
 *   - `BrowserHardwareAdapter` (renderer-side runtime; service-internal)
 *   - `local-agent/AgentClient` (HTTP-agent client; wrapped by hardwareClient.agent)
 *   - `local-display/CustomerDisplayClient` (wrapped by hardwareClient.customerDisplay)
 *
 * The allow-list is exactly the chokepoint file (`HardwareClient.ts`).
 * The test itself is excluded because it references the forbidden strings.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC_ROOT = resolve(__dirname, '../../');

const SCAN_DIRS = ['components', 'hooks', 'pages', 'apps'];

const FORBIDDEN_PATHS = [
  // ── deleted shells ──
  'services/hardware/PrinterService',
  'services/hardware/CashDrawerService',
  'services/hardware/ScaleService',
  'services/hardware/CustomerDisplayService',
  'services/hardware/IoTBoxClient',
  'services/hardware/ElectronBridge',
  'services/hardware/transport/ElectronTransport',
  // ── kept-but-internal shells ──
  'services/hardware/BrowserHardwareAdapter',
  'services/hardware/local-agent/AgentClient',
  'services/hardware/local-display/CustomerDisplayClient',
];

// Names that must not appear as named imports in the scanned tree.
// Matches `import { iotBoxClient … }` / `import { customerDisplayService … }`
// / `import { browserHardwareAdapter … }` from anywhere.
const FORBIDDEN_IDENTIFIERS = [
  'iotBoxClient',
  'agentClient',
  'customerDisplayService',
  'customerDisplayClient',
  'browserHardwareAdapter',
  'printerService',
  'cashDrawerService',
  'scaleService',
  'electronBridge',
];

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.tanstack') continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

const FILES: { rel: string; text: string }[] = [];
for (const dir of SCAN_DIRS) {
  for (const f of walk(join(SRC_ROOT, dir))) {
    const rel = relative(SRC_ROOT, f).split('\\').join('/');
    FILES.push({ rel, text: readFileSync(f, 'utf-8') });
  }
}

describe('Track H4c — no legacy hardware shell imports in renderer surface', () => {
  it('finds files to scan (sanity)', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('no file imports a deleted hardware shell', () => {
    const offenders: string[] = [];
    const patterns = FORBIDDEN_PATHS.map(
      (p) => new RegExp(`from\\s+['"](?:@/|\\.{1,2}/)?${p.replace(/\//g, '/')}(?:\\.(?:ts|tsx))?['"]`),
    );
    for (const { rel, text } of FILES) {
      for (let i = 0; i < patterns.length; i++) {
        if (patterns[i].test(text)) {
          offenders.push(`${rel}  →  ${FORBIDDEN_PATHS[i]}`);
        }
      }
    }
    expect(
      offenders,
      `Files importing a deleted/internal hardware shell directly — route through hardwareClient instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no file references a service-internal hardware singleton by name', () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      for (const id of FORBIDDEN_IDENTIFIERS) {
        // Match the identifier in an import statement OR as a member access.
        // We do not flag the bare token in comments — but a comment that
        // contains "iotBoxClient.foo()" deserves scrutiny anyway.
        const re = new RegExp(`\\b${id}\\b\\s*[.(]|\\bimport[^;]*\\b${id}\\b`);
        if (re.test(text)) {
          offenders.push(`${rel}  →  ${id}`);
        }
      }
    }
    expect(
      offenders,
      `Files referencing a service-internal hardware singleton — use hardwareClient.* instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
