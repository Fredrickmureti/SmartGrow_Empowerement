/**
 * ADR-0087 · resolve_label_template fallback ordering guard.
 *
 * Locks in the four-tier preference order defined by the plan:
 *   1. (branch match + exact media)
 *   2. (branch match + media-agnostic)
 *   3. (org-level  + exact media)
 *   4. (org-level  + media-agnostic)
 *
 * A live pgTAP round-trip belongs in the supabase test harness; this
 * source-inspection variant catches the common regression: someone
 * reorders the CASE arms or drops a tier, breaking the fallback silently
 * because most templates still resolve via tier 4.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../supabase/migrations');

// Take the LAST migration that defines resolve_label_template with the
// 4-arg (…, uuid, uuid) signature. Earlier 3-arg definitions are dead.
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

describe('resolve_label_template · fallback ordering (ADR-0087)', () => {
  it('a media-aware definition exists', () => {
    expect(canonicalSql, 'no migration defines resolve_label_template with p_media_profile_id').not.toBeNull();
  });

  it('accepts (p_org_id, p_template_key, p_branch_id, p_media_profile_id)', () => {
    expect(canonicalSql!).toMatch(/p_org_id\s+uuid/);
    expect(canonicalSql!).toMatch(/p_template_key\s+text/);
    expect(canonicalSql!).toMatch(/p_branch_id\s+uuid[\s\S]{0,60}DEFAULT\s+NULL/);
    expect(canonicalSql!).toMatch(/p_media_profile_id\s+uuid[\s\S]{0,60}DEFAULT\s+NULL/);
  });

  it('ranks tier 1 as (branch match + exact media)', () => {
    // The first CASE arm must gate on BOTH branch and media exact match.
    const case1 = canonicalSql!.match(
      /WHEN[\s\S]{0,20}branch_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+p_branch_id[\s\S]{0,80}media_profile_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+p_media_profile_id[\s\S]{0,40}THEN\s+1/i,
    );
    expect(case1).toBeTruthy();
  });

  it('ranks tier 2 as (branch match + media-agnostic)', () => {
    expect(canonicalSql!).toMatch(
      /WHEN[\s\S]{0,20}branch_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+p_branch_id[\s\S]{0,80}media_profile_id\s+IS\s+NULL[\s\S]{0,40}THEN\s+2/i,
    );
  });

  it('ranks tier 3 as (org-level + exact media)', () => {
    expect(canonicalSql!).toMatch(
      /WHEN[\s\S]{0,20}branch_id\s+IS\s+NULL[\s\S]{0,80}media_profile_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+p_media_profile_id[\s\S]{0,40}THEN\s+3/i,
    );
  });

  it('ranks tier 4 as (org-level + media-agnostic)', () => {
    expect(canonicalSql!).toMatch(
      /WHEN[\s\S]{0,20}branch_id\s+IS\s+NULL[\s\S]{0,80}media_profile_id\s+IS\s+NULL[\s\S]{0,40}THEN\s+4/i,
    );
  });

  it('drops the 3-arg legacy signature first (idempotent redeploy)', () => {
    expect(canonicalSql!).toMatch(
      /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.resolve_label_template\s*\(\s*uuid\s*,\s*text\s*,\s*uuid\s*\)/i,
    );
  });

  it('is only granted to authenticated + service_role, revoked from PUBLIC', () => {
    expect(canonicalSql!).toMatch(/REVOKE[\s\S]{0,80}resolve_label_template[\s\S]{0,80}FROM\s+PUBLIC/i);
    expect(canonicalSql!).toMatch(/GRANT\s+EXECUTE[\s\S]{0,120}TO\s+authenticated\s*,\s*service_role/);
  });

  it('orders by rank ASC then version DESC, limit 1 (deterministic winner)', () => {
    expect(canonicalSql!).toMatch(/ORDER\s+BY\s+rnk\s+ASC\s*,\s*version\s+DESC/i);
    expect(canonicalSql!).toMatch(/LIMIT\s+1/i);
  });

  it(`canonical definition file: ${canonicalFile}`, () => {
    expect(canonicalFile).toMatch(/^\d{14}_.+\.sql$/);
  });
});
