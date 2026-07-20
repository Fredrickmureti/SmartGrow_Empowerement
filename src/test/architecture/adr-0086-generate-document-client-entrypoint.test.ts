/**
 * Architecture guard (ADR-0086 / D3).
 *
 * The canonical client entrypoint for server-rendered documents is
 * `useDocumentPrint`. Page modules must not invoke the `generate-document`
 * edge function directly — doing so reopens the shadow path this ADR
 * exists to close.
 *
 * Enforced at build time and paired with ESLint rule
 * `local/no-direct-generate-document-in-pages` so the guard survives even
 * if a page bypasses static analysis.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();

function tracked(): string[] {
  try {
    const out = execSync(
      `git ls-files -- 'src/pages/**/*.ts' 'src/pages/**/*.tsx' 'src/features/**/pages/**/*.ts' 'src/features/**/pages/**/*.tsx'`,
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const DIRECT_INVOKE =
  /\.functions\.invoke\(\s*["'`]generate-document["'`]/;

describe('architecture: ADR-0086 / D3 — page modules do not invoke generate-document directly', () => {
  const files = tracked();

  it('discovers a non-empty file list', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no page module invokes generate-document directly', () => {
    const violators: string[] = [];
    for (const rel of files) {
      const abs = resolve(ROOT, rel);
      try {
        if (!statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      const src = readFileSync(abs, 'utf8');
      if (!DIRECT_INVOKE.test(src)) continue;
      // Honour per-line RENDERER-EXEMPT escape hatch.
      const lines = src.split('\n');
      let flagged = false;
      for (let i = 0; i < lines.length; i++) {
        if (!DIRECT_INVOKE.test(lines[i])) continue;
        const prev = lines[i - 1] ?? '';
        if (/RENDERER-EXEMPT:/.test(prev)) continue;
        flagged = true;
        break;
      }
      if (flagged) violators.push(rel);
    }
    expect(
      violators,
      `Pages calling generate-document directly (use useDocumentPrint):\n${violators.join('\n')}`,
    ).toEqual([]);
  });

  it('ESLint rule is registered and enforced on page globs', () => {
    const cfg = readFileSync(resolve(ROOT, 'eslint.config.js'), 'utf8');
    expect(cfg).toMatch(/no-direct-generate-document-in-pages/);
    expect(cfg).toMatch(
      /"local\/no-direct-generate-document-in-pages"\s*:\s*"error"/,
    );
  });
});