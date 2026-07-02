/**
 * Hardware Service Types
 * Common types and interfaces for all hardware services
 */

export type HardwareType = 'printer' | 'cash_drawer' | 'scale' | 'customer_display' | 'barcode_scanner';
export type ConnectionType = 'usb' | 'network' | 'serial' | 'bluetooth' | 'browser';

export interface HardwareConfig {
  id: string;
  organization_id: string;
  register_id?: string;
  hardware_type: HardwareType;
  display_name: string;
  connection_type: ConnectionType;
  connection_params: Record<string, unknown>;
  is_active: boolean;
  is_default: boolean;
}

export interface USBDeviceInfo {
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
}

export interface NetworkDeviceInfo {
  ipAddress: string;
  port: number;
}

export interface SerialDeviceInfo {
  port: string;
  baudRate: number;
}

export interface PrinterConfig extends HardwareConfig {
  hardware_type: 'printer';
  connection_params: {
    // USB
    vendorId?: number;
    productId?: number;
    // Network
    ipAddress?: string;
    port?: number;
    // Shared
    characterSet?: string;
    paperWidth?: 58 | 80; // mm
    autoCut?: boolean;
  };
}

export interface CashDrawerConfig extends HardwareConfig {
  hardware_type: 'cash_drawer';
  connection_params: {
    // Usually connected via printer
    printerConfigId?: string;
    // Or direct USB
    vendorId?: number;
    productId?: number;
    // Pulse timing
    pin?: 2 | 5;
    onTime?: number; // ms
    offTime?: number; // ms
  };
}

export interface ScaleConfig extends HardwareConfig {
  hardware_type: 'scale';
  connection_params: {
    // Serial connection
    port?: string;
    baudRate?: number;
    // Network
    ipAddress?: string;
    networkPort?: number;
    // Scale settings
    protocol?: 'toledo' | 'cas' | 'mettler' | 'generic';
    weightUnit?: 'kg' | 'lb' | 'g' | 'oz';
    maxWeight?: number;
    precision?: number;
  };
}

export interface HardwareStatus {
  connected: boolean;
  lastCheckedAt: string;
  error?: string;
}

/**
 * @deprecated Use the IDriver interface from `./drivers/DriverInterface` instead.
 * This base class is only used by legacy singleton services (PrinterService,
 * CashDrawerService, ScaleService). New device drivers must implement IDriver
 * and use the Transport layer for communication.
 * Scheduled for removal once all legacy singletons are migrated.
 */
export abstract class BaseHardwareService<T extends HardwareConfig> {
  protected config: T | null = null;
  protected status: HardwareStatus = {
    connected: false,
    lastCheckedAt: new Date().toISOString(),
  };

  abstract connect(config: T): Promise<boolean>;
  abstract disconnect(): Promise<void>;
  abstract testConnection(): Promise<boolean>;
  
  getStatus(): HardwareStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status.connected;
  }

  protected updateStatus(connected: boolean, error?: string): void {
    this.status = {
      connected,
      lastCheckedAt: new Date().toISOString(),
      error,
    };
  }
}
