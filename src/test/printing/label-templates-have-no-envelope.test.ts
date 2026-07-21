/**
 * ADR-0087 guardrail — label template bodies MUST NOT own paper geometry.
 *
 * Scans every migration under `supabase/migrations/` for `INSERT` /
 * `VALUES` blocks that populate `label_templates.body` (either directly
 * or via the `seed_default_label_templates` function) and asserts no
 * envelope command (`^PW`, `^LL`, EPL `q<dots>`, `Q<dots>,<gap>`) appears
 * inside a `body` string literal.
 *
 * Envelope emission is a driver responsibility now (`ZplLabelDriver` /
 * `EplLabelDriver` / `BrowserHardwareAdapter`). A body that hardcodes
 * `^PW640` renders correctly on the ONE roll it was seeded for and
 * silently mis-scales on every other size — which is exactly the
 * regression this test catches at build time.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../supabase/migrations');

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ name: f, sql: readFileSync(resolve(MIGRATIONS_DIR, f), 'utf-8') }));

/**
 * Extract every dollar-quoted string body that follows any occurrence of
 * a `label_templates` INSERT-shaped statement (or the seed function that
 * writes into it). We look for any $$-delimited literal that mentions
 * ZPL/EPL and check that literal alone — this keeps the test tolerant of
 * whichever quoting style a migration chose.
 */
function extractLabelBodyLiterals(sql: string): string[] {
  const literals: string[] = [];
  // Match every $$...$$ (or $tag$...$tag$) block. Postgres allows tags.
  const dollarQuoted = /\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/g;
  let m: RegExpExecArray | null;
  while ((m = dollarQuoted.exec(sql)) !== null) {
    literals.push(m[2]);
  }
  // Also inline single-quoted string literals passed to INSERT INTO label_templates.
  // Best-effort — captures every '...' after an occurrence of "label_templates".
  if (/label_templates/i.test(sql)) {
    const singleQuoted = /'([^']|'')*'/g;
    let s: RegExpExecArray | null;
    while ((s = singleQuoted.exec(sql)) !== null) {
      literals.push(s[0]);
    }
  }
  return literals;
}

// Envelope patterns owned exclusively by the driver post ADR-0087.
const ENVELOPE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'ZPL ^PW', re: /\^PW\d+/ },
  { label: 'ZPL ^LL', re: /\^LL\d+/ },
  { label: 'EPL q<dots>', re: /(^|\n|\r|\s)q\d+\s*(\r?\n|\\r\\n|\\n)/ },
  { label: 'EPL Q<dots>,<gap>', re: /(^|\n|\r|\s)Q\d+,\d+/ },
];

describe('ADR-0087 · label_templates.body is envelope-free (guardrail)', () => {
  it('scans every migration file', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  for (const { name, sql } of migrationFiles) {
    // Only exercise migrations that actually touch label_templates.
    if (!/label_templates/i.test(sql)) continue;

    it(`migration ${name} does not seed a body containing a paper envelope`, () => {
      const literals = extractLabelBodyLiterals(sql);

      // Filter to literals plausibly a template body — must reference either
      // a ZPL `^XA`/`^FO` token or an EPL `A<x>,<y>` / `B<x>,<y>` line, or
      // the classic `{{token}}` substitution marker. This trims file-level
      // COMMENT strings and DDL-only literals from the assertion set.
      const bodyLikely = literals.filter(
        (lit) => /\^XA|\^FO|\^FD|\{\{[\w.]+\}\}|^A\d+,\d+|^B\d+,\d+/m.test(lit),
      );

      for (const body of bodyLikely) {
        for (const { label, re } of ENVELOPE_PATTERNS) {
          expect(
            re.test(body),
            `Envelope pattern "${label}" found in a label_templates body in ${name}. ` +
            `Envelope commands must be emitted by the driver (ZplLabelDriver / EplLabelDriver / BrowserHardwareAdapter) ` +
            `from the resolved media profile, not baked into template bodies. See ADR-0087.`,
          ).toBe(false);
        }
      }
    });
  }
});
