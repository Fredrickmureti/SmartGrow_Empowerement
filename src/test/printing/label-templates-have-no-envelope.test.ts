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
  .sort() // filenames are timestamp-prefixed, so lexical sort = replay order
  .map((f) => ({ name: f, sql: readFileSync(resolve(MIGRATIONS_DIR, f), 'utf-8') }));

/**
 * Extract every dollar-quoted string body from a SQL blob. Postgres
 * allows arbitrary tags between the dollars ($$…$$, $body$…$body$).
 */
function extractDollarQuoted(sql: string): string[] {
  const literals: string[] = [];
  const dollarQuoted = /\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/g;
  let m: RegExpExecArray | null;
  while ((m = dollarQuoted.exec(sql)) !== null) {
    literals.push(m[2]);
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

/** A dollar-quoted body is "template-body-like" when it references either
 *  ZPL/EPL layout tokens or a `{{token}}` substitution marker. Filters out
 *  DDL-only literals, plpgsql function bodies with no label content, etc. */
function isTemplateBodyLike(lit: string): boolean {
  return /\^XA|\^FO|\^FD|\{\{[\w.]+\}\}|(^|\n)A\d+,\d+|(^|\n)B\d+,\d+/m.test(lit);
}

/**
 * Postgres migrations replay historically, but the runtime state we
 * actually care about is "what does the LAST redefinition of
 * seed_default_label_templates emit?" — a superseded body from before
 * ADR-0087 is dead code, replayed only to be immediately overwritten by
 * the Phase 10 migration. So the assertion runs against:
 *   (a) the FINAL `CREATE OR REPLACE FUNCTION public.seed_default_label_templates`
 *       block in migration replay order, and
 *   (b) every direct `INSERT INTO public.label_templates ...` seed
 *       whose body literal appears AFTER that final function definition
 *       (older direct inserts are already superseded by Phase 10's
 *       backfill that strips envelope from every existing row).
 */
const SEED_FN_RE = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.seed_default_label_templates/i;

// Walk migrations to find the final seed_default_label_templates
// definition and everything after it.
let finalSeedFile: { name: string; sql: string } | null = null;
for (const file of migrationFiles) {
  if (SEED_FN_RE.test(file.sql)) finalSeedFile = file;
}

describe('ADR-0087 · label_templates.body is envelope-free (guardrail)', () => {
  it('located the canonical seed_default_label_templates definition', () => {
    expect(finalSeedFile, 'no migration defines seed_default_label_templates').not.toBeNull();
  });

  it('the canonical seed function body has no paper envelope', () => {
    if (!finalSeedFile) return;
    const literals = extractDollarQuoted(finalSeedFile.sql).filter(isTemplateBodyLike);
    for (const body of literals) {
      for (const { label, re } of ENVELOPE_PATTERNS) {
        expect(
          re.test(body),
          `Envelope pattern "${label}" found in the canonical seed_default_label_templates ` +
          `body (${finalSeedFile.name}). Envelope commands must be emitted by the driver ` +
          `(ZplLabelDriver / EplLabelDriver / BrowserHardwareAdapter) from the resolved ` +
          `media profile, not baked into template bodies. See ADR-0087.`,
        ).toBe(false);
      }
    }
  });

  it('no migration authored AFTER the canonical seed definition reintroduces an envelope', () => {
    if (!finalSeedFile) return;
    const cutoff = finalSeedFile.name;
    const afterCutoff = migrationFiles.filter(
      (f) => f.name > cutoff && /label_templates/i.test(f.sql),
    );
    for (const { name, sql } of afterCutoff) {
      const literals = extractDollarQuoted(sql).filter(isTemplateBodyLike);
      for (const body of literals) {
        for (const { label, re } of ENVELOPE_PATTERNS) {
          expect(
            re.test(body),
            `Envelope pattern "${label}" reintroduced by ${name}. Post-ADR-0087 migrations ` +
            `must not seed label_templates.body with envelope commands.`,
          ).toBe(false);
        }
      }
    }
  });
});
