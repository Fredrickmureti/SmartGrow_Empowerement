/**
 * SQL guard (Stage 4 / step 14 of POS audit).
 *
 * Scans every migration file for RLS policies attached to `pos_*` tables.
 * Fails the build if any newly created policy gates only on `organization_id`
 * without a matching `business_id` predicate or a `has_role` / role-based
 * check. This prevents regressions where a future migration accidentally
 * re-introduces the legacy "open-to-org" policy class that was removed in
 * migration 20260422205234.
 *
 * The check is intentionally textual: the migrations folder is read-only at
 * runtime, the SQL is human-authored and small, and we only need to flag
 * obvious regressions — not parse arbitrary Postgres grammar.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

interface PolicyHit {
  file: string;
  policyName: string;
  table: string;
  body: string;
}

/**
 * Extract every CREATE POLICY ... ON public.pos_* statement from a SQL file.
 * Captures the policy name, target table, and the full statement body up to
 * its terminating semicolon (so we can grep predicates inside USING / WITH CHECK).
 */
function extractPosPolicies(sql: string, file: string): PolicyHit[] {
  const hits: PolicyHit[] = [];
  // Tolerant regex: handles "ON pos_x", "ON public.pos_x", quoted identifiers,
  // and policies that span many lines. We stop at the first ';' that isn't
  // inside a (...) group — close enough for our migration style.
  const re = /create\s+policy\s+"?([^"\s]+)"?\s+on\s+(?:public\.)?(pos_[a-z_]+)([\s\S]*?);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    hits.push({ file, policyName: m[1], table: m[2], body: m[3] });
  }
  return hits;
}

describe('POS RLS architecture guard', () => {
  it('no pos_* RLS policy gates on organization_id alone', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const violations: string[] = [];

    for (const file of files) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
      const policies = extractPosPolicies(sql, file);

      for (const p of policies) {
        const body = p.body.toLowerCase();
        // Skip policies the same migration explicitly drops afterwards — they
        // are historical and harmless. We don't track that precisely; instead
        // we accept any policy that ALSO references business_id, has_role,
        // can_access_branch, or role-based helpers.
        const hasBusinessScope = /business_id/.test(body);
        const hasRoleCheck = /has_role|can_access_branch|has_module_permission|is_super_admin/.test(body);
        const referencesOrg = /organization_id/.test(body);

        if (referencesOrg && !hasBusinessScope && !hasRoleCheck) {
          violations.push(
            `  - ${file} :: policy "${p.policyName}" on ${p.table} ` +
              `references organization_id without business_id or role check`,
          );
        }
      }
    }

    expect(
      violations,
      `Org-only POS RLS policy regressions detected:\n${violations.join('\n')}\n` +
        `Every pos_* policy must scope by business_id (or use has_role / ` +
        `can_access_branch / has_module_permission). See audit TB-4.`,
    ).toEqual([]);
  });
});
