/**
 * Pure garnishment computation engine (browser mirror).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 2 — This file mirrors `supabase/functions/_shared/garnishment-engine.ts`
 * byte-for-byte on the shared subset of the algorithm. The Deno edge
 * function cannot import from `src/`, so the code is duplicated and
 * kept in sync manually. Any edit here MUST be applied to the shared
 * mirror in the same commit (an architecture test asserts equality).
 *
 * The FULL production algorithm — including per-period carry-forward
 * (`pendingCfByGarn`, `cfInserts`), `total_accrued` cap and employer
 * admin-fee bookkeeping — lives inline in
 * `supabase/functions/compute-payroll/index.ts` (Turn C: garnishments,
 * ~line 2546). Those pieces are DB-integrated and cannot be reduced to
 * a pure function without threading a large amount of run-level state.
 * Consolidation into a single canonical `garnishmentEngine.ts` module is
 * tracked as Phase 2 follow-up (see `.lovable/plan.md`).
 *
 * Algorithm (shared subset):
 *   1. disposable = max(0, gross − preGarnishmentDeductions)
 *   2. aggregateCapPool = disposable × org.aggregate_cap_pct  (∞ if null)
 *      — only orders flagged counts_toward_aggregate_cap consume from this pool.
 *   3. floor = max(org.min_take_home_amount, gross × org.min_take_home_pct,
 *                  perOrder.min_take_home_amount)
 *   4. For each order in priority order:
 *        raw = cap_rule formula
 *        clamp to remaining owed
 *        clamp to floor headroom
 *        clamp to disposableRemaining
 *        clamp to cappedPoolRemaining (only if counts toward cap)
 *      Record employer admin fee (kindDefault.employer_fee_amount) on
 *      the applied row; caller books it as an employer_contribution.
 */

export type GarnishmentCapRule = "fixed_amount" | "percent_disposable" | "lesser_of_fixed_or_pct";

export interface GarnishmentOrder {
  id: string;
  kind: string;
  cap_rule: GarnishmentCapRule;
  fixed_amount?: number | null;
  percent_of_disposable?: number | null;
  total_owed?: number | null;
  total_paid?: number | null;
  minimum_take_home_amount?: number | null;
  aggregate_cap_exempt?: boolean;
  case_reference?: string | null;
}

export interface GarnishmentPolicy {
  aggregate_cap_pct: number | null;
  min_take_home_amount: number | null;
  min_take_home_pct: number | null;
}

export interface KindDefault {
  counts_toward_aggregate_cap: boolean;
  always_first?: boolean;
  default_priority?: number;
  employer_fee_amount?: number | null;
  employer_fee_account_role?: string | null;
}

export interface GarnishmentApplied {
  id: string;
  code: string;
  label: string;
  amount: number;
  employer_fee_amount: number;
  employer_fee_account_role: string | null;
}

export interface ComputeArgs {
  gross: number;
  preGarnishmentDeductions: number;
  orders: GarnishmentOrder[];
  policy: GarnishmentPolicy;
  kindDefaults: Record<string, KindDefault>;
}

export interface ComputeResult {
  applied: GarnishmentApplied[];
  disposable: number;
  disposableRemaining: number;
  cappedPoolRemaining: number;
  totalGarnished: number;
}

export function computeGarnishments(args: ComputeArgs): ComputeResult {
  const { gross, preGarnishmentDeductions, orders, policy, kindDefaults } = args;
  const disposable = Math.max(0, gross - preGarnishmentDeductions);
  let disposableRemaining = disposable;
  const aggregateCapPool =
    policy.aggregate_cap_pct != null
      ? Math.max(0, disposable * policy.aggregate_cap_pct)
      : Number.POSITIVE_INFINITY;
  let cappedPoolRemaining = aggregateCapPool;
  const orgFloor = Math.max(
    policy.min_take_home_amount ?? 0,
    policy.min_take_home_pct != null ? gross * policy.min_take_home_pct : 0,
  );

  const applied: GarnishmentApplied[] = [];

  for (const g of orders) {
    if (disposableRemaining <= 0) break;
    const kd = kindDefaults[g.kind];
    const countsTowardCap = !g.aggregate_cap_exempt && (kd?.counts_toward_aggregate_cap ?? true);
    if (countsTowardCap && cappedPoolRemaining <= 0) continue;

    let raw = 0;
    if (g.cap_rule === "fixed_amount") raw = Number(g.fixed_amount) || 0;
    else if (g.cap_rule === "percent_disposable")
      raw = disposable * (Number(g.percent_of_disposable) || 0);
    else if (g.cap_rule === "lesser_of_fixed_or_pct") {
      raw = Math.min(
        Number(g.fixed_amount) || 0,
        disposable * (Number(g.percent_of_disposable) || 0),
      );
    }

    if (g.total_owed != null) {
      raw = Math.min(raw, Math.max(0, Number(g.total_owed) - Number(g.total_paid || 0)));
    }

    const perOrderFloor = Number(g.minimum_take_home_amount || 0);
    const projectedNet =
      gross - preGarnishmentDeductions - (disposable - disposableRemaining) - raw;
    const floorBreach = Math.max(orgFloor, perOrderFloor) - projectedNet;
    if (floorBreach > 0) raw = Math.max(0, raw - floorBreach);

    let capped = Math.min(raw, disposableRemaining);
    if (countsTowardCap) capped = Math.min(capped, cappedPoolRemaining);

    const amt = Math.round(capped * 100) / 100;
    if (amt <= 0) continue;

    const key = `garnishment_${g.id}`;
    disposableRemaining -= amt;
    if (countsTowardCap) cappedPoolRemaining -= amt;

    const feeRaw = Number(kd?.employer_fee_amount || 0);
    const employerFee = feeRaw > 0 ? Math.round(feeRaw * 100) / 100 : 0;

    applied.push({
      id: g.id,
      code: key,
      label: `${g.kind}${g.case_reference ? ` (${g.case_reference})` : ""}`,
      amount: amt,
      employer_fee_amount: employerFee,
      employer_fee_account_role: kd?.employer_fee_account_role ?? null,
    });
  }

  return {
    applied,
    disposable,
    disposableRemaining,
    cappedPoolRemaining: cappedPoolRemaining === Number.POSITIVE_INFINITY ? Infinity : cappedPoolRemaining,
    totalGarnished: applied.reduce((s, a) => s + a.amount, 0),
  };
}
