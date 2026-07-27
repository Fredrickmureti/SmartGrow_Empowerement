/**
 * Driver Interface — Abstract base for all hardware device drivers.
 * Every driver implements this contract regardless of device type or protocol.
 * 
 * Inspired by Odoo's IoT driver architecture:
 * - Each physical device model has a driver
 * - Drivers are registered in a DriverRegistry by driver_type string
 * - The HardwareProxy resolves device_role → device config → driver_type → driver instance
 */

export type DeviceRole =
  | 'receipt_printer'
  | 'kitchen_printer'
  | 'cash_drawer'
  | 'barcode_scanner'
  | 'customer_display'
  | 'scale'
  | 'payment_terminal'
  | 'label_printer'
  | 'a4_printer'
  | 'scanner'
  // Track 3 — attendance/biometric clock devices in the canonical fabric.
  | 'clock_terminal'
  | 'biometric_reader'
  | 'saga';


export type DriverType =
  | 'escpos'
  | 'star'
  | 'citizen'
  | 'bixolon'
  | 'epson'
  | 'epos_printer'
  | 'zpl_label'
  | 'epl_label'
  | 'escpos_label'
  | 'generic_scale'
  | 'toledo_scale'
  | 'cas_scale'
  | 'mettler_scale'
  | 'keyboard_scanner'
  | 'hid_scanner'
  | 'escpos_drawer'
  | 'secondary_screen_display'
  | 'line_display'
  | 'worldline_terminal'
  | 'adyen_terminal'
  | 'generic_terminal'
  | 'browser_print';

export type ConnectionBackend = 'electron' | 'webusb' | 'webserial' | 'network' | 'browser' | 'local_proxy';

export interface DeviceStatus {
  connected: boolean;
  status: 'online' | 'offline' | 'unknown' | 'error' | 'configuring';
  lastSeenAt?: string;
  lastError?: string;
  firmwareVersion?: string;
  capabilities?: string[];
}

export interface DriverCommand {
  type: string;
  payload?: unknown;
}

export interface DriverResult {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Device info passed during auto-discovery matching.
 * Drivers inspect this to decide if they can handle the device.
 */
export interface DeviceInfo {
  vendorId?: number;
  productId?: number;
  deviceClass?: number;
  manufacturer?: string;
  productName?: string;
  connectionType: string;
  identifier: string;
  rawDevice?: unknown;
}

/**
 * Abstract driver interface. All hardware drivers must implement this.
 */
export interface IDriver {
  /** Unique driver type identifier */
  readonly driverType: DriverType;

  /** Which device roles this driver can fulfill */
  readonly supportedRoles: DeviceRole[];

  /** Which connection backends this driver supports */
  readonly supportedBackends: ConnectionBackend[];

  /**
   * Check if this driver can handle the given device.
   * Used during auto-discovery to match devices to drivers.
   * Higher return value = higher priority (0 = not supported).
   * Mirrors Odoo's Driver.supported(device) classmethod.
   */
  supported(deviceInfo: DeviceInfo): number;

  /** Connect to the device with given connection params */
  connect(params: Record<string, unknown>): Promise<DriverResult>;

  /** Disconnect from the device */
  disconnect(): Promise<DriverResult>;

  /** Get current device status */
  getStatus(): DeviceStatus;

  /** Execute a device-specific command */
  execute(command: DriverCommand): Promise<DriverResult>;

  /** Test the connection (heartbeat) */
  testConnection(): Promise<boolean>;
}

/**
 * Printer-specific command types
 */
export interface PrintCommand extends DriverCommand {
  type: 'print_receipt';
  payload: {
    lines: Array<{
      text: string;
      align?: 'left' | 'center' | 'right';
      bold?: boolean;
      doubleWidth?: boolean;
      doubleHeight?: boolean;
    }>;
    header?: Array<{ text: string; align?: string; bold?: boolean }>;
    footer?: Array<{ text: string; align?: string; bold?: boolean }>;
    cut?: boolean;
    openDrawer?: boolean;
  };
}

export interface OpenDrawerCommand extends DriverCommand {
  type: 'open_drawer';
  payload?: { pin?: 2 | 5 };
}

export interface ReadScaleCommand extends DriverCommand {
  type: 'read_weight';
}

export interface TareScaleCommand extends DriverCommand {
  type: 'tare';
}

export interface DisplayUpdateCommand extends DriverCommand {
  type: 'update_display';
  payload: {
    status: 'idle' | 'scanning' | 'payment' | 'complete';
    items: Array<{ name: string; quantity: number; price: number; total: number }>;
    subtotal: number;
    tax: number;
    discount: number;
    total: number;
    message?: string;
    customerName?: string;
  };
}

export interface PaymentCommand extends DriverCommand {
  type: 'initiate_payment';
  payload: {
    amount: number;
    currency: string;
    reference: string;
  };
}

export interface CancelPaymentCommand extends DriverCommand {
  type: 'cancel_payment';
}
