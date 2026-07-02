/**
 * Hardware Services Export
 *
 * Track H4 — only the public surface is exported. The renderer-side
 * shells (`BrowserHardwareAdapter`, `local-agent/AgentClient`,
 * `local-display/CustomerDisplayClient`) are service-internal and the
 * `no-legacy-hardware-shell` guard test enforces that hooks/components
 * never import them directly. Go through `hardwareClient` instead.
 */

export * from "./types";
export { hardwareClient, type HardwareClient, type DeviceStatusDetail, type AgentStatusSnapshot, type CustomerDisplayData, type CustomerDisplayConfig } from "./HardwareClient";
export type { DeviceAssignment } from "./BrowserHardwareAdapter";
export type { ReceiptData, ReceiptLine, ReceiptImage } from "./types/receipt";
export { hardwareEventBus, type HardwareEventType, type HardwareEvent } from "./HardwareEventBus";
export { ESCPOS, KNOWN_PRINTER_VENDORS, KNOWN_SCALE_VENDORS, KNOWN_SCANNER_VENDORS } from "./escpos-commands";
export * from "./transport";
export * from "./drivers";
export * from "./interfaces";
