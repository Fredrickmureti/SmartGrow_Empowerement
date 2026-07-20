/**
 * Architecture guard (ADR-0086 / D2).
 *
 * `pdf-lib` is the low-level PDF assembly library. On the server, exactly
 * ONE module owns it: `supabase/functions/_shared/pdf/**` (canonical A4
 * layout engine, exposed as `PdfBuilder` + shared components). The
 * canonical thermal PDF renderer under `_shared/receipt/pdf/**`
 * (ADR-0084) is the only other allowed owner. Tests may inspect emitted
 * bytes.
 *
 * If any other edge function starts importing `pdf-lib` directly, that
 * is a parallel A4 layout engine sprouting — the exact drift ADR-0086
 * exists to prevent. This test enforces the invariant at build time and
 * pairs with the ESLint rule `local/no-raw-pdf-lib-in-edge-functions`
 * so the guard survives even if the ESLint config is edited.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();

function tracked(paths: string): string[] {
  // ripgrep is available in the sandbox; fall back to git if not.
  try {
    const out = execSync(
      `git ls-files -- 'supabase/functions/**/*.ts'`,
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function isAllowlisted(p: string): boolean {
  const f = p.replace(/\\/g, '/');
  if (f.startsWith('supabase/functions/_shared/pdf/')) return true;
  if (f.startsWith('supabase/functions/_shared/receipt/pdf/')) return true;
  if (/\.(test|spec)\.ts$/.test(f)) return true;
  if (/_test\.ts$/.test(f)) return true;
  return false;
}

const PDF_LIB_IMPORT =
  /(?:from\s+|import\s*\(\s*)["'](?:npm:)?(?:pdf-lib(?:\/[^"']*)?|https?:\/\/[^"']*\/pdf-lib(?:@[^"']*)?(?:\/[^"']*)?)["']/;

describe('architecture: ADR-0086 — one owner for pdf-lib in edge functions', () => {
  const files = tracked('supabase/functions/**/*.ts');

  it('discovers a non-empty file list', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('only the canonical layout owners import pdf-lib', () => {
    const violators: string[] = [];
    for (const rel of files) {
      if (isAllowlisted(rel)) continue;
      const abs = resolve(ROOT, rel);
      try {
        if (!statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      const src = readFileSync(abs, 'utf8');
      if (PDF_LIB_IMPORT.test(src)) violators.push(rel);
    }
    expect(violators, `pdf-lib importers outside _shared/pdf/** and _shared/receipt/pdf/**:\n${violators.join('\n')}`).toEqual([]);
  });

  it('ESLint rule is registered and enforced on supabase/functions/**', () => {
    const cfg = readFileSync(resolve(ROOT, 'eslint.config.js'), 'utf8');
    expect(cfg).toMatch(/no-raw-pdf-lib-in-edge-functions/);
    // Enforced (not just registered) — same "error" contract as ADR-0085.
    expect(cfg).toMatch(/"local\/no-raw-pdf-lib-in-edge-functions"\s*:\s*"error"/);
  });
});
