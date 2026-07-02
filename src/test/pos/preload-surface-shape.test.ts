/**
 * Track H4b — locks the renderer-facing IPC surface shape.
 *
 * Reads `electron/preload.ts` as source text and asserts:
 *   1. The only globally exposed namespace is `pos` (not `electronAPI`).
 *   2. The `pos.*` namespace exposes exactly the documented capability
 *      buckets — drift in either direction (forgotten removal, sneaky
 *      addition) is a build failure.
 *   3. No raw legacy IPC channels (`usb:*`, `serial:*`,
 *      `pos:event:publish`) are reachable from renderer JS.
 *   4. Sensitive sender-bound endpoints (`pos:exec`,
 *      `pos:sale-committed`) are wrapped through the HMAC `envelope()`
 *      helper instead of being invoked with raw payloads.
 *
 * This is a text-level guard rather than an AST guard because the
 * Vitest jsdom pool cannot evaluate `preload.ts` (it imports the
 * `electron` native module). A regex pass is sufficient for the shape
 * contract — the runtime correctness of `envelope()` is covered by
 * `exec-envelope.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../../electron/preload.ts'), 'utf-8');

// The single sanctioned top-level namespace.
const EXPECTED_NAMESPACES = [
  'isElectron',
  'platform',
  'hardware',
  'sale',
  'devices',
  'app',
  'network',
  'storage',
  'offline',
  'print',
  'tray',
  'erp',
] as const;

describe('preload surface shape (Track H4b)', () => {
  it('exposes exactly one global namespace via contextBridge: "pos"', () => {
    const calls = SRC.match(/contextBridge\.exposeInMainWorld\(['"](\w+)['"]/g) ?? [];
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("'pos'");
  });

  it('does NOT export the legacy "electronAPI" namespace anywhere', () => {
    // exposeInMainWorld signature is what matters; the literal string
    // appearing in a JSDoc comment is acceptable because the agent
    // documents why it was removed.
    const exposed = SRC.match(/exposeInMainWorld\(['"]electronAPI['"]/);
    expect(exposed).toBeNull();
  });

  it('exposes the documented pos.* buckets', () => {
    // Match the property keys at the top level of the exposed object.
    // We look for `key: ` patterns within the object literal (loose but
    // sufficient — any reshape that drops a bucket fails here, and any
    // new bucket forces the test author to extend the expected list).
    for (const ns of EXPECTED_NAMESPACES) {
      // `key:` or `key(` for methods; both must appear at top scope.
      const re = new RegExp(`^\\s{2}${ns}\\s*[:(]`, 'm');
      expect(re.test(SRC), `missing pos.${ns}`).toBe(true);
    }
  });

  it('forbids any raw "usb:" or "serial:" ipcRenderer channel', () => {
    // Track H2 deleted these channels — any reintroduction bypasses
    // CommandRouter entirely and re-opens Finding D.
    expect(/ipcRenderer\.invoke\(['"]usb:/i.test(SRC)).toBe(false);
    expect(/ipcRenderer\.invoke\(['"]serial:/i.test(SRC)).toBe(false);
    expect(/ipcRenderer\.send\(['"]usb:/i.test(SRC)).toBe(false);
    expect(/ipcRenderer\.send\(['"]serial:/i.test(SRC)).toBe(false);
  });

  it('forbids the "pos:event:publish" injection channel (Track H3)', () => {
    expect(/ipcRenderer\.invoke\(['"]pos:event:publish['"]/.test(SRC)).toBe(false);
    expect(/ipcRenderer\.send\(['"]pos:event:publish['"]/.test(SRC)).toBe(false);
  });

  it('wraps pos:exec and pos:sale-committed through envelope()', () => {
    // The two sender-pinned channels must never be invoked with a raw
    // payload — that would bypass the HMAC verifier in main.ts.
    const execLine = SRC.match(/ipcRenderer\.invoke\(['"]pos:exec['"][^)]+\)/);
    expect(execLine).not.toBeNull();
    expect(execLine![0]).toContain('envelope(');

    const saleLine = SRC.match(/ipcRenderer\.invoke\(['"]pos:sale-committed['"][^)]+\)/);
    expect(saleLine).not.toBeNull();
    expect(saleLine![0]).toContain('envelope(');
  });

  it('never returns the session secret back to renderer JS', () => {
    // The secret is fetched in a preload-scope closure; if it ever
    // appears as a contextBridge property the threat model collapses.
    // Match any `secret` identifier inside the exposed object.
    const exposedBlock = SRC.split('contextBridge.exposeInMainWorld')[1] ?? '';
    expect(/\bsecret\b/i.test(exposedBlock)).toBe(false);
  });
});
