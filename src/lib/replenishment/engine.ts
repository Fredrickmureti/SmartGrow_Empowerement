/**
 * Replenishment planning engine — pure, deterministic, testable.
 *
 * This module is the reference specification of the replenishment
 * calculation. The authoritative execution path is the Postgres
 * function `run_replenishment_planning`, which runs under RLS and
 * writes `procurement_recommendations` in the same transaction. The
 * SQL implementation MUST stay bit-for-bit equivalent to this module
 * — every change to the algorithm belongs in both places.
 *
 * The engine deliberately emits RECOMMENDATIONS, not purchase orders.
 * Purchase-order creation is the Purchases module's responsibility so
 * segregation of duties (planner ≠ approver ≠ receiver) is preserved.
 * See docs/audit/inventory-verdict.md and ADR-0016 for the boundary.
 */

export type Urgency = "stockout" | "critical" | "low" | "planned";
export type SourceKind = "buy" | "transfer" | "manufacture";

export interface EngineRuleInput {
  productId: string;
  branchId: string | null;
  safetyStock: number;
  leadTimeDays: number;
  moq: number;
  packSize: number;
  preferredVendorId: string | null;
  reorderPoint: number;
  onHand: number;
  reserved: number;
  incoming: number;
  /** Trailing 28-day outbound quantity per WEEK. */
  velocityPerWeek: number;
}

export interface EngineRecommendation {
  productId: string;
  branchId: string | null;
  onHand: number;
  reserved: number;
  available: number;
  incoming: number;
  velocityPerWeek: number;
  safetyStock: number;
  leadTimeDays: number;
  forecastLeadDemand: number;
  netRequirement: number;
  suggestedQty: number;
  urgency: Urgency;
  suggestedSource: SourceKind;
  preferredVendorId: string | null;
  neededByOffsetDays: number;
  explanation: Record<string, number | string | null>;
}

/**
 * Round `qty` UP to the next multiple of `packSize`, then take the max
 * with `moq`. Matches SQL: GREATEST(moq, CEIL(qty / pack) * pack).
 */
export function roundToOrderQty(qty: number, moq: number, packSize: number): number {
  if (qty <= 0) return 0;
  const pack = packSize > 0 ? packSize : 1;
  const rounded = Math.ceil(qty / pack) * pack;
  return Math.max(moq || 0, rounded);
}

export function classifyUrgency(available: number, velocityPerWeek: number): Urgency {
  if (available <= 0) return "stockout";
  if (velocityPerWeek <= 0) return "planned";
  const daysOfSupply = available / (velocityPerWeek / 7);
  if (daysOfSupply < 7) return "critical";
  if (daysOfSupply < 14) return "low";
  return "planned";
}

export function computeRecommendation(input: EngineRuleInput): EngineRecommendation {
  const onHand = Math.max(0, input.onHand);
  const reserved = Math.max(0, input.reserved);
  const available = Math.max(0, onHand - reserved);
  const incoming = Math.max(0, input.incoming);
  const velocity = Math.max(0, input.velocityPerWeek);
  const safety = Math.max(0, input.safetyStock);
  const lead = Math.max(0, input.leadTimeDays);

  const forecastLeadDemand = (velocity / 7) * lead;
  const netRequirement = Math.max(0, safety + forecastLeadDemand - available - incoming);
  const suggestedQty = roundToOrderQty(netRequirement, input.moq, input.packSize);
  const urgency = classifyUrgency(available, velocity);

  return {
    productId: input.productId,
    branchId: input.branchId,
    onHand,
    reserved,
    available,
    incoming,
    velocityPerWeek: velocity,
    safetyStock: safety,
    leadTimeDays: lead,
    forecastLeadDemand,
    netRequirement,
    suggestedQty,
    urgency,
    suggestedSource: "buy",
    preferredVendorId: input.preferredVendorId,
    neededByOffsetDays: lead,
    explanation: {
      onHand,
      reserved,
      available,
      incoming,
      velocityPerWeek: velocity,
      safetyStock: safety,
      leadTimeDays: lead,
      forecastLeadDemand,
      moq: input.moq,
      packSize: input.packSize,
      reorderPoint: input.reorderPoint,
      rawNeed: netRequirement,
    },
  };
}

/**
 * Filter recommendations the same way the SQL engine does: keep rows
 * that either have a positive net requirement OR are already in a
 * stockout / critical state (so planners see them even when reorder
 * math says zero, e.g. no rule configured yet).
 */
export function shouldEmit(rec: EngineRecommendation): boolean {
  return rec.netRequirement > 0 || rec.urgency === "stockout" || rec.urgency === "critical";
}

export function planReplenishment(rules: EngineRuleInput[]): EngineRecommendation[] {
  return rules.map(computeRecommendation).filter(shouldEmit);
}