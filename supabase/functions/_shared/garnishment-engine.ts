/**
 * Legal Order (a.k.a. Garnishment) computation engine — Deno shared module.
 *
 * Byte-identical math to src/lib/payroll/garnishment-engine.ts (the client
 * module is a thin re-export shim). Keep this file as the single source of
 * truth; the architecture test enforces the re-export shape.
 *
 * Phase 4 additions (backward-compatible):
 *   - honours pack-published `calc_model` when the order's cap_rule is null
 *   - honours `aggregate_cap_membership` (in_pool | exempt | always_first),
 *     which supersedes the legacy always_first / counts_toward_aggregate_cap
 *     booleans when present
 *   - reserves always_first orders' full requested amount before other orders
 *     compete for the aggregate cap pool
 *   - honours `protected_earnings_rule` jsonb of shape
 *     { min_pct_of_gross?: number, min_amount?: number } — merged into the
 *     org- and per-order floors
 *   - honours `priority_class` (statutory rank ceiling): orders are sorted by
 *     (always_first desc, priority_class asc, priority asc)
 *
 * When new fields are absent, behaviour is identical to the pre-Phase-4 run.
 */

export type GarnishmentCapRule =
  | "fixed_amount"
  | "percent_disposable"
  | "lesser_of_fixed_or_pct";

export type LegalOrderCalcModel =
  | "fixed"
  | "percent_disposable"
  | "percent_gross"
  | "balance_remaining"
  | "statutory_formula";

export type LegalOrderCapMembership = "in_pool" | "exempt" | "always_first";

export interface GarnishmentOrder {
  id: string;
  kind: string;
  cap_rule: GarnishmentCapRule | null;
  fixed_amount?: number | null;
  percent_of_disposable?: number | null;
  total_owed?: number | null;
  total_paid?: number | null;
  minimum_take_home_amount?: number | null;
  aggregate_cap_exempt?: boolean;
  case_reference?: string | null;
  priority?: number | null;
}

export interface GarnishmentPolicy {
  aggregate_cap_pct: number | null;
  min_take_home_amount: number | null;
  min_take_home_pct: number | null;
}

/**
 * Pack-published legal contract for a kind. Every Phase-2/4 field is
 * optional — legacy rows without a resolved pack keep working.
 */
export interface KindDefault {
  counts_toward_aggregate_cap: boolean;
  always_first?: boolean;
  default_priority?: number;
  employer_fee_amount?: number | null;
  employer_fee_account_role?: string | null;

  // Phase 2 contract fields (nullable — packs may not publish them yet).
  calc_model?: LegalOrderCalcModel | null;
  priority_class?: number | null;
  aggregate_cap_membership?: LegalOrderCapMembership | null;
  protected_earnings_rule?: {
    min_pct_of_gross?: number | null;
    min_amount?: number | null;
  } | null;
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

function resolveMembership(g: GarnishmentOrder, kd: KindDefault | undefined): LegalOrderCapMembership {
  if (g.aggregate_cap_exempt) return "exempt";
  if (kd?.aggregate_cap_membership) return kd.aggregate_cap_membership;
  if (kd?.always_first) return "always_first";
  if (kd && kd.counts_toward_aggregate_cap === false) return "exempt";
  return "in_pool";
}

function resolveRawAmount(
  g: GarnishmentOrder,
  kd: KindDefault | undefined,
  gross: number,
  disposable: number,
): number {
  // Prefer the order-level cap_rule when set (existing behaviour).
  if (g.cap_rule === "fixed_amount") return Number(g.fixed_amount) || 0;
  if (g.cap_rule === "percent_disposable") return disposable * (Number(g.percent_of_disposable) || 0);
  if (g.cap_rule === "lesser_of_fixed_or_pct") {
    return Math.min(
      Number(g.fixed_amount) || 0,
      disposable * (Number(g.percent_of_disposable) || 0),
    );
  }
  // Phase-4: fall back to the pack-published calc_model when cap_rule is null.
  const model = kd?.calc_model;
  if (model === "fixed") return Number(g.fixed_amount) || 0;
  if (model === "percent_disposable") return disposable * (Number(g.percent_of_disposable) || 0);
  if (model === "percent_gross") return gross * (Number(g.percent_of_disposable) || 0);
  if (model === "balance_remaining") {
    return Math.max(0, Number(g.total_owed || 0) - Number(g.total_paid || 0));
  }
  // statutory_formula: reserved for pack-scripted rules; engine returns 0
  // (the pack's rule evaluator must inject the amount upstream). This keeps
  // the engine deterministic and side-effect free.
  return 0;
}

function packFloor(kd: KindDefault | undefined, gross: number): number {
  const rule = kd?.protected_earnings_rule;
  if (!rule) return 0;
  const pctFloor = rule.min_pct_of_gross != null ? gross * Number(rule.min_pct_of_gross) : 0;
  const amtFloor = rule.min_amount != null ? Number(rule.min_amount) : 0;
  return Math.max(pctFloor, amtFloor);
}

function comparePriority(
  a: { g: GarnishmentOrder; kd?: KindDefault; membership: LegalOrderCapMembership },
  b: { g: GarnishmentOrder; kd?: KindDefault; membership: LegalOrderCapMembership },
): number {
  // 1) always_first orders first (stable within the group)
  const aFirst = a.membership === "always_first" ? 0 : 1;
  const bFirst = b.membership === "always_first" ? 0 : 1;
  if (aFirst !== bFirst) return aFirst - bFirst;
  // 2) lower statutory priority_class wins
  const aClass = a.kd?.priority_class ?? Number.POSITIVE_INFINITY;
  const bClass = b.kd?.priority_class ?? Number.POSITIVE_INFINITY;
  if (aClass !== bClass) return aClass - bClass;
  // 3) explicit priority on the order (lower first)
  const aPrio = a.g.priority ?? a.kd?.default_priority ?? Number.POSITIVE_INFINITY;
  const bPrio = b.g.priority ?? b.kd?.default_priority ?? Number.POSITIVE_INFINITY;
  return aPrio - bPrio;
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

  // Resolve membership + kind default once, then sort deterministically so
  // always_first orders + lower priority_class consume the pool first.
  const enriched = orders.map((g) => {
    const kd = kindDefaults[g.kind];
    return { g, kd, membership: resolveMembership(g, kd) };
  });
  enriched.sort(comparePriority);

  const applied: GarnishmentApplied[] = [];

  for (const { g, kd, membership } of enriched) {
    if (disposableRemaining <= 0) break;
    const countsTowardCap = membership === "in_pool";
    if (countsTowardCap && cappedPoolRemaining <= 0) continue;

    let raw = resolveRawAmount(g, kd, gross, disposable);

    if (g.total_owed != null) {
      raw = Math.min(raw, Math.max(0, Number(g.total_owed) - Number(g.total_paid || 0)));
    }

    const perOrderFloor = Number(g.minimum_take_home_amount || 0);
    const kindFloor = packFloor(kd, gross);
    const projectedNet =
      gross - preGarnishmentDeductions - (disposable - disposableRemaining) - raw;
    const floorBreach = Math.max(orgFloor, kindFloor, perOrderFloor) - projectedNet;
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
    cappedPoolRemaining:
      cappedPoolRemaining === Number.POSITIVE_INFINITY ? Infinity : cappedPoolRemaining,
    totalGarnished: applied.reduce((s, a) => s + a.amount, 0),
  };
}
