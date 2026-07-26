/**
 * Phase 4.2.7c guardrail — trust-store commands must stay argv-shaped
 * and platform-correct.
 *
 * These commands run with elevated privileges on an operator's machine.
 * The two properties that keep that safe are (a) no shell string is ever
 * constructed, and (b) the cert path is passed as its own argv element
 * so a path containing spaces or metacharacters is inert. This test pins
 * both, plus the per-platform tool selection, so a refactor can't quietly
 * reintroduce string concatenation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../../agent/src/trustStore.ts'), 'utf-8');

describe('agent trust store — safe invocation contract', () => {
  it('uses execFile (argv), never exec/spawn with a shell', () => {
    expect(SRC).toMatch(/import\s*\{\s*execFile\s*\}\s*from\s*'node:child_process'/);
    expect(SRC).not.toMatch(/\bshell\s*:\s*true/);
    expect(SRC).not.toMatch(/\bexecSync\b|\bfrom 'node:child_process'.*\bexec\b\s*,/);
  });

  it('never interpolates the cert path into a command string', () => {
    // A template literal containing certPath next to a binary name is the
    // exact shape that turns into shell injection.
    expect(SRC).not.toMatch(/`[^`]*(certutil|security|update-ca-certificates)[^`]*\$\{/);
  });

  it('selects the right tool per platform', () => {
    expect(SRC).toMatch(/certutil/);           // windows + linux NSS
    expect(SRC).toMatch(/add-trusted-cert/);   // macOS
    expect(SRC).toMatch(/update-ca-certificates/); // linux system bundle
  });

  it('marks elevating steps explicitly so the UI can warn', () => {
    expect(SRC).toMatch(/elevates:\s*true/);
    expect(SRC).toMatch(/describeTrustCommands/);
  });

  it('never runs automatically on import (no top-level apply call)', () => {
    expect(SRC).not.toMatch(/^\s*applyTrustStore\(/m);
    expect(SRC).not.toMatch(/^\s*void\s+applyTrustStore/m);
  });
});
