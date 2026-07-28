/**
 * Regression guard — Sales/Purchases business documents can route to
 * thermal ESC/POS when the operator explicitly configures that policy.
 *
 * This protects the exact failure where `resolve_output_intent` silently
 * forced invoices and purchase orders back to A4 PDF even though the policy
 * row said 80/58/40 mm + ESC/POS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS = resolve(__dirname, '../../../supabase/migrations');

function latestResolveOutputIntentMigration(): string {
  const candidates = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .reverse();

  for (const name of candidates) {
    const sql = readFileSync(resolve(MIGRATIONS, name), 'utf8');
    if (/CREATE OR REPLACE FUNCTION public\.resolve_output_intent/.test(sql)) {
      return sql;
    }
  }
  throw new Error('resolve_output_intent migration not found');
}

describe('resolve_output_intent thermal business-document routing', () => {
  const sql = latestResolveOutputIntentMigration();

  it('does not keep the old POS-only thermal blockade', () => {
    expect(sql).not.toMatch(/Only true receipt\/kitchen documents may use ESC\/POS\/thermal routing/);
    expect(sql).not.toMatch(/Business documents such as invoices and delivery notes must remain A4/);
  });

  it('lists Sales and Purchases documents as thermal-capable policy targets', () => {
    for (const docType of ['invoice', 'sales_order', 'purchase_order', 'bill']) {
      expect(sql).toMatch(new RegExp(`'${docType}'`));
    }
    expect(sql).toMatch(/v_is_thermal_capable_kind/);
  });

  it('requires an explicit ESC/POS thermal-paper policy before business docs become raw bytes', () => {
    expect(sql).toMatch(/v_policy\.render_mode = 'escpos'/);
    expect(sql).toMatch(/v_policy\.paper_format IN \('80mm', '58mm', '40mm'\)/);
    expect(sql).toMatch(/v_thermal_hardware_role/);
    expect(sql).toMatch(/THEN 'escpos'/);
  });

  it('keeps invalid ESC/POS policies auditable instead of silently pretending they are valid', () => {
    expect(sql).toMatch(/v_coerced_to_pdf :=/);
    expect(sql).toMatch(/'coerced_to_pdf', v_coerced_to_pdf/);
  });
});