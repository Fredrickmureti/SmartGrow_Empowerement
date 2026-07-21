/**
 * ADR-0087 — Phase 13 · media-agnostic default resolution.
 *
 * Locks in the "defaults are media-agnostic" contract landed by migration
 * `20260721005711_*.sql`:
 *   - Existing default rows have their `media_profile_id` nulled so the
 *     resolver's rnk=2/rnk=4 arms match callers with no media.
 *   - `seed_default_label_templates()` inserts `media_profile_id = NULL`
 *     for new organizations.
 *   - The resolver gains a `rnk=5` last-resort arm: a template pins media
 *     but the caller doesn't → still resolves. Prevents the "no template
 *     registered" silent-drop class of regression forever.
 *
 * Source-inspection guard (matches the house style — see
 * media-profile-resolution.test.ts). A pgTAP round-trip belongs in the
 * supabase test harness; this file guards the SQL shape and comment
 * markers so a future refactor cannot silently regress.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../supabase/migrations');

// Pick the LAST migration that redefines resolve_label_template — that is
// the canonical one currently deployed. Earlier definitions are dead code.
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
let canonicalSql: string | null = null;
let canonicalFile = '';
for (const f of files) {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, f), 'utf-8');
  if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.resolve_label_template\s*\(/i.test(sql)
      && /p_media_profile_id/.test(sql)) {
    canonicalSql = sql;
    canonicalFile = f;
  }
}

// Also pick the LAST seed_default_label_templates definition.
let seedSql: string | null = null;
for (const f of files) {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, f), 'utf-8');
  if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.seed_default_label_templates\s*\(/i.test(sql)) {
    seedSql = sql;
  }
}

describe('resolve_label_template · media-agnostic default (ADR-0087 · Phase 13)', () => {
  it('the canonical resolver definition is present', () => {
    expect(canonicalSql, `no migration defines resolve_label_template · found in ${canonicalFile}`).not.toBeNull();
  });

  it('adds a rnk=5 last-resort arm: template pins media, caller passed none', () => {
    // The safety-net arm must gate on: caller passed no media (p_media_profile_id IS NULL)
    // AND template pins media (t.media_profile_id IS NOT NULL) AND scope is org-level.
    expect(canonicalSql!).toMatch(
      /WHEN[\s\S]{0,40}branch_id\s+IS\s+NULL[\s\S]{0,120}p_media_profile_id\s+IS\s+NULL[\s\S]{0,120}media_profile_id\s+IS\s+NOT\s+NULL[\s\S]{0,60}THEN\s+5/i,
    );
  });

  it('rnk=5 is documented as "last-resort" so no one deletes it as dead code', () => {
    expect(canonicalSql!).toMatch(/last-resort/i);
  });

  it('rank ordering means callers with media still win over the last-resort arm', () => {
    // Ranks 1-4 must appear textually before rnk=5, and the SELECT uses
    // `ORDER BY rnk ASC LIMIT 1`, so an exact media match always outranks
    // the safety net.
    const idx1 = canonicalSql!.search(/THEN\s+1/);
    const idx5 = canonicalSql!.search(/THEN\s+5/);
    expect(idx1).toBeGreaterThan(-1);
    expect(idx5).toBeGreaterThan(idx1);
    expect(canonicalSql!).toMatch(/ORDER\s+BY\s+rnk\s+ASC/i);
    expect(canonicalSql!).toMatch(/LIMIT\s+1/i);
  });

  it('nulls media_profile_id on existing default org-scope rows', () => {
    // Migration must UPDATE is_default=true, branch_id IS NULL rows to
    // media_profile_id = NULL so rnk=2/rnk=4 can match them.
    const fixMigration = files
      .map((f) => ({ f, sql: readFileSync(resolve(MIGRATIONS_DIR, f), 'utf-8') }))
      .find(({ sql }) =>
        /UPDATE\s+public\.label_templates[\s\S]{0,200}SET\s+media_profile_id\s*=\s*NULL/i.test(sql)
        && /is_default\s*=\s*true[\s\S]{0,80}branch_id\s+IS\s+NULL/i.test(sql),
      );
    expect(
      fixMigration,
      'no migration nulls media_profile_id on default org-scope label_templates rows',
    ).toBeTruthy();
  });
});

describe('seed_default_label_templates · media-agnostic default insert', () => {
  it('the canonical seed function definition is present', () => {
    expect(seedSql, 'no migration defines seed_default_label_templates').not.toBeNull();
  });

  it('inserts media_profile_id = NULL for new organizations', () => {
    // The INSERT statement must terminate the VALUES tuple with NULL for
    // media_profile_id (the last column in the column list before
    // geometry_mode). We look for an explicit ADR-0087 comment marker
    // and the "media-agnostic" intent (Phase 17 expanded the seed to
    // include six sibling templates, so the marker moved onto the
    // function-level COMMENT).
    expect(seedSql!).toMatch(/media-agnostic/i);
    expect(seedSql!).toMatch(/ADR-0087/);
    // The column list must include media_profile_id.
    expect(seedSql!).toMatch(/media_profile_id\b/);
  });

  it('does NOT reference a specific media_profiles row (no v_media_* lookups)', () => {
    // Phase 9/10 seeded with `v_media_label_80x50`; Phase 13 removed that.
    expect(seedSql!).not.toMatch(/v_media_label_\d+x\d+/);
  });
});
