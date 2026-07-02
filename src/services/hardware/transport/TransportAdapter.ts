/**
 * Transport Adapter — Abstract interface for all hardware communication transports.
 *
 * This is the single layer that decides HOW bytes reach a device.
 * Drivers produce bytes; transports deliver them.
 *
 * Concrete implementations (Track H4 — Electron path removed from renderer;
 * Electron hardware IO lives in the main-process CommandRouter now):
 * - LocalAgentTransport → HTTP to our local IoT Box agent on localhost
 * - WebUSBTransport     → WebUSB API in the browser
 *
 * A driver never chooses its transport. Instead, `resolveTransport()` picks
 * the correct one based on runtime environment + connection config.
 */

// ── Transport result ──

export interface TransportResult {
  success: boolean;
  error?: string;
  bytesWritten?: number;
}

// ── Abstract transport ──

export interface ITransport {
  /** Human-readable transport name for logging */
  readonly name: string;

  /** Send raw bytes to the device */
  send(data: number[] | Uint8Array): Promise<TransportResult>;

  /** Test connectivity without sending print data */
  test(): Promise<TransportResult>;

  /** Is this transport currently available in the runtime? */
  isAvailable(): boolean;

  /** Disconnect / release resources */
  disconnect(): Promise<void>;
}

// ── Network device target ──

export interface NetworkTarget {
  ipAddress: string;
  port: number;
}

// ── USB device target ──

export interface USBTarget {
  vendorId: number;
  productId: number;
}
