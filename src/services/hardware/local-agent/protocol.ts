/**
 * Local Print Agent Protocol — Defines the HTTP API contract
 * between the browser POS client and the local print agent.
 *
 * The local agent is our "IoT Box" equivalent: a lightweight service
 * running on the same machine or LAN that bridges the browser
 * to USB/network printers via raw TCP/USB.
 *
 * Agent HTTP API:
 * GET  /status                → AgentStatusResponse
 * POST /print                 → AgentPrintRequest  → AgentPrintResponse
 * POST /test                  → AgentTestRequest   → AgentTestResponse
 * GET  /discover?subnet=auto  → AgentDiscoverResponse
 * POST /usb/print             → AgentUsbPrintRequest → AgentPrintResponse
 * GET  /usb/devices           → AgentUsbDevicesResponse
 */

// ── Agent status ──

export interface AgentDeviceInfo {
  type: 'network' | 'usb' | 'serial';
  identifier: string;
  name?: string;
  ipAddress?: string;
  port?: number;
  vendorId?: number;
  productId?: number;
}

export interface AgentStatusResponse {
  running: boolean;
  version: string;
  devices: AgentDeviceInfo[];
  uptime?: number;
}

// ── Network printing ──

export interface AgentPrintRequest {
  ipAddress: string;
  port: number;
  data: number[];
  timeout?: number;
}

export interface AgentPrintResponse {
  success: boolean;
  error?: string;
  bytesWritten?: number;
}

// ── Connection test ──

export interface AgentTestRequest {
  ipAddress: string;
  port: number;
  timeout?: number;
}

export interface AgentTestResponse {
  success: boolean;
  error?: string;
  responseTimeMs?: number;
}

// ── Device discovery ──

export interface AgentDiscoverResponse {
  devices: AgentDeviceInfo[];
}

// ── USB printing ──

export interface AgentUsbPrintRequest {
  vendorId: number;
  productId: number;
  data: number[];
}

export interface AgentUsbDevicesResponse {
  devices: Array<{
    vendorId: number;
    productId: number;
    name?: string;
    manufacturer?: string;
  }>;
}

// ── Constants ──

/** Default port for the local print agent */
export const DEFAULT_AGENT_PORT = 8043;

/** Default base URL */
export const DEFAULT_AGENT_URL = `http://localhost:${DEFAULT_AGENT_PORT}`;

// ── Track 5 — Biometric attendance (phase 1: protocol only) ──
//
// The LAN agent is the recommended transport for biometric devices
// (ZKTeco / Suprema / Hikvision). Vendor SDK adapters land in a
// follow-up loop; this section defines the wire contract so the
// server-side ingestion path (attendance_ingest_log + attendance_events
// + the saga handlers in BusinessSagaMount) can be exercised without
// SDK access. The agent posts events to the platform's
// `attendance-ingest` edge function; the platform never reaches back
// out to the device.

export type BiometricEventKind =
  | 'check_in'
  | 'check_out'
  | 'break_start'
  | 'break_end'
  | 'unknown';

export interface BiometricDeviceHeartbeat {
  deviceId: string;
  vendor: 'zkteco' | 'suprema' | 'hikvision' | 'generic';
  firmware?: string;
  branchId?: string | null;
  /** ISO-8601 timestamp from the device's clock. */
  deviceTime: string;
  /** Number of templates currently enrolled on the device. */
  enrolledTemplates?: number;
}

export interface BiometricAttendanceEvent {
  deviceId: string;
  /** Local user id on the device (vendor-specific). */
  externalEmployeeId: string;
  kind: BiometricEventKind;
  /** ISO-8601 timestamp from the device's clock. */
  occurredAt: string;
  /** Matched score 0-100; useful for audit when accept-thresholds vary. */
  matchScore?: number;
  /** Optional raw vendor payload for debugging. */
  raw?: unknown;
}

export interface BiometricEnrollRequest {
  deviceId: string;
  externalEmployeeId: string;
  /** Base64 template body. */
  template: string;
  templateFormat: 'iso19794' | 'vendor';
}

export interface BiometricAgentResponse {
  success: boolean;
  error?: string;
  /** Server-assigned attendance_events.id when ingestion succeeded. */
  eventId?: string;
}
