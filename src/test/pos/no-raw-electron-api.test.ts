/**
 * Track H4b — repository-wide guard against renderer code talking to
 * Electron directly.
 *
 * After H2 deleted the legacy `window.electronAPI` surface, every
 * hardware interaction must flow through `window.pos.hardware.exec`
 * (sender-pinned HMAC envelope, ADR-0014 Track H3). This guard scans
 * `src/` and fails CI on:
 *
 *   - `window.electronAPI`           — the deleted surface
 *   - `require('electron')` /
 *     `from 'electron'`              — direct main/preload imports leaking
 *                                       into the renderer bundle
 *   - `ipcRenderer` references       — bypassing the preload chokepoint
 *
 * Allow-list:
 *   - `src/types/electron.d.ts`  — ambient typing for `window.pos`
 *   - `src/lib/environment.ts`   — soft `window.pos?.isElectron` detect
 *   - `src/test/pos/preload-surface-shape.test.ts` — reads preload as text
 *   - this file itself                 — references the forbidden strings
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../src');
const ALLOWED = new Set<string>([
  'types/electron.d.ts',
  'lib/environment.ts',
  'test/pos/no-raw-electron-api.test.ts',
  'test/pos/preload-surface-shape.test.ts',
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip node_modules / build outputs if any sneak in
      if (entry === 'node_modules' || entry === 'dist' || entry === '.tanstack') continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

const FILES = walk(ROOT)
  .map((f) => ({ path: f, rel: relative(ROOT, f).split('\\').join('/') }))
  .filter((f) => !ALLOWED.has(f.rel));

describe('no raw electron API in renderer (Track H4b)', () => {
  it('window.electronAPI is not referenced anywhere in src/', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(f.path, 'utf-8');
      if (/window\s*\.\s*electronAPI/.test(text)) offenders.push(f.rel);
    }
    expect(offenders, `Files referencing window.electronAPI:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no renderer file imports from "electron" directly', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(f.path, 'utf-8');
      if (/from\s+['"]electron['"]/.test(text)) offenders.push(f.rel);
      if (/require\(\s*['"]electron['"]\s*\)/.test(text)) offenders.push(f.rel);
    }
    expect(offenders, `Files importing 'electron':\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no renderer file references ipcRenderer (must use window.pos.*)', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(f.path, 'utf-8');
      if (/\bipcRenderer\b/.test(text)) offenders.push(f.rel);
    }
    expect(offenders, `Files referencing ipcRenderer:\n${offenders.join('\n')}`).toEqual([]);
  });
});
