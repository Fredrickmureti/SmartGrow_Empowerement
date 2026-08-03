/**
 * Replenishment reference engine (ADR 0108) — pure, deterministic TypeScript
 * mirror of the SQL `plan_replenishment` decision engine.
 *
 * It exists so the decision logic (rule-hierarchy precedence, projected
 * pick-face position, pack rounding, FEFO source choice, open-order
 * idempotency) is unit-testable without a database, and so the SQL and the
 * UI agree on what a decision *means*. It writes nothing.
 */

export type ReplenScope = "warehouse" | "zone" | "category" | "product" | "pick_face";
export type ReplenStrategy = "min_max" | "demand_driven" | "topoff" | "manual";

export interface ReplenRule {
  id: string;
  scope: ReplenScope;
  strategy: ReplenStrategy;
  warehouseId: string;
  zoneLocationId?: string | null;
  categoryId?: string | null;
  productId?: string | null;
  pickLocationId?: string | null;
  minQty: number;
  maxQty: number;
  targetQty?: number | null;
  packMultiple: number;
  priority: number;
  isActive: boolean;
  isEmergency?: boolean;
  autoDispatch?: boolean;
  velocityClass?: string | null;
  effectiveFrom?: string | Date | null;
  effectiveTo?: string | Date | null;
}

export interface PickFaceContext {
  warehouseId: string;
  pickLocationId: string;
  productId: string;
  categoryId?: string | null;
  zoneLocationId?: string | null;
  velocityClass?: string | null;
  /** Physical on-hand at the pick face. */
  onHand: number;
  /** Units already allocated to open waves / picks. */
  allocated?: number;
  /** Units blocked, quarantined or expired at the pick face. */
  blocked?: number;
  /** Units already on their way in from an open replenishment. */
  inbound?: number;
  /** True when an open replen order already covers this pick face. */
  hasOpenOrder?: boolean;
}

export interface SourceCandidate {
  locationId: string;
  locationCode?: string;
  available: number;
  lotNumber?: string | null;
  /** ISO date or Date; earliest expiry wins (FEFO). */
  expiryDate?: string | Date | null;
  blocked?: boolean;
  lpnId?: string | null;
}

export interface SourceChoice {
  chosen: SourceCandidate | null;
  rejected: Array<{ locationId: string; lotNumber?: string | null; reason: string }>;
}

export interface DecisionTrace {
  ruleId: string | null;
  ruleScope: ReplenScope | null;
  strategy: ReplenStrategy | null;
  reasonCode: string;
  projected: number;
  minQty: number | null;
  targetQty: number | null;
  rawQty: number;
  requestedQty: number;
  packMultiple: number | null;
  sourceLocationId: string | null;
  lotNumber: string | null;
  rejectedSources: SourceChoice["rejected"];
}

export interface ReplenPlanItem {
  pickLocationId: string;
  productId: string;
  ruleId: string | null;
  requestedQty: number;
  sourceLocationId: string | null;
  lotNumber: string | null;
  priority: number;
  autoDispatch: boolean;
  trace: DecisionTrace;
}

export type PlanOutcome =
  | { kind: "planned"; item: ReplenPlanItem }
  | { kind: "skipped"; reasonCode: string; trace: DecisionTrace };

const SCOPE_RANK: Record<ReplenScope, number> = {
  pick_face: 5,
  product: 4,
  category: 3,
  zone: 2,
  warehouse: 1,
};

function toTime(v: string | Date | null | undefined): number | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function ruleMatches(rule: ReplenRule, ctx: PickFaceContext, at: Date): boolean {
  if (!rule.isActive) return false;
  if (rule.warehouseId !== ctx.warehouseId) return false;

  const now = at.getTime();
  const from = toTime(rule.effectiveFrom);
  const to = toTime(rule.effectiveTo);
  if (from != null && now < from) return false;
  if (to != null && now > to) return false;

  if (rule.velocityClass && rule.velocityClass !== ctx.velocityClass) return false;

  switch (rule.scope) {
    case "pick_face":
      return rule.pickLocationId === ctx.pickLocationId &&
        (!rule.productId || rule.productId === ctx.productId);
    case "product":
      return rule.productId === ctx.productId;
    case "category":
      return !!ctx.categoryId && rule.categoryId === ctx.categoryId;
    case "zone":
      return !!ctx.zoneLocationId && rule.zoneLocationId === ctx.zoneLocationId;
    case "warehouse":
      return true;
    default:
      return false;
  }
}

/**
 * Effective rule = most specific match, emergency rules first, then lowest
 * `priority` number, then newest by id as a stable tie-break.
 */
export function resolveEffectiveRule(
  rules: ReplenRule[],
  ctx: PickFaceContext,
  at: Date = new Date(),
): ReplenRule | null {
  const matches = rules.filter((r) => ruleMatches(r, ctx, at));
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => {
    if (!!b.isEmergency !== !!a.isEmergency) return b.isEmergency ? 1 : -1;
    const rank = SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope];
    if (rank !== 0) return rank;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/** Projected pick-face position: on-hand less committed/blocked, plus in-flight refill. */
export function projectPickFace(ctx: PickFaceContext): number {
  return (
    Math.max(0, ctx.onHand) -
    Math.max(0, ctx.allocated ?? 0) -
    Math.max(0, ctx.blocked ?? 0) +
    Math.max(0, ctx.inbound ?? 0)
  );
}

/** Round up to the rule's pack multiple. */
export function roundToPack(qty: number, packMultiple: number): number {
  const pack = packMultiple > 0 ? packMultiple : 1;
  if (qty <= 0) return 0;
  return Math.ceil(qty / pack) * pack;
}

/** FEFO source choice: earliest expiry first, then largest available. */
export function chooseSource(candidates: SourceCandidate[], requiredQty: number): SourceChoice {
  const rejected: SourceChoice["rejected"] = [];
  const eligible: SourceCandidate[] = [];

  for (const c of candidates) {
    if (c.blocked) {
      rejected.push({ locationId: c.locationId, lotNumber: c.lotNumber, reason: "blocked" });
    } else if (c.available <= 0) {
      rejected.push({ locationId: c.locationId, lotNumber: c.lotNumber, reason: "no_stock" });
    } else {
      eligible.push(c);
    }
  }

  const ranked = [...eligible].sort((a, b) => {
    const ax = toTime(a.expiryDate);
    const bx = toTime(b.expiryDate);
    if (ax != null && bx != null && ax !== bx) return ax - bx;
    if (ax != null && bx == null) return -1;
    if (ax == null && bx != null) return 1;
    if (a.available !== b.available) return b.available - a.available;
    return a.locationId < b.locationId ? -1 : 1;
  });

  const chosen = ranked[0] ?? null;
  for (const c of ranked.slice(1)) {
    rejected.push({
      locationId: c.locationId,
      lotNumber: c.lotNumber,
      reason: chosen && c.available < requiredQty ? "not_fefo_preferred" : "not_fefo_preferred",
    });
  }
  return { chosen, rejected };
}

/**
 * Plan a single pick face. Returns either a planned order or an explained skip;
 * every branch carries a decision trace so the UI can answer "why?".
 */
export function planPickFace(
  rules: ReplenRule[],
  ctx: PickFaceContext,
  candidates: SourceCandidate[] = [],
  at: Date = new Date(),
): PlanOutcome {
  const projected = projectPickFace(ctx);
  const rule = resolveEffectiveRule(rules, ctx, at);

  const baseTrace: DecisionTrace = {
    ruleId: rule?.id ?? null,
    ruleScope: rule?.scope ?? null,
    strategy: rule?.strategy ?? null,
    reasonCode: "ok",
    projected,
    minQty: rule?.minQty ?? null,
    targetQty: rule ? (rule.targetQty ?? rule.maxQty) : null,
    rawQty: 0,
    requestedQty: 0,
    packMultiple: rule?.packMultiple ?? null,
    sourceLocationId: null,
    lotNumber: null,
    rejectedSources: [],
  };

  if (!rule) return { kind: "skipped", reasonCode: "no_rule", trace: { ...baseTrace, reasonCode: "no_rule" } };
  if (rule.strategy === "manual") {
    return { kind: "skipped", reasonCode: "manual_only", trace: { ...baseTrace, reasonCode: "manual_only" } };
  }
  if (ctx.hasOpenOrder) {
    return { kind: "skipped", reasonCode: "open_order", trace: { ...baseTrace, reasonCode: "open_order" } };
  }

  const threshold = rule.strategy === "topoff" ? (rule.targetQty ?? rule.maxQty) : rule.minQty;
  if (projected >= threshold) {
    return { kind: "skipped", reasonCode: "above_threshold", trace: { ...baseTrace, reasonCode: "above_threshold" } };
  }

  const target = rule.targetQty ?? rule.maxQty;
  const rawQty = Math.max(0, target - projected);
  let requestedQty = roundToPack(rawQty, rule.packMultiple);

  const source = chooseSource(candidates, requestedQty);
  if (!source.chosen) {
    return {
      kind: "skipped",
      reasonCode: "no_source",
      trace: { ...baseTrace, reasonCode: "no_source", rawQty, requestedQty, rejectedSources: source.rejected },
    };
  }

  // Clamp to what the chosen source can actually give, keeping the pack grain.
  if (requestedQty > source.chosen.available) {
    const pack = rule.packMultiple > 0 ? rule.packMultiple : 1;
    requestedQty = Math.floor(source.chosen.available / pack) * pack;
    if (requestedQty <= 0) requestedQty = source.chosen.available;
  }

  if (requestedQty <= 0) {
    return {
      kind: "skipped",
      reasonCode: "no_source",
      trace: { ...baseTrace, reasonCode: "no_source", rawQty, requestedQty: 0, rejectedSources: source.rejected },
    };
  }

  const trace: DecisionTrace = {
    ...baseTrace,
    rawQty,
    requestedQty,
    sourceLocationId: source.chosen.locationId,
    lotNumber: source.chosen.lotNumber ?? null,
    rejectedSources: source.rejected,
  };

  return {
    kind: "planned",
    item: {
      pickLocationId: ctx.pickLocationId,
      productId: ctx.productId,
      ruleId: rule.id,
      requestedQty,
      sourceLocationId: source.chosen.locationId,
      lotNumber: source.chosen.lotNumber ?? null,
      priority: rule.isEmergency ? Math.min(1, rule.priority) : rule.priority,
      autoDispatch: rule.autoDispatch ?? false,
      trace,
    },
  };
}

/** Minutes until the pick face runs dry at the given hourly pick rate. */
export function minutesToStockout(projected: number, unitsPerHour: number): number | null {
  if (unitsPerHour <= 0) return null;
  return Math.max(0, (projected / unitsPerHour) * 60);
}

export type PickFaceHealthTier = "stockout" | "critical" | "low" | "healthy";

export function pickFaceHealth(minutes: number | null, projected: number): PickFaceHealthTier {
  if (projected <= 0) return "stockout";
  if (minutes == null) return "healthy";
  if (minutes < 30) return "critical";
  if (minutes < 120) return "low";
  return "healthy";
}
