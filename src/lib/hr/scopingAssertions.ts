/**
 * HR scoping assertions (mirrors src/lib/purchases/scopingAssertions.ts).
 *
 * Dev-only run-time guards that warn when an HR query is missing the
 * organization_id / business_id / branch filter that the backend expects.
 *
 * These are NOT a security boundary — RLS + permission groups remain the
 * authoritative enforcement. They exist to catch developer mistakes
 * (cross-tenant or cross-branch contamination) loudly during development.
 *
 * Usage from a hook:
 *
 *   import { assertHrScope } from "@/lib/hr/scopingAssertions";
 *
 *   assertHrScope({
 *     hook: "useEmployees",
 *     orgId: currentOrg?.id,
 *     businessId: currentBusiness?.id,
 *     branchId: branchScope?.branch_id,
 *     branchRequired: false,
 *   });
 *
 * In production builds the helpers are no-ops.
 */

const isDev =
  typeof import.meta !== "undefined" &&
  (import.meta as any).env?.DEV === true;

interface AssertHrScopeArgs {
  /** Caller name for the warning prefix. */
  hook: string;
  orgId: string | null | undefined;
  businessId?: string | null | undefined;
  branchId?: string | null | undefined;
  /** True when the calling user is restricted to a branch (e.g. branch manager). */
  branchRequired?: boolean;
  /** True when the call should also have a business_id. */
  businessRequired?: boolean;
}

const warned = new Set<string>();

function warnOnce(key: string, msg: string) {
  if (warned.has(key)) return;
  warned.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[hr-scope] ${msg}`);
}

export function assertHrScope(args: AssertHrScopeArgs): void {
  if (!isDev) return;
  const { hook, orgId, businessId, branchId, branchRequired, businessRequired } = args;

  if (!orgId) {
    warnOnce(
      `${hook}:no-org`,
      `${hook} ran without an organization_id. HR data must be scoped to currentOrg.`,
    );
  }
  if (businessRequired && !businessId) {
    warnOnce(
      `${hook}:no-business`,
      `${hook} expected a business_id but none was provided. Multi-business orgs will leak data across books.`,
    );
  }
  if (branchRequired && !branchId) {
    warnOnce(
      `${hook}:no-branch`,
      `${hook} ran for a branch-restricted user without a branch_id filter. Branch managers must only see their branch.`,
    );
  }
}

/**
 * Assert that a row read from the DB matches the expected scope.
 * Catches RLS misconfigurations / view leaks during development.
 */
export function assertRowInScope(
  hook: string,
  row: { organization_id?: string | null; business_id?: string | null; branch_id?: string | null },
  expected: { orgId?: string | null; businessId?: string | null; branchId?: string | null },
): void {
  if (!isDev) return;
  if (expected.orgId && row.organization_id && row.organization_id !== expected.orgId) {
    warnOnce(
      `${hook}:row-cross-org`,
      `${hook} returned a row from organization ${row.organization_id} while expecting ${expected.orgId}. Possible RLS leak.`,
    );
  }
  if (expected.businessId && row.business_id && row.business_id !== expected.businessId) {
    warnOnce(
      `${hook}:row-cross-business`,
      `${hook} returned a row from business ${row.business_id} while expecting ${expected.businessId}.`,
    );
  }
  if (expected.branchId && row.branch_id && row.branch_id !== expected.branchId) {
    warnOnce(
      `${hook}:row-cross-branch`,
      `${hook} returned a row from branch ${row.branch_id} while expecting ${expected.branchId}.`,
    );
  }
}
