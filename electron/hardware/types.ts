/**
 * Main-process hardware orchestration types.
 *
 * These mirror the public types in `src/services/hardware/drivers/DriverInterface.ts`
 * but live in the Electron main bundle so the renderer never needs to import
 * `node-usb`, `serialport` or any other native module.
 */

/**
 * Single source of truth for hardware roles. The renderer mirrors this list
 * in `src/services/hardware/drivers/DriverInterface.ts`; the
 * `role-vocabulary` architecture test (Wave 9d.3) fails CI when they drift.
 *
 * Synthetic roles (no physical device):
 *   - `saga` — saga housekeeping ops (e.g. `saga:post_gl`).
 */
export const HARDWARE_ROLES = [
  'receipt_printer',
  'kitchen_printer',
  'label_printer',
  // Wave 12 B2 — A4 office printer (PDF render path). Referenced by
  // PrintClient + useHardwareProxy for non-thermal document routing.
  'a4_printer',
  'cash_drawer',
  'scale',
  'scanner',
  'barcode_scanner',
  'customer_display',
  'payment_terminal',
  // Track 3 — Attendance / biometric clock terminals are first-class
  // hardware now. `clock_terminal` covers PIN/RFID/keypad units;
  // `biometric_reader` covers fingerprint/face devices. Both ride the
  // IoT-agent transport (LAN biometric vendors don't expose WebUSB).
  'clock_terminal',
  'biometric_reader',
  'saga',
] as const;

export type DeviceRole = typeof HARDWARE_ROLES[number];


export type CommandStatus = 'pending' | 'running' | 'done' | 'failed' | 'dead';

export interface ExecCommand {
  /** Logical role this command targets (DeviceManager looks up the bound device). */
  role: DeviceRole;
  /** Driver operation, e.g. `print_receipt`, `open_drawer`, `read_weight`. */
  op: string;
  /** JSON-serialisable payload. */
  payload: unknown;
  /**
   * Idempotency key. Two enqueue calls with the same key resolve to the
   * same queue row — re-issuing a "print receipt" after a renderer crash
   * does NOT print twice.
   */
  idempotencyKey: string;
  /** Optional retry budget override (default 5). */
  maxAttempts?: number;
}

export interface ExecResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  /** Queue row id (for status polling / dead-letter inspection). */
  queueId?: number;
}

export type SagaStep = 'print_receipt' | 'open_drawer' | 'update_display' | 'post_gl';

export interface SagaOutboxRow {
  saleId: string;
  step: SagaStep;
  status: CommandStatus;
  attempts: number;
  lastError?: string;
}

export interface HardwareEvent {
  type: string;
  deviceId?: string;
  role?: DeviceRole;
  data?: unknown;
  ts: number;
}
