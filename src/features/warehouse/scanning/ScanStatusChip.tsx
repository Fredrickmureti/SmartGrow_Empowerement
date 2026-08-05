/**
 * ScanStatusChip — deprecated.
 *
 * Superseded by `ScanGuidance` (Phase 4.2): the chip reported router
 * internals ("Listening", "Held by …") where the operator needed an
 * instruction. It survives only as a thin alias so no call site silently
 * keeps the old wording; new surfaces must import `ScanGuidance`.
 *
 * @deprecated Use `ScanGuidance`.
 */
export { ScanGuidance as ScanStatusChip, default } from "./ScanGuidance";
