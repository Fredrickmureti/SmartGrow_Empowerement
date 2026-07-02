/**
 * Replenishment signal — pure derivation from on-hand, reserved, incoming,
 * and a 28-day-trailing outbound velocity. Used by the product overview
 * strip, the listing "Days of supply" column, and the dashboard tiles.
 *
 * Tiers (calibrated against typical retail / wholesale lead times):
 *   out-of-stock  → available <= 0 and inventory is tracked
 *   critical      → daysOfSupply < 7
 *   low           → daysOfSupply < 14
 *   healthy       → 14 ≤ daysOfSupply ≤ 120
 *   overstock     → daysOfSupply > 120 (and velocity > 0)
 *   no-velocity   → velocity == 0 (no inference possible)
 *   untracked     → product.track_inventory === false
 */

export type ReplenishmentTier =
  | "untracked"
  | "out-of-stock"
  | "critical"
  | "low"
  | "healthy"
  | "overstock"
  | "no-velocity";

export interface ReplenishmentInput {
  trackInventory: boolean;
  onHand: number;
  reserved: number;
  incoming: number;
  /** Outbound base-unit qty per WEEK over the trailing window. */
  velocityPerWeek: number;
}

export interface ReplenishmentSignal {
  tier: ReplenishmentTier;
  available: number;
  daysOfSupply: number | null; // null when velocity == 0
  label: string;
  tone: "default" | "success" | "warning" | "destructive";
  hint: string;
}

export function getReplenishmentSignal(input: ReplenishmentInput): ReplenishmentSignal {
  const { trackInventory, onHand, reserved, incoming, velocityPerWeek } = input;
  const available = Math.max(0, onHand) - Math.max(0, reserved);

  if (!trackInventory) {
    return {
      tier: "untracked",
      available,
      daysOfSupply: null,
      label: "Not tracked",
      tone: "default",
      hint: "Inventory tracking is off for this product.",
    };
  }

  if (available <= 0) {
    return {
      tier: "out-of-stock",
      available,
      daysOfSupply: 0,
      label: "Out of stock",
      tone: "destructive",
      hint:
        incoming > 0
          ? `Out of stock — ${incoming} incoming on open purchase orders.`
          : "Out of stock and no purchase orders open.",
    };
  }

  const perDay = velocityPerWeek / 7;
  if (perDay <= 0) {
    return {
      tier: "no-velocity",
      available,
      daysOfSupply: null,
      label: "No recent sales",
      tone: "default",
      hint:
        "No outbound movements in the last 28 days — days-of-supply cannot be projected.",
    };
  }

  const dos = available / perDay;
  if (dos < 7) {
    return {
      tier: "critical",
      available,
      daysOfSupply: dos,
      label: `Critical · ${Math.round(dos)}d cover`,
      tone: "destructive",
      hint: `At the current sales pace this stock will last about ${Math.round(dos)} days.`,
    };
  }
  if (dos < 14) {
    return {
      tier: "low",
      available,
      daysOfSupply: dos,
      label: `Low · ${Math.round(dos)}d cover`,
      tone: "warning",
      hint: `At the current sales pace this stock will last about ${Math.round(dos)} days.`,
    };
  }
  if (dos > 120) {
    return {
      tier: "overstock",
      available,
      daysOfSupply: dos,
      label: `Overstock · ${Math.round(dos)}d cover`,
      tone: "warning",
      hint: `Stock would cover ~${Math.round(dos)} days at the current sales pace — consider slowing replenishment.`,
    };
  }
  return {
    tier: "healthy",
    available,
    daysOfSupply: dos,
    label: `Healthy · ${Math.round(dos)}d cover`,
    tone: "success",
    hint: `Stock would cover ~${Math.round(dos)} days at the current sales pace.`,
  };
}
