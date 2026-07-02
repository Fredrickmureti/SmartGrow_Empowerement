/**
 * Universal scanner hooks — canonical barrel.
 *
 * Same rationale as `src/services/scanner/index.ts`: the hooks live under
 * `@/hooks/pos/*` for history, but they are repo-wide infrastructure. New
 * code uses `@/hooks/scanner/*`.
 */

export { useScanTarget } from "@/hooks/pos/useScanTarget";
export { useResolveBarcode } from "@/hooks/pos/useResolveBarcode";
export type { ResolvedScan, ResolveResult } from "@/hooks/pos/useResolveBarcode";
export { useScanCapture } from "@/hooks/pos/useScanCapture";
export {
  useScannerScopePolicy,
  useScannerScopeMode,
  type ScannerScopeMode,
  type ScannerScopePolicyResult,
} from "@/hooks/scanner/useScannerScopePolicy";