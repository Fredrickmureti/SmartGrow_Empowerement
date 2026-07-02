/**
 * Stage-3 RLS guard.
 *
 * Stage-1 dropped legacy permissive `is_org_member` policies on
 * `pos_transactions`, `pos_shifts`, `pos_registers`. Stage-3 extends the
 * same coverage to the remaining 11 POS-touching tables (payment methods,
 * settings, security settings, GL mappings, held transactions, cashiers,
 * cash movements, daily sales summary, transaction items / payments,
 * stock movements) and tightens the warehouses SELECT policy with a
 * branch gate.
 *
 * This test scans every migration file and fails if any active CREATE
 * POLICY on these Stage-3 tables references the legacy `is_org_member(`
 * helper without a matching DROP in a later migration.
 *
 * Migrations are read-only at runtime, so a textual scan is sufficient.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

const STAGE3_TABLES = [
  'pos_payment_methods',
  'pos_settings',
  'pos_security_settings',
  // 'pos_gl_mappings' removed in Settings Architecture Cleanup (consolidated to default_account_settings)
  'pos_held_transactions',
  'pos_cashiers',
  'pos_cash_movements',
  'pos_daily_sales_summary',
  'pos_transaction_items',
  'pos_transaction_payments',
  'stock_movements',
] as const;

interface PolicyHit {
  file: string;
  policyName: string;
  table: string;
  body: string;
}

function extractPolicies(sql: string, file: string, table: string): PolicyHit[] {
  const re = new RegExp(
    `create\\s+policy\\s+"?([^"\\s]+)"?\\s+on\\s+(?:public\\.)?${table}\\b([\\s\\S]*?);`,
    'gi',
  );
  const hits: PolicyHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    hits.push({ file, policyName: m[1], table, body: m[2] });
  }
  return hits;
}

function isPolicyDropped(allSql: string, table: string, policyName: string): boolean {
  const safeName = policyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `drop\\s+policy\\s+(?:if\\s+exists\\s+)?"?${safeName}"?\\s+on\\s+(?:public\\.)?${table}\\b`,
    'i',
  );
  return re.test(allSql);
}

describe('Stage-3 POS RLS architecture guard', () => {
  it('no Stage-3 POS table has an active is_org_member policy', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const allSql = files.map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8')).join('\n');

    const violations: string[] = [];

    for (const file of files) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
      for (const table of STAGE3_TABLES) {
        const policies = extractPolicies(sql, file, table);
        for (const p of policies) {
          const usesLegacyHelper = /is_org_member\s*\(/i.test(p.body);
          if (!usesLegacyHelper) continue;
          if (isPolicyDropped(allSql, table, p.policyName)) continue;
          violations.push(
            `  - ${file} :: policy "${p.policyName}" on ${table} ` +
              `uses is_org_member( ) without a later DROP. ` +
              `Replace with user_can_access_business + user_has_module_permission.`,
          );
        }
      }
    }

    expect(
      violations,
      `Stage-3 POS RLS regressions detected:\n${violations.join('\n')}\n` +
        `Every Stage-3 POS table policy must scope by business_id via ` +
        `user_can_access_business and user_has_module_permission ` +
        `(see audit Stage-3 / Issue #1).`,
    ).toEqual([]);
  });
});