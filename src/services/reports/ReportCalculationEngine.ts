/**
 * Report Calculation Engine — CLIENT-side hierarchical builder.
 *
 * Scope: pure functions that take already-fetched account rows and produce
 * tree structures, period comparisons, and validation results. NO data
 * fetching here — that lives in `useFinancialReport`, `useGeneralLedger`,
 * etc. (which talk to RPCs).
 *
 * Phase 3 of the reporting convergence roadmap removed the duplicated
 * accounting math: `isDebitNormal`, `calculateBalance`, the account-type
 * ordering and labels now come from the shared kernel at
 * `supabase/functions/_shared/reports/accountingKernel.ts`, which the
 * server engine (`_shared/reportDataEngine.ts`) binds to as well. This file
 * keeps only what is genuinely client-shaped: hierarchy building for React
 * rendering, variance calculation and balance-sheet validation.
 *
 * Parity is enforced by
 * `src/test/architecture/accounting-kernel-parity.test.ts` (one kernel, no
 * re-declared primitives, detail-type tables pinned together) and by the
 * server snapshot test
 * `supabase/functions/_shared/__tests__/reportPdfGenerator.snapshot.test.ts`.
 */

export {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPE_ORDER,
  calculateBalance,
  isDebitNormal,
} from "../../../supabase/functions/_shared/reports/accountingKernel";


export interface AccountNode {
  id: string;
  code: string;
  name: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  parent_id: string | null;
  opening_balance: number;
  debit_total: number;
  credit_total: number;
  closing_balance: number;
  children: AccountNode[];
  depth: number;
  is_group: boolean;
}

export interface HierarchicalAccount extends AccountNode {
  /** Flattened list including self and all descendants for rendering */
  flatChildren: AccountNode[];
}

export interface PeriodData {
  label: string;
  dateFrom: string;
  dateTo: string;
  accounts: Map<string, { debit: number; credit: number; balance: number }>;
}

export interface PeriodComparison {
  current: number;
  previous: number;
  variance: number;
  variancePercent: number | null;
}

/**
 * Builds an account hierarchy tree from flat account list
 */
export function buildAccountHierarchy(
  accounts: Array<{
    id: string;
    code: string;
    name: string;
    account_type: "asset" | "liability" | "equity" | "income" | "expense";
    parent_id: string | null;
    opening_balance: number;
    debit_total: number;
    credit_total: number;
    closing_balance: number;
  }>
): HierarchicalAccount[] {
  const accountMap = new Map<string, AccountNode>();
  const rootAccounts: AccountNode[] = [];

  // Create nodes
  for (const acct of accounts) {
    accountMap.set(acct.id, {
      ...acct,
      children: [],
      depth: 0,
      is_group: false,
    });
  }

  // Build tree
  for (const acct of accounts) {
    const node = accountMap.get(acct.id)!;
    if (acct.parent_id && accountMap.has(acct.parent_id)) {
      const parent = accountMap.get(acct.parent_id)!;
      parent.children.push(node);
      parent.is_group = true;
    } else {
      rootAccounts.push(node);
    }
  }

  // Set depths and aggregate group totals
  function setDepth(node: AccountNode, depth: number) {
    node.depth = depth;
    for (const child of node.children) {
      setDepth(child, depth + 1);
    }
    // Roll children UP INTO the parent, on top of the parent's own postings.
    // A parent account can itself be posted to; replacing its figures with the
    // children's sum (as this used to) silently dropped those postings from
    // every total that reads the tree.
    if (node.is_group && node.children.length > 0) {
      node.opening_balance += node.children.reduce((s, c) => s + c.opening_balance, 0);
      node.debit_total += node.children.reduce((s, c) => s + c.debit_total, 0);
      node.credit_total += node.children.reduce((s, c) => s + c.credit_total, 0);
      node.closing_balance += node.children.reduce((s, c) => s + c.closing_balance, 0);
    }

  }

  // Flatten for rendering
  function flatten(node: AccountNode): AccountNode[] {
    const result: AccountNode[] = [node];
    for (const child of node.children.sort((a, b) => a.code.localeCompare(b.code))) {
      result.push(...flatten(child));
    }
    return result;
  }

  const hierarchical: HierarchicalAccount[] = [];
  for (const root of rootAccounts.sort((a, b) => a.code.localeCompare(b.code))) {
    setDepth(root, 0);
    hierarchical.push({
      ...root,
      flatChildren: flatten(root),
    });
  }

  return hierarchical;
}

/**
 * Groups accounts by account type for financial statement presentation
 */
export function groupByAccountType(
  accounts: AccountNode[]
): Record<string, AccountNode[]> {
  const groups: Record<string, AccountNode[]> = {
    asset: [],
    liability: [],
    equity: [],
    income: [],
    expense: [],
  };

  for (const account of accounts) {
    if (groups[account.account_type]) {
      groups[account.account_type].push(account);
    }
  }

  return groups;
}

/**
 * Calculates period-over-period comparison
 */
export function calculateVariance(current: number, previous: number): PeriodComparison {
  const variance = current - previous;
  const variancePercent = previous !== 0
    ? (variance / Math.abs(previous)) * 100
    : null;

  return { current, previous, variance, variancePercent };
}

/**
 * Balance Sheet section ordering
 */
export const BALANCE_SHEET_SECTIONS = {
  assets: ["asset"],
  liabilities: ["liability"],
  equity: ["equity"],
} as const;

/**
 * P&L section ordering
 */
export const PNL_SECTIONS = {
  income: ["income"],
  expenses: ["expense"],
} as const;

/**
 * VALIDATION: Detects critical balance sheet issues
 * 
 * This function validates that:
 * 1. Owner's equity accounts have non-zero closing balances (not ignored from reports)
 * 2. Assets = Liabilities + Equity (accounting equation holds)
 * 3. Opening balances are properly included
 * 
 * Triggered when:
 * - Owner's equity accounts exist with opening_balance but show as 0 in reports
 * - This indicates the opening_balance field is being ignored
 */
export interface BalanceSheetValidation {
  isValid: boolean;
  equityAccounts: string[]; // Equity accounts with non-zero opening_balance but zero closing_balance
  accountingEquationError: number; // A - L - E should be ~0
  warnings: string[];
}

export function validateBalanceSheet(
  accounts: Array<{ id: string; code: string; name: string; account_type: string; closing_balance: number; opening_balance?: number; is_group?: boolean; debit_total?: number; credit_total?: number }>,
  sectionTotals: Record<string, number>,
  balanceSheetTotals?: { totalAssets: number; totalLiabilities: number; totalEquity: number; retainedEarnings: number }
): BalanceSheetValidation {
  const warnings: string[] = [];
  const equityAccounts: string[] = [];

  // Check if equity accounts with non-zero opening balances show zero closing
  const equityAccts = accounts.filter(a => a.account_type === "equity" && !a.is_group);
  for (const acct of equityAccts) {
    if (acct.opening_balance !== 0 && acct.closing_balance === 0 && acct.debit_total === 0 && acct.credit_total === 0) {
      equityAccounts.push(`${acct.code} ${acct.name} (opening: ${acct.opening_balance}, closing: 0)`);
      warnings.push(
        `CRITICAL: Equity account "${acct.name}" has opening_balance of ${acct.opening_balance} ` +
        `but closing_balance of 0. This indicates opening_balance field is being ignored in calculations.`
      );
    }
  }

  let accountingEquationError = 0;
  if (balanceSheetTotals) {
    accountingEquationError = balanceSheetTotals.totalAssets - 
                              balanceSheetTotals.totalLiabilities - 
                              balanceSheetTotals.totalEquity;
    
    // More than 0.01 difference is an error
    if (Math.abs(accountingEquationError) > 0.01) {
      warnings.push(
        `Balance sheet equation error: Assets (${balanceSheetTotals.totalAssets}) ≠ ` +
        `Liabilities (${balanceSheetTotals.totalLiabilities}) + Equity (${balanceSheetTotals.totalEquity}). ` +
        `Difference: ${accountingEquationError}`
      );
    }
  }

  return {
    isValid: equityAccounts.length === 0 && Math.abs(accountingEquationError) < 0.01,
    equityAccounts,
    accountingEquationError,
    warnings,
  };
}
