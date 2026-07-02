/**
 * Stage B (branch isolation) — static guards.
 *
 * These tests fail the build if a regression reintroduces cross-branch
 * leakage in any of the POS surfaces that were branch-scoped during the
 * isolation overhaul. They scan source text so they run without a DB.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('POS Stage B — branch isolation guards', () => {
  it('register list, shifts, cashiers, active register hooks reference currentBranch', () => {
    const files = [
      'src/hooks/pos/usePOSRegisters.ts',
      'src/hooks/pos/usePOSShifts.ts',
      'src/hooks/pos/usePOSCashiers.ts',
      'src/hooks/pos/useActivePOSRegister.ts',
      'src/hooks/pos/useActiveOrDefaultRegister.ts',
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, `${f} must consult currentBranch`).toMatch(/currentBranch/);
      expect(src, `${f} must filter by branch_id`).toMatch(/branch_id/);
    }
  });

  it('terminal route mounts via a branch guard before any inner hooks run', () => {
    const src = read('src/pages/pos/POSTerminal.tsx');
    expect(src).toMatch(/useRegisterBranchGuard/);
    expect(src).toMatch(/CrossBranchRedirect/);
    // The guard must run in the outer default export, not after other hooks
    // inside POSTerminalInner — otherwise the Rules of Hooks are violated
    // when the guard transitions from "checking" to "wrong-branch".
    expect(src).toMatch(/function POSTerminalInner/);
  });

  it('useTerminalSession realtime channel name is keyed by branch', () => {
    const src = read('src/hooks/pos/useTerminalSession.ts');
    expect(src).toMatch(/terminal-session-\$\{registerId\}-\$\{expectedBusinessId[^}]*\}-\$\{expectedBranchId/);
    expect(src).toMatch(/payloadBranchId/);
  });

  it('useWaitlist realtime channel scopes by org/business/branch and drops foreign payloads', () => {
    const src = read('src/hooks/pos/useWaitlist.ts');
    expect(src).toMatch(/waitlist-realtime-\$\{orgId\}/);
    expect(src).toMatch(/payloadBranch !== branchId/);
  });

  // Stage B6 — restaurant surfaces.
  it('kitchen-display and table-bookings hooks scope by branch (read + insert)', () => {
    const kds = read('src/hooks/pos/useKitchenDisplay.ts');
    expect(kds, 'KDS must consult currentBranch').toMatch(/currentBranch/);
    expect(kds, 'KDS query must filter by branch_id').toMatch(/eq\("branch_id", branchId\)/);
    expect(kds, 'KDS realtime channel must be branch-keyed').toMatch(/kitchen-orders-realtime-\$\{orgId\}/);
    expect(kds, 'KDS realtime must drop foreign-branch payloads').toMatch(/payloadBranch && payloadBranch !== branchId/);
    expect(kds, 'KDS insert must stamp branch_id').toMatch(/branch_id: branchId,/);

    const tb = read('src/hooks/pos/useTableBookings.ts');
    expect(tb, 'Bookings must consult currentBranch').toMatch(/currentBranch/);
    expect(tb, 'Bookings queries must filter by branch_id').toMatch(/eq\("branch_id", branchId\)/);
    expect(tb, 'Bookings insert must stamp branch_id').toMatch(/branch_id: branchId,/);
  });

  // Stage B3 — server-side enforcement is present in a migration.
  it('server-side caller-authority trigger function exists in a migration', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const hits = execSync(
      "rg -l 'assert_pos_caller_branch_access' supabase/migrations/ || true",
      { encoding: 'utf8' },
    ).trim();
    expect(
      hits.length,
      'No migration defines assert_pos_caller_branch_access — Stage B3 not shipped',
    ).toBeGreaterThan(0);
  });

  // Stage B3-complete — money-handling surface also covered.
  it('zzz_assert_pos_branch_caller_access trigger is attached to pos_transactions and friends', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      "rg -n \"'pos_transactions'|'pos_transaction_items'|'pos_transaction_payments'|'pos_drawer_events'|'pos_cash_movements'|'pos_manager_overrides'\" supabase/migrations/ || true",
      { encoding: 'utf8' },
    );
    for (const tbl of [
      'pos_transactions',
      'pos_transaction_items',
      'pos_transaction_payments',
      'pos_drawer_events',
      'pos_cash_movements',
      'pos_manager_overrides',
    ]) {
      expect(out, `${tbl} must be wired to the Stage B trigger`).toContain(`'${tbl}'`);
    }
  });

  // Stage B4 — overseer gating wired into the three list hooks.
  it('register/shift/cashier hooks gate company-wide fallback behind usePOSOverseer', () => {
    const files = [
      'src/hooks/pos/usePOSRegisters.ts',
      'src/hooks/pos/usePOSShifts.ts',
      'src/hooks/pos/usePOSCashiers.ts',
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, `${f} must import usePOSOverseer`).toMatch(/usePOSOverseer/);
      expect(src, `${f} must short-circuit non-overseers in no-branch state`).toMatch(/!currentBranch\?\.id\s*&&\s*!canOversee/);
    }
  });

  // Stage B4 — POS dashboard surfaces the overseer banner and disables Open Terminal.
  it('POS dashboard shows HQ oversight banner and disables Open Terminal in overseer mode', () => {
    const src = read('src/pages/pos/POS.tsx');
    expect(src).toMatch(/usePOSOverseer/);
    expect(src).toMatch(/isOverseeing/);
    expect(src).toMatch(/HQ oversight mode/);
    expect(src).toMatch(/disabled=\{isOverseeing\}/);
  });

  // Stage B7 — SQL self-test exists for the trigger surface.
  it('SQL self-test file exists for branch isolation', () => {
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    expect(
      existsSync(resolve(process.cwd(), 'supabase/tests/pos_branch_isolation_test.sql')),
      'supabase/tests/pos_branch_isolation_test.sql is required to assert the Stage B trigger surface',
    ).toBe(true);
  });

  // Stage R1 — extended trigger surface (held tx, table sessions, cashier-registers, floors)
  // and scope-guard surface (gift cards, discounts).
  it('Stage R1: extended branch/scope triggers cover the missed surfaces', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      "rg -n \"'pos_held_transactions'|'pos_table_sessions'|'pos_cashier_registers'|'pos_floors'|'pos_gift_cards'|'pos_discounts'\" supabase/migrations/ || true",
      { encoding: 'utf8' },
    );
    for (const tbl of [
      'pos_held_transactions',
      'pos_table_sessions',
      'pos_cashier_registers',
      'pos_floors',
      'pos_gift_cards',
      'pos_discounts',
    ]) {
      expect(out, `${tbl} must be wired to a Stage R1 caller-authority trigger`).toContain(`'${tbl}'`);
    }
    // Scope-guard function for company-shared rows must exist.
    const migHits = execSync(
      "rg -l 'tg_assert_pos_scope_caller_access' supabase/migrations/ || true",
      { encoding: 'utf8' },
    ).trim();
    expect(migHits.length, 'tg_assert_pos_scope_caller_access must be defined in a migration').toBeGreaterThan(0);
  });

  // Stage R3 — useFloorPlan now consults currentBranch and stamps branch_id.
  it('useFloorPlan scopes by branch and stamps branch_id on insert', () => {
    const src = read('src/hooks/pos/useFloorPlan.ts');
    expect(src, 'useFloorPlan must consult currentBranch').toMatch(/currentBranch/);
    expect(src, 'useFloorPlan must short-circuit non-overseers without branch').toMatch(/!branchId\s*&&\s*!canOversee/);
    expect(src, 'floors query must filter by branch_id').toMatch(/eq\("branch_id", branchId\)/);
    expect(src, 'floors insert must stamp branch_id').toMatch(/branch_id: branchId,/);
  });

  // Wave-A R-followup: the new branch-aware hooks (held tx, table sessions,
  // user current shift) must include the branch in their queryKey AND issue
  // `.eq("branch_id", …)` so the React Query cache cannot serve foreign-branch
  // rows on a branch switch.
  it('Wave-A: held transactions, table sessions, user shift filter and key by branch', () => {
    const files = [
      'src/hooks/pos/usePOSHeldTransactions.ts',
      'src/hooks/pos/useTableSessions.ts',
      'src/hooks/pos/usePOSShifts.ts',
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, `${f} must include branch in a queryKey`).toMatch(/queryKey:\s*\[[^\]]*(currentBranch\?\.id|branchId)/);
      expect(src, `${f} must filter by branch_id`).toMatch(/\.eq\(["']branch_id["']/);
    }
  });

  // Wave-A: BranchContext.switchBranch must flush every branch-scoped POS
  // cache prefix. Regression guard against the original R10 bug (the old
  // ["pos"] umbrella key never matched real composite keys).
  it('Wave-A: BranchContext invalidation covers every documented POS prefix', () => {
    const src = read('src/contexts/BranchContext.tsx');
    const required = [
      'pos-registers', 'pos-shifts', 'pos-current-shift', 'pos-user-current-shift',
      'pos-orphaned-shifts', 'pos-cashiers', 'pos-active-session', 'pos-table-sessions',
      'pos-held-transactions', 'pos-kitchen-orders', 'pos-waitlist', 'pos-dashboard-stats',
      'pos-transactions', 'pos-split-bill', 'pos-daily-sales', 'pos-z-report',
      'pos-cashier-performance', 'pos-fraud-indicators', 'floor-plan', 'terminal-session',
      'pos-register-branch-guard',
    ];
    for (const p of required) {
      expect(src, `BranchContext.switchBranch must invalidate "${p}"`).toContain(`"${p}"`);
    }
  });

  // Wave-A: RescueSessionAlert is the only UI path that can force-close a
  // shift. It MUST be gated by overseer authority and render a scope badge
  // — otherwise a branch operator can see and mis-rescue foreign-branch shifts.
  it('Wave-A: RescueSessionAlert is overseer-gated and shows scope ownership', () => {
    const src = read('src/components/pos/RescueSessionAlert.tsx');
    expect(src, 'RescueSessionAlert must import usePOSOverseer').toMatch(/usePOSOverseer/);
    expect(src, 'orphaned-shift query must be enabled only for overseers').toMatch(/enabled:\s*!!currentOrg\?\.id\s*&&\s*canOversee/);
    expect(src, 'RescueSessionAlert must render the ScopeOwnershipBadge').toMatch(/ScopeOwnershipBadge/);
  });

  // Wave-A: reporting fan-outs must not run for non-overseers without a branch.
  it('Wave-A: pos reports gate fan-out behind branch context or overseer authority', () => {
    const r = read('src/hooks/pos/usePOSReports.ts');
    expect(r).toMatch(/usePOSOverseer/);
    expect(r).toMatch(/reportsEnabled/);
    const e = read('src/hooks/pos/usePOSEnhancedReports.ts');
    expect(e).toMatch(/usePOSOverseer/);
    expect(e).toMatch(/enhancedReportsEnabled/);
  });

  // Wave-A re-audit: the architecture branch-stamping test surfaced two
  // real pos_transactions inserts that were stamping org + business but
  // NOT branch_id. Re-introducing either would silently NULL-stamp every
  // dine-in draft / offline sale and break branch reports + GL posting.
  it('Wave-A re-audit: useTableOrder draft insert carries branch_id from the register', () => {
    const src = read('src/hooks/pos/useTableOrder.ts');
    // Register lookup must fetch branch_id, not just register_code.
    expect(src).toMatch(/select\(\s*["']register_code,\s*branch_id["']\s*\)/);
    // Draft transaction insert must stamp the resolved branch_id.
    expect(src).toMatch(/branch_id:\s*registerBranchId/);
    // Must refuse to create a draft when the register has no branch.
    expect(src).toMatch(/Register is missing a branch assignment/);
  });

  it('Wave-A re-audit: SQLiteSyncManager upload stamps branch_id and refuses NULL', () => {
    const src = read('src/services/offline/SQLiteSyncManager.ts');
    // Uploaded transaction insert must include branch_id from the scope.
    expect(src).toMatch(/branch_id:\s*this\.branchId/);
    // Queued rows without a known branch must be quarantined, not stamped NULL.
    expect(src).toMatch(/Cannot upload: offline transaction has no branch context/);
  });
});
