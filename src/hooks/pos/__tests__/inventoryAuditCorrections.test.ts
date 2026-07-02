/**
 * Inventory zero-trust audit guards (Stage 3).
 *
 * Static AST-style scans that fail the build if any of the corrections from
 * the inventory audit regress:
 *
 *   - Step 1: process_pos_void must NOT reference inventory_movements and must
 *             NOT directly mutate products.stock_quantity (use stock_movements).
 *   - Step 2: process_pos_transaction must NOT contain a warehouse lookup
 *             without a branch_id filter (no business-wide fallback).
 *   - Step 3: usePOSStockSync must NOT read products.stock_quantity for
 *             availability decisions; it must call the branch-aware RPC.
 *   - Step 6: useProductRealtimeSync subscription must filter by business_id,
 *             not organization_id.
 *   - Step 7: create_invoice_stock_movements must not be called from src/.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

function listMigrations(): string[] {
  const dir = resolve(root, 'supabase/migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(dir, f));
}

function latestDefinitionOf(funcName: string): string | null {
  const files = listMigrations();
  // Walk newest → oldest, return the most recent CREATE OR REPLACE body.
  for (let i = files.length - 1; i >= 0; i--) {
    const src = readFileSync(files[i], 'utf8');
    const re = new RegExp(
      `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(public\\.)?${funcName}\\b[\\s\\S]*?\\$function\\$;`,
      'i'
    );
    const m = src.match(re);
    if (m) return m[0];
  }
  return null;
}

describe('Inventory audit corrections — Stage 3 guards', () => {
  it('Step 1: process_pos_void uses stock_movements, never inventory_movements', () => {
    const def = latestDefinitionOf('process_pos_void');
    expect(def, 'process_pos_void definition must be present in migrations').toBeTruthy();
    expect(def!).not.toMatch(/inventory_movements/i);
    // Must not directly bump products.stock_quantity (that is the trigger's job)
    expect(def!).not.toMatch(/UPDATE\s+products[\s\S]*stock_quantity\s*=/i);
    // Must insert into stock_movements
    expect(def!).toMatch(/INSERT\s+INTO\s+(public\.)?stock_movements/i);
  });

  it('Step 2: process_pos_transaction has no business-wide warehouse fallback', () => {
    const def = latestDefinitionOf('process_pos_transaction');
    expect(def).toBeTruthy();
    // Every warehouse lookup with is_default = true must also filter by branch_id.
    const lookupRe = /FROM\s+(public\.)?warehouses[\s\S]*?LIMIT\s+\d+/gi;
    const lookups = def!.match(lookupRe) ?? [];
    for (const block of lookups) {
      if (/is_default\s*=\s*true/i.test(block)) {
        expect(
          block,
          'warehouse lookup using is_default=true must also filter by branch_id'
        ).toMatch(/branch_id\s*=/i);
      }
    }
  });

  it('Step 3: usePOSStockSync does not read products.stock_quantity for decisions', () => {
    const src = read('src/hooks/pos/usePOSStockSync.ts');
    expect(src).not.toMatch(/from\(["']products["']\)[\s\S]{0,200}stock_quantity/);
    expect(src).toMatch(/get_available_pos_stock_for_register/);
  });

  it('Step 6: useProductRealtimeSync subscription is filtered by business_id', () => {
    const src = read('src/hooks/useProductRealtimeSync.ts');
    expect(src).toMatch(/filter:\s*`business_id=eq\.\$\{businessId\}`/);
    expect(src).not.toMatch(/filter:\s*`organization_id=eq\./);
  });

  it('Step 7: no client code calls the dropped create_invoice_stock_movements RPC', () => {
    function walk(dir: string, acc: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, acc);
        else if (/\.(ts|tsx)$/.test(name) && !full.includes('__tests__')) acc.push(full);
      }
      return acc;
    }
    const files = walk(resolve(root, 'src'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // Allow the RPC name to appear inside generated supabase types, which lives
      // under src/integrations/supabase. Skip that file.
      if (f.includes('integrations/supabase/types.ts')) continue;
      expect(
        src,
        `${f} must not call create_invoice_stock_movements (it was dropped)`
      ).not.toMatch(/rpc\(\s*["']create_invoice_stock_movements["']/);
    }
  });
});
