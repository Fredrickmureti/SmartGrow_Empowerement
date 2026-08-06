/**
 * Dashboard layer — the shared composition language for every ERP
 * dashboard (Warehouse, Finance, Sales, HR, …).
 *
 * Pages declare bands and widgets with semantic spans; they never author
 * grid geometry, card chrome, or per-page loading/empty/error handling.
 * See docs/design-system.md § Dashboards and ADR 0103.
 */
export { DashboardCanvas } from "./DashboardCanvas";
export { DashboardBand } from "./DashboardBand";
export { DashboardWidget } from "./DashboardWidget";
export type { DashboardWidgetVariant, WidgetQuery } from "./DashboardWidget";
export { DrillLink } from "./DrillLink";
export { KpiRibbon, KpiTile } from "./KpiRibbon";
export type { KpiTileProps } from "./KpiRibbon";
export { HeroStatus } from "./HeroStatus";
export { MetricCard } from "./MetricCard";
export { GaugeCard } from "./GaugeCard";
export { HealthList } from "./HealthList";
export type { HealthListItem } from "./HealthList";
export { TimelineFeed } from "./TimelineFeed";
export type { TimelineEntry } from "./TimelineFeed";
export { PriorityPanel } from "./PriorityPanel";
export type { PriorityItem } from "./PriorityPanel";
export { useDashboard } from "./context";
export type { DashboardDensity } from "./context";
export { spanClass, SPAN_CLASS, DASHBOARD_GRID } from "./spans";
export type { DashboardSpan } from "./spans";
export {
  TONE_TEXT,
  TONE_SURFACE,
  TONE_BAR,
  utilisationTone,
} from "./tones";
export type { DashboardTone } from "./tones";
