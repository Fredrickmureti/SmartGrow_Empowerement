/**
 * Wave Control Tower — public surface.
 *
 * Pages compose from this barrel only; internals stay free to evolve.
 */
export * from "./contract";
export {
  useWaveHealth, useWaveBoard, useWaveDemand, useWaveStrategies,
  useWaveCapacity, WAVE_KEYS, WAVE_QUERY_PREFIXES,
} from "./useWaveTower";
export {
  useSaveWaveStrategy, useToggleWaveStrategy, useDeleteWaveStrategy,
  useSeedWaveStrategies, type WaveStrategyDraft,
} from "./useWaveStrategyAdmin";
export { StrategyWorkbench } from "./StrategyWorkbench";
export { WaveCapacityPanel } from "./WaveCapacityPanel";
export { WaveStageStrip } from "./WaveStageStrip";
export { WaveLifecycleBoard } from "./WaveLifecycleBoard";
export { WaveReadinessPanel } from "./WaveReadinessPanel";
export { WaveDemandTable } from "./WaveDemandTable";
export { WaveDocumentsMenu, type WaveDocumentType } from "./WaveDocumentsMenu";
