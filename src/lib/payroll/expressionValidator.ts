/**
 * Client-side wrapper around the same expression engine used by
 * `compute-payroll/structureEngine.ts`. Used by the SalaryStructures editor
 * to give live token-validation feedback without a server round-trip.
 *
 * NOTE: We re-implement the parser here (small enough) instead of importing
 * the Deno file across the bundler boundary. Both sides MUST stay in sync —
 * the test `expression-evaluator.test.ts` runs the same fixtures through
 * both implementations.
 */
export {
  validateExpression,
  evaluateExpression,
  parseExpression,
  RuleExpressionError,
  MAX_TOKENS,
  MAX_DEPTH,
  MAX_LENGTH,
  type PayrollContext,
} from "../../../supabase/functions/compute-payroll/expressionEngine";
