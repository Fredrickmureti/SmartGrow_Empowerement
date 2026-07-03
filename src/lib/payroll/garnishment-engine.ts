/**
 * Garnishment computation engine — client-side re-export shim.
 *
 * Phase 2 dedup: this file is now a pure re-export of the canonical
 * algorithm defined in `supabase/functions/_shared/garnishment-engine.ts`.
 * The Deno edge function and the browser bundle share the SAME source
 * (Vite happily bundles the module because it contains no Deno-only
 * import specifiers). This closes the "duplicate garnishment engine"
 * finding without needing an architecture test to police byte-parity.
 *
 * Any change to the algorithm — cap rules, floor rules, employer-fee
 * bookkeeping — should be made in the shared file. Consumers keep
 * importing from `@/lib/payroll/garnishment-engine` unchanged.
 *
 * NOTE: the FULL production algorithm (per-period carry-forward,
 * `total_accrued` cap, run-level state) still lives inline in
 * `supabase/functions/compute-payroll/index.ts` (Turn C: garnishments).
 * Those pieces are DB-integrated and are tracked as a follow-up
 * extraction; this shim closes the shared-subset duplication first.
 */

export {
  type GarnishmentCapRule,
  type GarnishmentOrder,
  type GarnishmentPolicy,
  type KindDefault,
  type GarnishmentApplied,
  type ComputeArgs,
  type ComputeResult,
  computeGarnishments,
} from "../../../supabase/functions/_shared/garnishment-engine";
