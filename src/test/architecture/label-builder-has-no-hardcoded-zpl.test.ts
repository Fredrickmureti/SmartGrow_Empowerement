/**
 * Architecture guard (ADR-0086 / D1).
 *
 * `supabase/functions/_shared/printing/zpl/builder.ts` is a resolver over
 * `label_templates`, not an emitter. It must contain zero ZPL body
 * literals — every `^XA`/`^XZ` envelope must originate in the templates
 * table. This test locks that shape so a regression that re-inlines a
 * body (the pre-D1 shape) fails the build instead of shipping a second
 * source of truth for label bytes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('architecture: server-side label adapter is template-driven', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'supabase/functions/_shared/printing/zpl/builder.ts'),
    'utf8',
  );

  it('has no inline ZPL body (no ^XA or ^XZ string literal)', () => {
    // Strip comments so header prose that mentions the tokens as text
    // (e.g. "^XA/^XZ envelope") does not trip the guard.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/\^XA/);
    expect(codeOnly).not.toMatch(/\^XZ/);
  });

  it('resolves bodies via the resolve_label_template RPC', () => {
    expect(src).toMatch(/resolve_label_template/);
  });
});
