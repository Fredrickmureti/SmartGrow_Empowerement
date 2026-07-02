/**
 * POS multi-entity contamination guards (Stage 2 of POS audit).
 *
 * These tests are static AST-style scans of POS hook source files. They fail the
 * build if a regression reintroduces any of the contamination patterns the
 * zero-trust audit eliminated:
 *
 *   - TB-2: `business_id.is.null` fallback in any POS query
 *   - AI-2: terminal-session query missing a `business_id` filter
 *   - TB-7: pos_sessions insert missing `branch_id`
 *   - AI-3: stale-session UPDATE missing `business_id` filter
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('POS scope contamination guards', () => {
  it('no POS hook leaks rows via business_id.is.null', () => {
    const files = [
      'src/hooks/pos/usePOSProducts.ts',
      'src/hooks/pos/usePOSTransactionHistory.ts',
      'src/hooks/pos/usePOSSessions.ts',
      'src/hooks/pos/useTerminalSession.ts',
      'src/hooks/pos/usePOSDashboardStats.ts',
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, `${f} must not contain "business_id.is.null"`).not.toMatch(/business_id\.is\.null/);
    }
  });

  it('useTerminalSession scopes pos_sessions read by business_id', () => {
    const src = read('src/hooks/pos/useTerminalSession.ts');
    // Must resolve the register's business and apply it as a filter.
    expect(src).toMatch(/from\('pos_registers'\)/);
    expect(src).toMatch(/\.eq\('business_id', register\.business_id\)/);
  });

  it('usePOSSessions inserts pos_sessions with branch_id resolved from register', () => {
    const src = read('src/hooks/pos/usePOSSessions.ts');
    // Both insert paths must read the register first.
    const registerLookups = src.match(/from\('pos_registers'\)/g) ?? [];
    expect(registerLookups.length).toBeGreaterThanOrEqual(2);
    // Both inserts must stamp branch_id from register.
    expect(src).toMatch(/branch_id:\s*register\.branch_id/);
    // Stale-session UPDATE must filter by business_id (AI-3).
    expect(src).toMatch(/\.eq\('cashier_id', cashierId\)[\s\S]{0,200}\.eq\('business_id'/);
  });

  it('process_pos_transaction is invoked with business_id derived from register, not UI context', () => {
    // The offline path must already resolve the register to get branch_id; the same
    // lookup carries business_id. The DB function additionally re-validates this
    // server-side (TB-6), but the client must not regress.
    const offline = read('src/hooks/pos/usePOSTransactionOffline.ts');
    expect(offline).toMatch(/from\("pos_registers"\)[\s\S]*business_id/);
    const queue = read('src/services/offline/TransactionQueue.ts');
    expect(queue).toMatch(/p_business_id:\s*data\.business_id/);
  });
});
